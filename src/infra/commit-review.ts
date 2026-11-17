/** Review approvals lock the exact base and staged Git trees in a managed workspace. */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const MAX_SNAPSHOT_BYTES = 180_000
const gitRaw = async (directory: string, args: string[], signal?: AbortSignal): Promise<string> =>
  (await exec('git', ['--no-replace-objects', ...args], { cwd: directory, signal,
    timeout: 20_000, maxBuffer: MAX_SNAPSHOT_BYTES, encoding: 'utf8' })).stdout
const git = async (directory: string, args: string[], signal?: AbortSignal): Promise<string> =>
  (await gitRaw(directory, args, signal)).trimEnd()
const gitOptional = async (directory: string, args: string[], signal?: AbortSignal) =>
  git(directory, args, signal).catch((error: unknown) => {
    if ([1, 128].includes((error as { code: number }).code)) return ''
    throw error
  })

export const reviewHooks = (stateDir: string) => join(stateDir, 'review-hooks')
export const reviewSocket = (stateDir: string) => join(reviewHooks(stateDir), 'ipc', 'review.sock')

const reviewDirectory = async (directory: string, signal?: AbortSignal) =>
  join(await git(directory, ['rev-parse', '--absolute-git-dir'], signal), 'superagent-review')

async function baselineAt(directory: string, signal?: AbortSignal): Promise<string | undefined> {
  return readFile(join(await reviewDirectory(directory, signal), 'baseline'), 'utf8').then(value => value.trim())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
}

