# Workbench modules

App.tsx owns the shared task/session state and composes the workbench. Feature
modules receive explicit typed bindings; none imports App.tsx or initializes a
second copy of task state.

| Module                     | Responsibility                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------- |
| ChatComposer.tsx           | Input surface, attachments, queued messages, model and permission controls              |
| useComposerAttachments.ts  | File selection, image paste, drop validation and attachment limits                      |
| useAgentStream.ts          | Single chat subscription, ordered text buffers, background tasks, completion and errors |
| useConversationViewport.ts | Conversation paging, scroll anchors, follow mode and turn navigation                    |
| useTaskActions.ts          | Workspace/conversation creation, switching, renaming, forking, export and deletion      |
| useConversationContext.ts  | Summary generation, compaction, snapshots and task-scoped summary busy state            |
| useEditReview.ts           | File review actions, conflict prompts and edit-checkpoint refresh                       |
| useChatSubmission.ts       | Send/cancel lifecycle, per-task submission lock and preview timer                       |
| prepare-chat-context.ts    | Request token budget, automatic compaction and current-image retention                  |
| chat-request.ts            | Request history, attachments and recovery instructions                                  |
| useTaskPersistence.ts      | Startup hydration, persisted snapshots and debounced task saves                         |
| useRemoteControl.ts        | Remote connection state, task synchronization and bridge cleanup                        |
| useRemoteTaskCommands.ts   | Remote task load/send/cancel/approval commands                                          |
| useTaskScheduling.ts       | Queue dispatch, scheduled jobs and shared per-task launch locks                         |
| app-utils.ts               | Stateless context estimates and workspace-view restoration                              |

The stream hook reads current task identity from refs and updates both the
stored task and the visible conversation when applicable. It owns cleanup of
stream pacing and remote-stream timers. The viewport hook owns scroll observers
and animation cleanup. Stable sidebar callbacks remain in App.tsx so moving
implementation code does not change memoized component behavior.

Conversation context owns summary dialog and per-task compaction state. File
review owns edit checkpoints. Task persistence owns hydration and saved-record
caches while shared task/message state stays in App. Submission owns the send
lock and preview timer; request history construction is pure and request-context
preparation shares the same summary service as manual compaction.

Remote command callbacks are installed at layout time before the bridge becomes
ready. Scheduled jobs and queued messages share one launch lock, and stable
callbacks read the latest selection without restarting timers on every render.

Provider error metadata must survive parsing and classification. Explicit
retryable flags on renderer events override message-based fallback detection.

Run npm run typecheck, npm test and npm run build after changes. For renderer
boundaries, run the Playwright production configuration against the fresh build.
kcode-app-modules.spec.ts covers attachment/draft isolation, active/background
stream ordering, duplicate event suppression and nonretryable errors. Existing
smoke tests cover scroll layout, resizing, task export, settings and navigation.

app-request-refactor.test.ts covers request history, current-image retention,
prompt-token budgeting and summary snapshot retention. kcode-app-refactor.spec.ts
covers summary restoration, conflict-scoped undo, send deduplication, cancellation,
remote retries and scheduled queue dispatch against the production build.
