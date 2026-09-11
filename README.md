# QR service monitor

This repository hosts the scheduled execution configuration for a QR service monitor.

The workflow uses a standard GitHub-hosted Ubuntu runner and requests a check every five minutes. GitHub scheduling is best effort; runs can be delayed or dropped. Public scheduled workflows may be disabled after 60 days without repository activity.

## Access and execution

Visitors can read, copy, fork, or propose a pull request. Direct changes and manual workflow dispatch require repository write access. Pull requests do not trigger this monitor and are not automatically merged.

The workflow loads one reviewed, immutable revision from a separate private source repository. Operational configuration, expected content, incident history, and delivery records remain private. This repository contains no service data or credentials. The public job reports only bounded status and fixed error codes; it does not upload private artifacts or caches.

## Activation

Scheduled monitoring and live delivery remain disabled until the owner configures the dedicated repository secrets, verifies access and notification delivery, and explicitly enables the monitor. Manual `check`, `status`, and first-time `bootstrap` operations are available to authorized maintainers; they do not send notifications.

The private source token must be restricted to the designated repository. Source changes require review and an explicit update of the pinned revision. An independent heartbeat observer is still required to detect a scheduler that stops running.

Standard GitHub-hosted runners in public repositories are free under [GitHub's Actions billing policy](https://docs.github.com/en/actions/concepts/billing-and-usage). See also [schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) and [manual workflow permissions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