async function upstreamDefault(directory: string, signal?: AbortSignal): Promise<string> {
  const remote = await gitOptional(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD'], signal)
  return gitOptional(directory, ['rev-parse', '--verify', remote || 'refs/remotes/origin/main'], signal)
}

export async function enableCommitReview(directory: string, hooksPath: string, signal?: AbortSignal): Promise<void> {
  if (!await workspaceOwnsGit(directory, signal)) return
  if (await gitOptional(directory, ['config', '--get', 'core.hooksPath'], signal) !== hooksPath) {
    throw new Error('Managed Git workspace must use the super agent review hooks')
  }
  if (await baselineAt(directory, signal)) return
  const parent = await gitOptional(directory, ['rev-parse', '--verify', 'HEAD'], signal)
  const fetched = await gitOptional(directory, ['rev-parse', '--verify', 'FETCH_HEAD'], signal)
  const remoteHasParent = parent && await git(directory, ['branch', '--remotes', '--contains', parent], signal)
  const upstream = await upstreamDefault(directory, signal)
  // Existing unpublished work must still be reviewed after restart.
  const base = parent && ((parent === fetched || remoteHasParent) ? parent
    : upstream && await gitOptional(directory, ['merge-base', parent, upstream], signal))
  const receipts = await reviewDirectory(directory, signal)
  await mkdir(receipts, { recursive: true, mode: 0o700 })
  await writeFile(join(receipts, 'baseline'), (base || 'root') + '\n', { mode: 0o600, flag: 'wx' })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
}

export async function workspaceOwnsGit(directory: string, signal?: AbortSignal): Promise<boolean> {
  if (!directory) return false
  const path = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return !!path && await gitOptional(directory, ['rev-parse', '--show-toplevel'], signal) === path
}

export async function hasCommitReview(directory: string, signal?: AbortSignal): Promise<boolean> {
  return await workspaceOwnsGit(directory, signal) && !!await baselineAt(directory, signal)
}

export interface ReviewVerdict {
  decision: 'approved' | 'changes_requested'
  summary: string
}
export type ReviewSnapshot = { parent: string; mergeParent?: string; automaticMergeTree?: string; tree: string; patch: string; headPatch?: string; fileContext: Record<string, string> }

function receipt(parent: string, tree: string, mergeParent?: string): string {
  if ((parent !== 'root' && !objectId.test(parent)) || !objectId.test(tree)) {
    throw new Error('Invalid Git snapshot identity')
  }
  if (mergeParent !== undefined && !objectId.test(mergeParent)) throw new Error('Invalid merge parent')
  return (mergeParent ? 'merge-' + parent + '-' + mergeParent : parent) + '-' + tree + '.json'
}

async function stagedIdentity(directory: string, signal?: AbortSignal) {
  const mergeHead = await git(directory, ['rev-parse', '--git-path', 'MERGE_HEAD'], signal)
  const mergeParent = await readFile(resolve(directory, mergeHead), 'utf8')
    .then(value => value.trim(), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  if (mergeParent && !objectId.test(mergeParent)) throw new Error('Review supports two-parent merges only.')
  const parent = await gitOptional(directory, ['rev-parse', '--verify', 'HEAD'], signal) || 'root'
  const parentTree = parent === 'root' ? 'root' : await git(directory, ['show', '-s', '--format=%T', parent], signal)
  const tree = await git(directory, ['write-tree'], signal)
  return { parent, parentTree, tree, ...mergeParent ? { mergeParent } : {} }
}

export async function reviewStaged(
  directory: string, reviewer: (input: ReviewSnapshot, signal: AbortSignal) => Promise<ReviewVerdict>, signal: AbortSignal,
  expected?: { parent: string; mergeParent?: string | undefined; tree: string },
) {
  if (!await hasCommitReview(directory, signal)) throw new Error('This ticket has no managed Git workspace')
  const before = await stagedIdentity(directory, signal)
  if (expected && (before.parent !== expected.parent || before.mergeParent !== expected.mergeParent || before.tree !== expected.tree)) {
    return { decision: 'stale', summary: 'The commit differs from the staged index. Stage the intended changes, then retry git commit.' }
  }
  // Git's merge tree includes conflict markers so the diff shows each staged resolution.
  let mergeConflict = false
  const automaticMergeTree = before.mergeParent
    ? (await gitRaw(directory, ['merge-tree', '--write-tree', before.parent, before.mergeParent], signal)
      .catch((error: unknown) => {
        const failure = error as { code?: number; stdout?: string }
        if (failure.code === 1 && typeof failure.stdout === 'string') {
          mergeConflict = true
          return failure.stdout
        }
        throw error
      })).split('\n', 1)[0]!
    : ''
  const base = objectId.test(automaticMergeTree) ? automaticMergeTree : before.parent === 'root'
    ? await git(directory, ['hash-object', '-w', '-t', 'tree', '/dev/null'], signal) : before.parent
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none']
  await git(directory, [...diff, '--check', base, before.tree, '--'], signal)
  const patch = await git(directory, [...diff, '--binary', '--full-index', '--unified=12', base, before.tree, '--'], signal)
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new Error('The full staged diff exceeds the review limit. Split it into smaller commits and review each one.')
      }
      throw error
    })
  if (!patch && !before.mergeParent) throw new Error('Stage a nonempty change before requesting review')
  const paths = (await git(directory, [...diff, '--name-only', '-z', base, before.tree, '--'], signal)).split('\0')
  const entries = await Promise.all(paths.filter(Boolean).slice(0, 8).map(async path => {
    const blob = before.tree + ':' + path
    const size = await gitOptional(directory, ['cat-file', '-s', blob], signal)
    if (!size || Number(size) > 64_000) return undefined
    const contents = await gitRaw(directory, ['cat-file', 'blob', blob], signal)
    if (!contents || contents.includes('\0')) return undefined
    const context = contents.length <= (mergeConflict ? 32000 : 6400) ? contents
      : contents.slice(0, 2400) + '\n[Middle of staged file omitted]\n' + contents.slice(-4000)
    return [path, context] as const
  }))
  const fileContext = Object.fromEntries(entries.filter(entry => entry !== undefined))
  const headPatch = before.parent === 'root' ? '' : await gitOptional(directory,
    ['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', before.parent, '--'], signal)
  // Keep the complete conflict-resolution diff, with its baseline explicitly identified.
  const verdict = await reviewer({ parent: before.parent, ...before.mergeParent ? { mergeParent: before.mergeParent } : {},
    ...automaticMergeTree ? { automaticMergeTree } : {}, tree: before.tree, patch, ...headPatch ? { headPatch: headPatch.slice(0, 24_000) } : {}, fileContext }, signal)
  signal.throwIfAborted()
  const after = await stagedIdentity(directory, signal)
  if (before.tree !== after.tree || before.parent !== after.parent || before.mergeParent !== after.mergeParent) {
    return { decision: 'stale', summary: 'The staged tree or its parent changed during review. Review the current staged snapshot.' }
  }
  const destination = join(await reviewDirectory(directory, signal), receipt(before.mergeParent ? before.parent : before.parentTree, before.tree, before.mergeParent))
  if (verdict.decision === 'approved') {
    const temporary = destination + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ ...before, ...verdict, reviewedAt: new Date().toISOString() }), { mode: 0o600 })
    await rename(temporary, destination)
  } else await unlink(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  return { ...verdict, ...before }
}

