import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { agentVariables, writeEnvironment } from '../src/infra/environment.ts'
import { enableCommitReview, reviewHooks, reviewStaged, reviewedCommit } from '../src/infra/commit-review.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)

it('blocks a managed commit before independent review, including --no-verify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'precommit-'))
  try {
    const cwd = join(root, 'repo')
    const stateDir = join(root, 'state')
    await mkdir(cwd)
    await writeEnvironment(testDeployment({ stateDir }), [])
    const env = { ...process.env, ...agentVariables(stateDir) }
    const git = (...args: string[]) => exec('git', args, { cwd, env }).then(result => result.stdout.trim())
    await git('init', '-q')
    await git('config', 'core.hooksPath', reviewHooks(stateDir))
    await git('config', 'user.name', 'Worker')
    await git('config', 'user.email', 'worker@example.com')
    await enableCommitReview(cwd, reviewHooks(stateDir))
    await writeFile(join(cwd, 'change.txt'), 'first staged change\n')
    await git('add', '--', 'change.txt')
    await expect(git('commit', '--no-verify', '-m', 'unreviewed')).rejects.toMatchObject({
      stderr: expect.stringContaining('orchestrator_review_staged'),
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('commits only approved snapshots and blocks unreviewed commits at push', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'reviewed-git-'))
  try {
    const repo = join(cwd, 'repo')
    const remote = join(cwd, 'remote.git')
    await mkdir(repo)
    const stateDir = join(cwd, 'state')
    await writeEnvironment(testDeployment({ stateDir }), [])
    const env = { ...process.env, ...agentVariables(stateDir) }
    const git = (...args: string[]) => exec('git', args, { cwd: repo, env }).then(result => result.stdout.trim())
    await git('init', '-q')
    await git('init', '-q', '--bare', remote)
    await git('remote', 'add', 'origin', remote)
    await git('config', 'core.hooksPath', reviewHooks(stateDir))
    await git('config', 'user.name', 'Worker')
    await git('config', 'user.email', 'worker@example.com')
    await enableCommitReview(repo, reviewHooks(stateDir))
    const file = join(repo, 'change.txt')
    const stage = async (content: string) => {
      await writeFile(file, content + '\n')
      await git('add', '--', 'change.txt')
    }
    const signal = new AbortController().signal
    await stage('first staged change')
    expect(await reviewStaged(repo, async () => ({ decision: 'changes_requested', summary: 'Please revise' }), signal))
      .toMatchObject({ decision: 'changes_requested' })
    await expect(git('commit', '-m', 'rejected')).rejects.toThrow('orchestrator_review_staged')
    await stage('approval candidate')
    expect(await reviewStaged(repo, async snapshot => {
      expect(snapshot.patch).toContain('+approval candidate')
      expect(Object.values(snapshot.fileContext)).toContain('approval candidate\n')
      await stage('concurrent replacement')
      return { decision: 'approved', summary: 'Approved first snapshot' }
    }, signal)).toMatchObject({ decision: 'stale' })
    await expect(git('commit', '-m', 'changed while under review')).rejects.toThrow('orchestrator_review_staged')
    await reviewStaged(repo, async () => ({ decision: 'approved', summary: 'Revised snapshot approved' }), signal)
    await reviewStaged(repo, async () => ({ decision: 'changes_requested', summary: 'Withdraw prior approval' }), signal)
    await expect(git('commit', '-m', 'rejected again')).rejects.toThrow('orchestrator_review_staged')
    await reviewStaged(repo, async () => ({ decision: 'approved', summary: 'Approved after recheck' }), signal)
    await writeFile(file, 'unstaged change\n')
    await expect(git('commit', '-am', 'auto stage unreviewed content')).rejects.toThrow('orchestrator_review_staged')
    await git('commit', '-m', 'Reviewed')
    const approved = await git('rev-parse', 'HEAD')
    expect(await reviewedCommit(repo, approved, signal)).toBe(true)
    await git('push', 'origin', 'HEAD:refs/heads/feature')
    await expect(git('push', 'origin', 'HEAD:refs/heads/main')).rejects.toThrow('through a pull request')
    const rewritten = await git('commit-tree', 'HEAD^{tree}', '-m', 'Same code, updated commit message')
    expect(rewritten).not.toBe(approved)
    expect(await reviewedCommit(repo, rewritten, signal)).toBe(true)
    await git('push', 'origin', rewritten + ':refs/heads/metadata-only')
    await stage('next unreviewed change')
    await reviewStaged(repo, async snapshot => {
      expect(snapshot.headPatch).toContain('+concurrent replacement')
      expect(snapshot.patch).toContain('+next unreviewed change')
      return { decision: 'changes_requested', summary: 'Reject staged update' }
    }, signal)
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Bypassed local hook')
    expect(await reviewedCommit(repo, await git('rev-parse', 'HEAD'), signal)).toBe(false)
    await expect(git('push', 'origin', 'HEAD:refs/heads/feature')).rejects.toThrow('orchestrator_review_staged')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

it.each(['rate-limited', 'inconclusive'])('uses the configured fallback when the independent reviewer is %s', async (mode) => {
  const { reviewWithModel } = await import('../src/app/commit-review.ts')
  const { SettingsSchema } = await import('../src/policy.ts')
  const routes: string[] = []
  const reviewInputs: string[] = []
  const settings = SettingsSchema.parse({ executor: { fallbackModel: { provider: 'free', model: 'fallback' } } })
  const context = {
    sessionController: { modelCatalog: async () => ({ default: { provider: 'primary', model: 'rate-limited' } }) },
    llm: { prepareCall: async ({ model }: { model: string }) => {
      routes.push(model)
      if (model === 'rate-limited' && mode === 'rate-limited') throw new Error('HTTP 429')
      return { config: {}, async *stream(input: { messages: { content: { text: string }[] }[] }) {
        reviewInputs.push(input.messages[0]!.content[0]!.text)
        const decision = model === 'fallback' ? 'approved' : 'inconclusive'
        yield { type: 'text-delta', text: JSON.stringify({ decision, summary: 'Verified the diff.' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    } },
  } as unknown as Parameters<typeof reviewWithModel>[0]
  const ticket: Parameters<typeof reviewWithModel>[2] = {
    id: 'ticket', title: 'Review feedback', decisionId: 'decision', channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: '', updatedAt: '', origin: { triggerId: 'review', triggerIds: ['review'] },
    mandate: { scope: 'Fix review', strength: 'explicit', policyVersion: 'test', basis: { via: 'listed' },
      actor: { source: 'github', id: 'reviewer' } },
  }
  const result = await reviewWithModel(context, settings, ticket, { parent: 'root', tree: 'a', patch: 'staged patch', headPatch: 'parent patch', fileContext: { 'source.ts': 'staged source' } },
    AbortSignal.timeout(1000), () => undefined)
  expect(result.decision).toBe('approved')
  expect(routes).toEqual(['rate-limited', 'fallback'])
  for (const input of reviewInputs) {
    expect(JSON.parse(input)).toMatchObject({ patch: 'staged patch', fileContext: { 'source.ts': 'staged source' } })
    expect(JSON.parse(input)).not.toHaveProperty('headPatch')
  }
})

it('requires a separate approval for a two-parent integration commit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'reviewed-merge-'))
  try {
    const repo = join(cwd, 'repo')
    const remote = join(cwd, 'remote.git')
    await mkdir(repo)
    const stateDir = join(cwd, 'state')
    await writeEnvironment(testDeployment({ stateDir }), [])
    const env = { ...process.env, ...agentVariables(stateDir) }
    const git = (...args: string[]) => exec('git', args, { cwd: repo, env }).then(result => result.stdout.trim())
    await git('init', '-q', '-b', 'main')
    await git('init', '-q', '--bare', remote)
    await git('remote', 'add', 'origin', remote)
    await git('config', 'user.name', 'Worker')
    await git('config', 'user.email', 'worker@example.com')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', 'existing-pr')
    await writeFile(join(repo, 'upstream.txt'), 'current upstream\n')
    await git('add', 'upstream.txt')
    await git('commit', '-m', 'Advance main')
    await git('push', 'origin', 'main')
    await git('switch', 'existing-pr')
    await git('config', 'core.hooksPath', reviewHooks(stateDir))
    await enableCommitReview(repo, reviewHooks(stateDir))
    await git('merge', '--no-ff', '--no-commit', 'main')
    const signal = new AbortController().signal
    await expect(git('commit', '-m', 'Unreviewed merge')).rejects.toThrow('orchestrator_review_staged')
    const approved = await reviewStaged(repo, async snapshot => {
      expect(snapshot.patch).toContain('+current upstream')
      return { decision: 'approved', summary: 'Reviewed integration tree' }
    }, signal)
    expect(approved.decision).toBe('approved')
    await git('commit', '-m', 'Reviewed integration')
    expect(await reviewedCommit(repo, await git('rev-parse', 'HEAD'), signal)).toBe(true)
    await git('push', 'origin', 'HEAD:refs/heads/existing-pr')
    const wrongParent = await git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD^1', '-p', 'HEAD', '-m', 'Unreviewed parent set')
    expect(await reviewedCommit(repo, wrongParent, signal)).toBe(false)
    await expect(git('push', 'origin', wrongParent + ':refs/heads/existing-pr')).rejects.toThrow('orchestrator_review_staged')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

it('pushes a reviewed fast-forward over previously published commits', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'reviewed-fast-forward-'))
  try {
    const repo = join(cwd, 'repo')
    const remote = join(cwd, 'remote.git')
    const stateDir = join(cwd, 'state')
    await mkdir(repo)
    await writeEnvironment(testDeployment({ stateDir }), [])
    const env = { ...process.env, ...agentVariables(stateDir) }
    const git = (...args: string[]) => exec('git', args, { cwd: repo, env }).then(result => result.stdout.trim())
    await git('init', '-q', '-b', 'main')
    await git('init', '-q', '--bare', remote)
    await git('remote', 'add', 'origin', remote)
    await git('config', 'user.name', 'Worker')
    await git('config', 'user.email', 'worker@example.com')
    await git('commit', '--allow-empty', '-m', 'main')
    await git('push', 'origin', 'main')
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    await git('config', 'core.hooksPath', reviewHooks(stateDir))
    const main = await git('rev-parse', 'HEAD')
    await enableCommitReview(repo, reviewHooks(stateDir))

    const published = await git('commit-tree', 'HEAD^{tree}', '-p', main, '-m', 'Already published PR commit')
    await exec('git', ['--git-dir', remote, 'fetch', repo, published + ':refs/heads/feature'])
    await git('reset', '--hard', published)
    await writeFile(join(repo, 'fix.txt'), 'reviewed fix\n')
    await git('add', 'fix.txt')
    const signal = new AbortController().signal
    await reviewStaged(repo, async () => ({ decision: 'approved', summary: 'Approved fix' }), signal)
    await git('commit', '-m', 'Review follow-up')
    const head = await git('rev-parse', 'HEAD')
    expect(await reviewedCommit(repo, head, signal, published)).toBe(true)
    expect(await reviewedCommit(repo, head, signal)).toBe(false)
    await git('push', 'origin', 'HEAD:refs/heads/feature')
    await expect(git('push', '--force', 'origin', main + ':refs/heads/feature')).rejects.toThrow('fast-forward')

    const unreviewed = await git('commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'Unreviewed follow-up')
    await expect(git('push', 'origin', unreviewed + ':refs/heads/feature')).rejects.toThrow('orchestrator_review_staged')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
