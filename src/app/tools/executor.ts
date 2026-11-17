/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { agentPull, claimPull, pullClaimError, pullsOf, readPull, readReviewThreads, resolveReviewThread, type Pull } from '../../sources/github-pull.ts'
import { reviewHooks, reviewStaged, reviewedCommit, workspaceOwnsGit } from '../../infra/commit-review.ts'
import { agentVariables, runAsWorker, verifyDirectory } from '../../infra/environment.ts'
import { reviewWithModel } from '../commit-review.ts'
import type { Context } from '@deepseek-ai/cordis'
import { ciFailures, pullChecks, REQUIRED_CIRCLECI } from '../../sources/github-read.ts'
import { commitReviewCiKey, reviewedCircleCiPassed, replyToVerifiedReview, reviewChecksPassed, reviewResolutionKey } from '../review-resolution.ts'
import type { Effects } from '../effects.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

const ReviewEvidenceSchema = z.record(z.string(), z.string().trim().min(1).max(640))

export interface ExecutorToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForExecutor, 'report' | 'validateReport' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'settings' | 'triggers'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  readonly effects: Pick<Effects, 'enqueue' | 'queued'>
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const pullNumbers = (current: Ticket) => {
    const numbers = new Set(pullsOf(current, true))
    const origin = host.github.triggers.get(current.origin.triggerId)
    if (origin?.source === 'github' && origin.meta.isPr === true && typeof origin.meta.number === 'number') {
      numbers.add(origin.meta.number)
    }
    return numbers
  }
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_review_staged',
      description: 'Review staged changes. Fix findings and repeat until approved.',
      schema: z.object({}).strict(),
      execute: async (_args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current) || !current.execution?.directory) {
          throw new Error('Ticket has no open managed Git workspace')
        }
        return reviewStaged(current.execution.directory,
          (snapshot, deadline) => reviewWithModel(host.context, host.store.settings(), current, snapshot, deadline, id => host.store.triggers.get(id)), signal)
      },
    }),
    tool({
      name: 'orchestrator_publish_review',
      description: 'Publish the reviewed local HEAD to its existing PR. Pass evidence by thread ID to reply and resolve automatically after CircleCI.',
      schema: z.object({
        pr_number: z.number().int().positive(),
        local_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
        review_evidence: ReviewEvidenceSchema.optional(),
      }).strict(),
      execute: async ({ pr_number, local_head_sha, review_evidence }, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current) || !pullNumbers(current).has(pr_number)) {
          throw new Error('PR does not belong to this open ticket')
        }
        const source = host.github
        const assignmentId = current.assignments.at(-1)?.id
        const verify = (pr: Pull) => {
          const latest = host.store.tickets.get(ticketId)
          if (!latest || !liveTicket(latest) || latest.assignments.at(-1)?.id !== assignmentId) {
            throw new Error('Assignment changed while publishing the reviewed commit')
          }
          const error = pullClaimError(source, ticketId, pr)
          if (error) throw new Error(error)
          if (pr.state !== 'open' || !agentPull(pr, source.deployment)) throw new Error('Expected an open agent-authored PR in the configured repository')
        }
        const before = await readPull(source, pr_number, signal)
        verify(before)
        const evidenceIds = Object.keys(review_evidence ?? {})
        if (evidenceIds.length > 100) throw new Error('Provide evidence for at most 100 review threads')
        const checklist = evidenceIds.length ? await readReviewThreads(source, pr_number, signal) : []
        const unknown = evidenceIds.filter(id => !checklist.some(thread => thread.id === id))
        if (unknown.length) throw new Error(`Threads do not belong to PR #${pr_number}: ${unknown.join(', ')}`)
        const open = checklist.filter(thread => !thread.resolved && evidenceIds.includes(thread.id)).map(thread => thread.id)
        const pushed = before.head.sha !== local_head_sha
        const directory = current.execution?.directory ?? ''
        if (pushed && before.auto_merge != null) throw new Error('Withdraw auto-merge before publishing changes')
        if (open.length && !pushed && !await reviewedCommit(directory, local_head_sha, signal)) {
          throw new Error('The published head lacks independent staged review')
        }
        if (pushed) {
          if (!await workspaceOwnsGit(directory, signal)) throw new Error('Ticket has no open managed Git workspace')
          const { repository, stateDir } = source.deployment
          const env = Object.fromEntries(Object.entries(agentVariables(stateDir)).filter((entry): entry is [string, string] => entry[1] !== undefined))
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          const git = (...args: string[]) => runAsWorker(host.context.subprocess,
            ['git', '--no-replace-objects', '-c', `core.hooksPath=${reviewHooks(stateDir)}`, ...args], directory, deadline, env)
            .then(value => value.trim())
          await verifyDirectory(directory, host.context.subprocess, deadline)
          if (await git('rev-parse', 'HEAD') !== local_head_sha) throw new Error('Provide the exact local head SHA')
          const url = `https://github.com/${repository}.git`
          const origin = await git('remote', 'get-url', 'origin')
          const pushOrigin = await git('remote', 'get-url', '--push', '--all', 'origin')
          if (origin !== url || pushOrigin !== url) throw new Error('The Git workspace origin must point to the configured GitHub repository')
          const ref = `refs/heads/${before.head.ref}`
          await git('check-ref-format', ref)
          await git('fetch', '--no-tags', 'origin', ref)
          if (await git('rev-parse', 'FETCH_HEAD') !== before.head.sha) throw new Error('The PR branch moved. Fetch and verify the current head.')
          await git('merge-base', '--is-ancestor', before.head.sha, local_head_sha)
          if (!await reviewedCommit(directory, local_head_sha, deadline, before.head.sha)) throw new Error('The local head lacks independent staged review')
          const fresh = await readPull(source, pr_number, deadline)
          verify(fresh)
          if (fresh.head.ref !== before.head.ref || fresh.head.sha !== before.head.sha) throw new Error('The PR changed before the push')
          await git('push', 'origin', `${local_head_sha}:${ref}`)
        }
        const after = await readPull(source, pr_number, signal)
        verify(after)
        if (after.head.ref !== before.head.ref || after.head.sha !== local_head_sha) throw new Error('GitHub did not confirm the requested commit as the PR head')
        host.store.atomic(() => {
          verify(after)
          const refused = claimPull(source, ticketId, after)
          if (refused) throw new Error(refused)
          const key = commitReviewCiKey(ticketId)
          if (host.effects.queued('commitReviewCi', key)?.head !== local_head_sha) {
            host.effects.enqueue('commitReviewCi', key, { ticketId, pr: pr_number, head: local_head_sha })
          }
          if (open.length) {
            const key = reviewResolutionKey(ticketId, pr_number)
            const queued = host.effects.queued('reviewResolution', key)
            const previous = queued?.head === local_head_sha ? queued : undefined
            host.effects.enqueue('reviewResolution', key, {
              ticketId, pr: pr_number, head: local_head_sha,
              threads: [...new Set([...(previous?.threads ?? []), ...open])],
              requiredChecks: [...new Set([...(previous?.requiredChecks ?? []), REQUIRED_CIRCLECI])],
              evidence: { ...previous?.evidence, ...Object.fromEntries(open.map(id => [id, review_evidence![id]!])) },
            })
          }
        })
        return { head: local_head_sha, pushed, pr: pr_number, pending_threads: open }
      },
    }),
    tool({
      name: 'orchestrator_review_checklist',
      description: 'Read PR review thread IDs, comments, and resolution status.',
      schema: z.object({ pr_number: z.number().int().positive(), offset: z.number().int().nonnegative().default(0) }).strict(),
      execute: async ({ pr_number, offset }, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current) || !pullNumbers(current).has(pr_number)) throw new Error('PR does not belong to this open ticket')
        const threads = await readReviewThreads(host.github, pr_number, signal)
        const end = offset + 5
        return { threads: threads.slice(offset, end).map(thread => ({ ...thread, body: thread.body.slice(0, 1600) })),
          ...(end < threads.length ? { next_offset: end } : {}) }
      },
    }),
    tool({
      name: 'orchestrator_resolve_review_threads',
      description: 'Post verification evidence in each selected review thread and resolve it once CI passes.',
      schema: z.object({
        pr_number: z.number().int().positive(),
        verified_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
        thread_ids: z.array(z.string().min(1)).min(1).max(100),
        review_evidence: ReviewEvidenceSchema.optional()
          .describe('Files and checks by open thread ID.'),
        required_check: z.string().trim().min(1).max(120).optional().describe('Required CI check name.'),
      }).strict(),
      execute: async ({ pr_number, verified_head_sha, thread_ids, review_evidence, required_check }, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current) || !pullNumbers(current).has(pr_number)) {
          throw new Error('PR does not belong to this open ticket')
        }
        const assignmentId = current.assignments.at(-1)?.id
        const verifyHead = async () => {
          const pull = await readPull(host.github, pr_number, signal)
          const latest = host.store.tickets.get(ticketId)
          if (!latest || !liveTicket(latest) || latest.assignments.at(-1)?.id !== assignmentId) {
            throw new Error('Assignment changed during review resolution')
          }
          const error = pullClaimError(host.github, ticketId, pull)
          if (error) throw new Error(error)
          if (pull.state !== 'open' || pull.head.sha !== verified_head_sha) {
            throw new Error(`PR #${pr_number} is ${pull.state} at head ${pull.head.sha}. Verify the current open PR head before resolving threads.`)
          }
        }
        await verifyHead()
        const checklist = new Map((await readReviewThreads(host.github, pr_number, signal)).map(thread => [thread.id, thread]))
        const ids = [...new Set(thread_ids)]
        const unknown = ids.filter(id => !checklist.has(id))
        if (unknown.length) throw new Error(`Threads do not belong to PR #${pr_number}: ${unknown.join(', ')}`)
        const open = ids.filter(id => !checklist.get(id)?.resolved)
        const missing = open.filter(id => !review_evidence || !Object.hasOwn(review_evidence, id))
        if (missing.length) throw new Error(`Provide review evidence for these open threads before resolving them: ${missing.join(', ')}`)
        if (!open.length) return { resolved: ids }
        const evidence = Object.fromEntries(open.map(id => [id, review_evidence![id]!]))
        const effectKey = reviewResolutionKey(ticketId, pr_number)
        const snapshot = await pullChecks(host.github.commands.withSignal(signal), verified_head_sha)
        await verifyHead()
        const queued = host.store.atomic(() => {
          const earlier = host.effects.queued('reviewResolution', effectKey)
          const previous = earlier?.head === verified_head_sha ? earlier : undefined
          const requiredChecks = [...new Set([...(previous?.requiredChecks ?? []), ...(required_check ? [required_check] : [])])]
          if (!previous && reviewChecksPassed(snapshot, requiredChecks)) return false
          const threads = [...new Set([...(previous?.threads ?? []), ...open])]
          host.effects.enqueue('reviewResolution', effectKey, { ticketId, pr: pr_number, head: verified_head_sha,
            threads, requiredChecks, evidence: { ...previous?.evidence, ...evidence } })
          return true
        })
        if (queued) return { pending: open, head: verified_head_sha }
        for (const id of open) {
          await verifyHead()
          await replyToVerifiedReview(host.github, pr_number, verified_head_sha, checklist.get(id)!, evidence[id]!, signal)
          await verifyHead()
          await resolveReviewThread(host.github, id, signal)
        }
        return { resolved: ids }
      },
    }),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('Question for a person. Omit to keep it, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('Trigger that raised the question.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        no_repository_changes: z.literal(true).optional()
          .describe('Ready without local or pushed changes.'),
        verified_head_sha: z.string().regex(/^[0-9a-f]{40}$/).optional()
          .describe('Verified pushed SHA for one open PR.'),
        verified_heads: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().regex(/^[0-9a-f]{40}$/)).optional()
          .describe('Verified pushed SHAs by PR number.'),
        review_evidence: ReviewEvidenceSchema.optional()
          .describe('For ready, files and checks by review thread ID.'),
        reply_to_trigger_id: z.string().optional().describe('Human question this report answers.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const report = { state: args.state, summary: args.summary,
          ...(args.human_action !== undefined ? { question: args.human_action } : {}),
          ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
          ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
        host.engine.validateReport(ticketId, report)
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        const claimError = pull && pullClaimError(host.github, ticketId, pull)
        if (claimError) throw new Error(claimError)
        const assignmentId = current.assignments.at(-1)?.id
        const rejectReady = (message: string): never => {
          const latest = host.store.tickets.get(ticketId)
          if (latest && liveTicket(latest) && latest.assignments.at(-1)?.id === assignmentId) {
            host.engine.report(ticketId, { state: 'progress', summary: message, readyRejected: true })
          }
          throw new Error(message)
        }
        if (args.state === 'ready') {
          const numbers = pullNumbers(current)
          if (pull?.state === 'open') numbers.add(pull.number)
          const openPulls: Pull[] = []
          for (const number of numbers) {
            const before = pull?.number === number ? pull : await readPull(host.github, number, signal)
            if (before.state === 'open') openPulls.push(before)
          }
          const workspace = current.execution?.directory ?? ''
          const managedReview = openPulls.length > 0 && (host.store.settings().executor.prepare.trim()
            || await workspaceOwnsGit(workspace, signal))
          for (const before of openPulls) {
            const number = before.number
            const claimed = args.verified_heads?.[String(number)] ?? (openPulls.length === 1 ? args.verified_head_sha : undefined)
            if (claimed !== before.head.sha) {
              rejectReady(`PR #${number} head is ${before.head.sha}. Push your intended changes, verify that revision and its checks, and report its exact SHA in verified_head_sha or verified_heads.`)
            }
            if (managedReview) {
              if (!await reviewedCommit(workspace, before.head.sha, signal)) {
                rejectReady('The PR head or its new commits lack an independent staged review. Review the staged changes before creating or replacing unreviewed commits.')
              }
              const checks = await pullChecks(host.github.commands.withSignal(signal), before.head.sha)
              if (!reviewedCircleCiPassed(checks)) {
                const failed = ciFailures(checks)
                if (failed.length) rejectReady('CircleCI readiness blocked by failed checks: ' + failed.join(', '))
                const key = commitReviewCiKey(ticketId)
                if (host.effects.queued('commitReviewCi', key)?.head !== before.head.sha) {
                  host.effects.enqueue('commitReviewCi', key, { ticketId, pr: number, head: before.head.sha })
                }
                rejectReady('CircleCI is pending on the reviewed PR head. The orchestrator will notify you when it changes.')
              }
            }
            const checklist = await readReviewThreads(host.github, number, signal)
            const fresh = await readPull(host.github, number, signal)
            if (fresh.state !== 'open' || fresh.head.sha !== before.head.sha) {
              rejectReady('The PR changed during verification of its review threads. Check its current head.')
            }
            const threads = checklist.filter(thread => !thread.resolved)
            const evidence = Object.fromEntries(threads.flatMap(thread => {
              const detail = args.review_evidence?.[thread.id]
              return detail ? [[thread.id, detail]] : []
            }))
            const addressed = Object.keys(evidence)
            if (addressed.length) {
              const error = pullClaimError(host.github, ticketId, fresh)
              if (error) rejectReady(error)
              host.store.atomic(() => {
                if (host.store.tickets.get(ticketId)?.assignments.at(-1)?.id !== assignmentId) {
                  throw new Error('Assignment changed while queueing review replies')
                }
                const effectKey = reviewResolutionKey(ticketId, number)
                const earlier = host.effects.queued('reviewResolution', effectKey)
                const previous = earlier?.head === fresh.head.sha ? earlier : undefined
                host.effects.enqueue('reviewResolution', effectKey, {
                  ticketId, pr: number, head: fresh.head.sha,
                  threads: [...new Set([...(previous?.threads ?? []), ...addressed])],
                  requiredChecks: [...new Set([...(previous?.requiredChecks ?? []), ...(managedReview ? [REQUIRED_CIRCLECI] : [])])],
                  evidence: { ...previous?.evidence, ...evidence },
                })
              })
            }
            if (threads.length) {
              rejectReady(`PR #${number} still has unresolved review threads. Check each against the pushed fixes, pass per-thread review_evidence to orchestrator_resolve_review_threads for addressed threads, and verify their status before reporting ready. Report a concrete blocker for anything outstanding. Open threads:\n${threads.map(thread => `${thread.id} ${thread.url}`).join('\n')}`)
            }
            const missing = checklist.filter(thread => !args.review_evidence || !Object.hasOwn(args.review_evidence, thread.id))
            if (missing.length) {
              rejectReady(`PR #${number} needs review evidence for ${missing.map(thread => thread.id).join(', ')}. Use orchestrator_review_checklist and verify the requested code and tests for each thread.`)
            }
            const after = await readPull(host.github, number, signal)
            if (after.state !== 'open' || after.head.sha !== before.head.sha) {
              rejectReady(`PR #${number} changed during verification. Check the current head and review threads again before reporting ready.`)
            }
          }
          if (!openPulls.length && !args.no_repository_changes) {
            rejectReady('Open a pull request for the repository changes and report its number and verified head SHA. A pushed branch alone is incomplete. Use no_repository_changes only for work that produced no repository changes.')
          }
        }
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          if (host.store.tickets.get(ticketId)?.assignments.at(-1)?.id !== assignmentId) {
            throw new Error('Assignment changed during report verification')
          }
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const evidence = args.state === 'ready' && Object.entries(args.review_evidence ?? {})
          const summary = evidence && evidence.length
            ? [args.summary, 'Review evidence:', ...evidence.map(([id, detail]) => `${id}: ${detail}`)].join('\n')
            : args.summary
          const finalReport = { ...report, summary }
          const updated = host.engine.report(ticketId, finalReport)
          const recorded = updated.assignments.at(-1)?.report
          const retrying = args.state === 'dropped' && !updated.ended && updated.assignments.at(-2)?.endedReason === 'reviewRetry'
            && !recorded
          const relay = retrying ? undefined : reportRelay(updated, recorded ? { ...finalReport, state: recorded.state, summary: recorded.summary } : finalReport)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...retrying ? { retrying: true } : {}, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
