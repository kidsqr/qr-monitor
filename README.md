# QR service monitor

This repository hosts the scheduled execution configuration for a QR service monitor.

The monitor workflow uses a standard GitHub-hosted Ubuntu runner and requests a check every five minutes. GitHub scheduling is best effort; runs can be delayed or dropped. Public scheduled workflows may be disabled after 60 days without repository activity.

A separate public maintenance workflow checks repository activity weekly. When the latest `main` commit is at least 30 days old, an enabled maintenance run creates one empty child commit that reuses the existing tree, then advances `main` without force. This supplies repository activity before GitHub's 60-day inactivity window without changing monitored content.

## Access and execution

Visitors can read, copy, fork, or propose a pull request. Direct changes and manual workflow dispatch require repository write access. Pull requests do not trigger this monitor and are not automatically merged.

The workflow loads one reviewed, immutable revision from a separate private source repository. Operational configuration, expected content, incident history, and delivery records remain private. This repository contains no service data or credentials. The public job reports only bounded status and fixed error codes; it does not upload private artifacts or caches.

Maintenance uses only the built-in `GITHUB_TOKEN` against fixed API routes in this public repository. It does not load the private monitor source, write service state, retry ambiguous writes, or claim that the monitor or product is healthy.

## Activation

Scheduled monitoring and live delivery remain disabled until the owner configures the dedicated repository secrets, verifies access and notification delivery, and explicitly enables the monitor. Manual `check`, `status`, and first-time `bootstrap` operations are available to authorized maintainers; they do not send notifications.

The private source token must be restricted to the designated repository. Source changes require review and an explicit update of the pinned revision.

Manual `source-check`, `email-auth`, and `slack-auth` operations perform read-only source or non-sending authentication diagnostics. They report fixed outcomes only; authentication does not prove notification delivery. The `test-start` and `test-finish` operations require a separately approved test and explicit confirmation, use a separate private one-shot test journal, and work only while live monitoring is disabled. `test-status` reads that test journal without sending. Test messages are labeled synthetic and never create a production incident or claim production recovery.

Set the repository variable `QR_MONITOR_MAINTENANCE_ENABLED` to `1` before scheduled or manually dispatched `maintain` operations can write. An authorized manual `check` remains read-only and can run while the variable is unset. Maintenance reports only `disabled`, `current`, `due`, or `maintained`, with fixed refusal/failure codes on errors.

An approved one-time Slack destination move uses `slack-move` with the explicit confirmation `MOVE_QR_SLACK_CHANNEL`, only while monitoring is disabled. It preserves production delivery history, records a separate one-shot receipt, and sends no email. Live monitoring requires a confirmed move receipt before routing subsequent replies. Rejected or ambiguous move attempts are not automatically retried.

This maintenance reduces inactivity-disable risk only while GitHub Actions schedules continue to run. It cannot run during a GitHub outage, repair a disabled scheduler, or notify anyone that scheduled runs are missing; missing-schedule notification remains a limitation.

Standard GitHub-hosted runners in public repositories are free under [GitHub's Actions billing policy](https://docs.github.com/en/actions/concepts/billing-and-usage). See also [schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) and [manual workflow permissions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
