/** Deferred GitHub review resolution for a verified commit. */
import { key, liveTicket } from '../core/index.ts'
import { pullChecks, REQUIRED_CIRCLECI, type CiSnapshot } from '../sources/github-read.ts'
import { pullClaimError, readPull, readReviewThreads, resolveReviewThread } from '../sources/github-pull.ts'
import { sendGithub } from '../sources/github-channel.ts'
import { githubAddress, githubChannel } from '../sources/github-trigger.ts'
import type { SourceContext } from '../sources/host.ts'

export interface CommitReviewCi {
  ticketId: string
  pr: number
  head: string
}

export const commitReviewCiKey = (ticketId: string): string => key('commit-review-ci', ticketId)

export interface ReviewResolution {
  ticketId: string
  pr: number
  head: string
  /** The executor validated evidence for each of these threads before queueing the effect. */
  threads: string[]
  requiredChecks: string[]
  evidence?: Record<string, string>
}

export const reviewResolutionKey = (ticketId: string, pr: number): string => key('review-resolution', ticketId, String(pr))

/** Require a real result, and wait for a named check even when other checks have already finished. */
export function reviewChecksPassed(snapshot: CiSnapshot, required: readonly string[]): boolean {
  const results = [
    ...snapshot.checks.map(item => ({ name: item.name, result: item.status === 'completed' ? item.conclusion : null })),
    ...snapshot.statuses.map(item => ({ name: item.context, result: item.state })),
  ]
  return results.length > 0 && results.every(check => ['success', 'neutral', 'skipped'].includes(check.result ?? ''))
    && required.every(name => results.some(check => check.name === name && check.result === 'success'))
}

export function reviewedCircleCiPassed(snapshot: CiSnapshot): boolean {
  return snapshot.circleci === 'success' && reviewChecksPassed(snapshot, [REQUIRED_CIRCLECI])
}

export async function replyToVerifiedReview(ctx: SourceContext, pr: number, head: string,
  thread: { id: string; url: string }, evidence: string, signal: AbortSignal): Promise<void> {
  const repository = ctx.deployment.repository
  const address = githubAddress(thread.url, repository)
  if (!address?.discussion || address.number !== pr) throw new Error('GitHub did not return an inline address for the verified review thread')
  const result = await sendGithub({ commands: ctx.commands.withSignal(signal) }, {
    id: key('verified-review-reply', repository, String(pr), head, thread.id),
    channel: githubChannel(pr, thread.url), kind: 'reply',
    text: `Verified on commit \`${head}\`. CI passed.

${evidence}`,
  })
  if (result !== 'sent') throw new Error('The verified review reply could not be posted')
}

export async function resolveAfterChecks(ctx: SourceContext, request: ReviewResolution, signal: AbortSignal)
  : Promise<'waiting' | 'obsolete' | 'resolved'> {
  const { ticketId, pr, head, threads, requiredChecks } = request
  const stillCurrent = async () => {
    const ticket = ctx.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return false
    const pull = await readPull(ctx, pr, signal)
    return pull.state === 'open' && pull.head.sha === head && !pullClaimError(ctx, ticketId, pull)
  }
  if (!await stillCurrent()) return 'obsolete'
  if (!reviewChecksPassed(await pullChecks(ctx.commands.withSignal(signal), head), requiredChecks)) return 'waiting'
  const checklist = new Map((await readReviewThreads(ctx, pr, signal)).map(thread => [thread.id, thread]))
  for (const id of threads) {
    const thread = checklist.get(id)
    if (!thread || thread.resolved) continue
    if (!await stillCurrent()) return 'obsolete'
    const evidence = request.evidence?.[id]
    if (evidence) {
      await replyToVerifiedReview(ctx, pr, head, thread, evidence, signal)
      if (!await stillCurrent()) return 'obsolete'
    }
    await resolveReviewThread(ctx, id, signal)
  }
  return 'resolved'
}
