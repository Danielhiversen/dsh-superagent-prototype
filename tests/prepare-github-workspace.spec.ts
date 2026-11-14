import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { gitEnv } from './fixtures/git.ts'

let root: string, upstream: string, author: string, workspace: string
const env = gitEnv({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_TERMINAL_PROMPT: '0' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const prepare = (extra: Record<string, string> = {}) => spawnSync('sh',
  [join(import.meta.dirname, '../scripts/prepare-github-workspace.sh'), upstream],
  { env: { ...env, DSH_SUPERAGENT_DIR: workspace, DSH_SUPERAGENT_NAME: 'test-ticket', ...extra }, encoding: 'utf8' })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prepare workspace '))
  upstream = join(root, 'origin.git'); author = join(root, 'author'); workspace = join(root, 'worker')
  git(root, 'init', '--bare', '--initial-branch=main', upstream)
  git(root, 'clone', upstream, author)
  writeFileSync(join(author, 'base.txt'), 'base\n')
  git(author, 'add', '.'); git(author, 'commit', '-m', 'base'); git(author, 'push', 'origin', 'main')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Run real Git, then change the remote after clone to exercise the pull boundary.
function afterClone(action: string) {
  const bin = join(root, 'bin'); mkdirSync(bin)
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n"$REAL_GIT" "$@" || exit $?\nif [ "$1" = clone ]; then\n${action}\nfi\n`, { mode: 0o755 })
  return { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, TEST_ORIGIN: upstream, TEST_AUTHOR: author }
}

it('pulls commits published after cloning before it creates the branch', () => {
  writeFileSync(join(author, 'new.txt'), 'published during preparation\n')
  git(author, 'add', '.'); git(author, 'commit', '-m', 'new main')
  const result = prepare(afterClone('"$REAL_GIT" -C "$TEST_AUTHOR" push origin main'))
  expect(result.status, result.stderr).toBe(0)
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(author, 'rev-parse', 'main'))
})

it('does not launch with stale code when the pull fails after a successful clone', () => {
  const result = prepare(afterClone('mv "$TEST_ORIGIN" "$TEST_ORIGIN.offline"'))
  expect(result.status).not.toBe(0)
  expect(existsSync(workspace)).toBe(false)
})

it('starts each new branch at the latest remote main, including commits added after a prior launch', () => {
  expect(prepare().status).toBe(0)
  writeFileSync(join(author, 'latest.txt'), 'latest main\n')
  git(author, 'add', '.'); git(author, 'commit', '-m', 'advance main'); git(author, 'push', 'origin', 'main')
  workspace = join(root, 'second worker')
  expect(prepare().status).toBe(0)
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(author, 'rev-parse', 'main'))
  expect(git(workspace, 'branch', '--show-current')).toBe('dhh/test-ticket')
  expect(readFileSync(join(workspace, 'latest.txt'), 'utf8')).toBe('latest main\n')
})

it('fails closed when main cannot be fetched without leaving a prepared directory', () => {
  git(upstream, 'update-ref', '-d', 'refs/heads/main')
  expect(prepare().status).not.toBe(0)
  expect(existsSync(workspace)).toBe(false)
})

it('preserves an existing workspace and its uncommitted work', () => {
  expect(prepare().status).toBe(0)
  writeFileSync(join(workspace, 'base.txt'), 'unfinished work\n')
  expect(prepare().status).not.toBe(0)
  expect(readFileSync(join(workspace, 'base.txt'), 'utf8')).toBe('unfinished work\n')
})

it('checks out the requested PR head when continuing an existing pull request', () => {
  git(author, 'checkout', '-b', 'existing-pr')
  writeFileSync(join(author, 'pr.txt'), 'review this\n')
  git(author, 'add', '.'); git(author, 'commit', '-m', 'PR work')
  git(author, 'push', 'origin', 'HEAD:refs/pull/15/head')
  expect(prepare({ DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/15/head' }).status).toBe(0)
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(author, 'rev-parse', 'HEAD'))
})