export async function reviewedCommit(directory: string, sha: string, signal?: AbortSignal, publishedBase?: string): Promise<boolean> {
  if (!objectId.test(sha) || !await workspaceOwnsGit(directory, signal)) return false
  const baseline = await baselineAt(directory, signal)
  if (!baseline) return false
  if (sha === baseline) return true
  if (publishedBase && (!objectId.test(publishedBase) || publishedBase === sha ||
    !await gitOptional(directory, ['merge-base', publishedBase, sha], signal).then(base => base === publishedBase))) return false
  const receipts = await reviewDirectory(directory, signal)
  const upstream = await upstreamDefault(directory, signal)
  const excluded = [baseline, upstream, publishedBase ?? ''].filter(id => objectId.test(id)).map(id => '^' + id)
  const rows = await gitOptional(directory, ['rev-list', '--parents', sha, ...excluded], signal)
  if (!rows || !rows.split('\n').some(row => row.startsWith(sha))) return false
  for (const row of rows.split('\n')) {
    const [commit, parent = 'root', ...otherParents] = row.split(' ')
    if (!commit || otherParents.length > 1) return false
    const tree = await git(directory, ['show', '-s', '--format=%T', commit], signal)
    const parentTree = parent === 'root' ? 'root' : await git(directory, ['show', '-s', '--format=%T', parent], signal)
    if (!await access(join(receipts, receipt(otherParents.length ? parent : parentTree, tree, otherParents[0]))).then(() => true, () => false)) return false
  }
  return true
}

const hookSetup = [
  'set -eu',
  'review_dir=$(git rev-parse --absolute-git-dir)/superagent-review',
  'test -f "$review_dir/baseline" || exit 0',
  'deny() { echo "Super agent review required. Stage your intended changes and call orchestrator_review_staged before committing." >&2; exit 1; }',
  'export GIT_NO_REPLACE_OBJECTS=1',
]

export const reviewCommitHook = (review: string) => [
  ...hookSetup,
  'if test "${2:-}" = commit; then echo "Use a new reviewed commit instead of rewriting an existing commit." >&2; exit 1; fi',
  'head=$(git rev-parse --verify HEAD 2>/dev/null || echo root)',
  'parent=$(git rev-parse --verify "HEAD^{tree}" 2>/dev/null || echo root)',
  'tree=$(git write-tree)',
  'merge_parent=',
  'merge_head=$(git rev-parse --git-path MERGE_HEAD)',
  'if test -f "$merge_head"; then',
  '  merge_parent=$(cat "$merge_head")',
  '  case "$merge_parent" in ""|*[!0-9a-f]*) deny ;; esac',
  '  parent="merge-$head-$merge_parent"',
  'fi',
  'if test ! -f "$review_dir/$parent-$tree.json"; then',
  '  ' + review + ' "$(git rev-parse --show-toplevel)" "$head" "$tree" "$merge_parent"',
  'fi',
  'test -f "$review_dir/$parent-$tree.json" || deny',
].join('\n')

