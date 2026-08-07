# Third-Party Notices

## AionUi

KCode's conversation auto-scroll state machine and task runtime projection
were informed by and adapted from patterns in AionUi.

- Project: AionUi
- Source: https://github.com/iOfficeAI/AionUi
- Copyright: Copyright 2025 AionUi (aionui.com)
- License: Apache License 2.0
- Local license copy: `third_party/AionUi-LICENSE.txt`

KCode's adapted implementations are materially modified for paged task
history, nested diff scrolling, Electron task isolation, and the KCode remote
control protocol. The relevant KCode files are:

- `src/conversation-scroll-controller.ts`
- `src/task-runtime-store.ts`
- `remote/src/web/reconnect-policy.ts`

