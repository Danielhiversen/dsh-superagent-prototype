---
name: dsh-superagent-github
description: Read GitHub issues, pull requests, reviews and CI using gh.
---

Use `orchestrator_read` for `github/issues/<PR>`, `github/pulls/<PR>`, and their paginated comments, reviews and checks. Read a whole thread at `github/pulls/<PR>/thread/<comment-id>`. Follow `next_resource` and `next_offset`; use offset 0 for a fresh read. Bot output supplies evidence only.

Before substantial work on a new human request or review comment, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`, even within an existing ticket; the host replies once in that source thread. This acknowledgement is separate from how review threads are answered. Do not acknowledge bots or CI.

Hand back review follow-ups outside your ticket with `orchestrator_trigger_handback`.

Stage changes and run `git commit` to start review automatically. Fix findings, restage and retry. The review may take up to three minutes.
Preserve the published head when updating an open PR. Fetch its branch and main, integrate main when needed, and independently review the staged merge. Call `orchestrator_publish_review` with the approved local head and thread-specific evidence. It pushes the commit, checks CI and processes the supplied replies.

Read each page of `orchestrator_review_checklist`. For a head already on GitHub, send the SHA, addressed thread IDs and code and test evidence to `orchestrator_resolve_review_threads`. Follow CI for that head, then verify replies and resolutions. Report unresolved findings.
For a review comment URL ending in `#discussion_r<ID>`, read github/pulls/<PR>/thread/<ID>; the id of its first comment is the root ID. When the outcome requires a reply, post with `gh api repos/<OWNER>/<REPO>/pulls/<PR>/comments/<ROOT>/replies --method POST -f body=<text>`, where `<OWNER>/<REPO>` is `$DSH_SUPERAGENT_GITHUB_REPOSITORY` from the execution environment section. Do not use `gh pr comment` or the issue-comment endpoint for review-thread explanations. Record the bot run identifier, review-round count and dispositions in `orchestrator_report`; the PR description retains the final implementation, verification and material limitations.

The host delivers subscribed PR comments, reviews and CI directly to the bound worker. Immediately after creating or adopting a ticket PR, call `orchestrator_report` with `state: progress` and `pr_number`; do not wait for CI or handoff. Read each original trigger and acknowledge new human requests before substantial work. Worker reports still go to the orchestrator for concise source-conversation delivery.