export const reviewPushHook = [
  ...hookSetup,
  'base=$(cat "$review_dir/baseline")',
  'default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main)',
  'upstream=$(git rev-parse --verify "$default_branch" 2>/dev/null || :)',
  'main=',
  'case "$2" in https://github.com/*|git@github.com:*|ssh://git@github.com/*)',
  '  git fetch --no-tags origin refs/heads/main </dev/null',
  '  main=$(git rev-parse FETCH_HEAD)',
  '  upstream=$main',
  '  ;;',
  'esac',
  'while read -r local_ref oid remote_ref remote_oid; do',
  '  if test "$remote_ref" = "refs/heads/${default_branch#refs/remotes/origin/}"; then',
  '    echo "Super agent workers submit changes through a pull request." >&2; exit 1;',
  '  fi',
  '  case "$remote_ref" in refs/heads/*) ;; *) echo "Managed workspaces push reviewed branches only." >&2; exit 1 ;; esac',
  '  case "$oid" in *[!0]*) ;; *) echo "Managed workspaces cannot delete remote branches." >&2; exit 1 ;; esac',
  '  if test -n "$main" && ! git merge-base --is-ancestor "$main" "$oid"; then',
  '    echo "Push stopped because the proposed commit is behind GitHub main. Fetch, rebase onto current main, verify, and retry." >&2; exit 1',
  '  fi',
  '  # Check only new commits on an existing remote branch, and require that update to fast-forward.',
  '  set -- "$oid"',
  '  if test "$base" != root; then set -- "$@" "^$base"; fi',
  '  if test -n "$upstream"; then set -- "$@" "^$upstream"; fi',
  '  case "$remote_oid" in',
  '    *[!0]*)',
  '      git merge-base --is-ancestor "$remote_oid" "$oid" || { echo "Fetch the published branch and fast-forward it." >&2; exit 1; }',
  '      set -- "$@" "^$remote_oid"',
  '      ;;',
  '  esac',
  '  commits=$(git rev-list --parents "$@")',
  '  for commit in $(printf "%s\\n" "$commits" | cut -d" " -f1); do',
  '    parents=$(git show -s --format=%P "$commit")',
  '    tree=$(git show -s --format=%T "$commit")',
  '    set -- $parents',
  '    case "$#" in',
  '      0) parent_tree=root ;;',
  '      1) parent_tree=$(git show -s --format=%T "$1") ;;',
  '      2) parent_tree="merge-$1-$2" ;;',
  '      *) deny ;;',
  '    esac',
  '    test -f "$review_dir/$parent_tree-$tree.json" || deny',
  '  done',
  'done',
].join('\n')

export const reviewSocketClient = String.raw`
const { createConnection } = require('node:net')
const [path, directory, parent, tree, mergeParent] = process.argv.slice(1)
const client = createConnection(path)
let response = ''
let done = false
client.setEncoding('utf8')
const finish = (error) => {
  if (done) return
  done = true
  if (error) { process.stderr.write(error + '\n'); process.exitCode = 1 }
  client.destroy()
}
client.setTimeout(195000, () => finish('Automatic staged review timed out. Retry git commit or call orchestrator_review_staged.'))
client.on('error', () => finish('Automatic staged review unavailable. Retry git commit or call orchestrator_review_staged.'))
client.on('connect', () => client.end(JSON.stringify({ directory, parent, tree, ...(mergeParent ? { mergeParent } : {}) })))
client.on('data', data => { response += data; if (response.length > 8192) finish('Invalid staged review response.') })
client.on('end', () => {
  try {
    const { decision, summary } = JSON.parse(response)
    if (decision === 'approved') finish()
    else finish('Staged review blocked the commit: ' + summary)
  } catch { finish('Invalid staged review response.') }
})
`
