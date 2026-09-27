# Agent Runtime

`agent.ts` is the compatibility entry point for desktop, CLI and existing tests.
Keep the implementation in the modules below and re-export public APIs from
the entry point.

| Module | Responsibility |
| --- | --- |
| `agent-types.ts` | Shared tool, history, turn and runner contracts |
| `agent-runner.ts` | Turn orchestration, steering, completion gates and stall decisions |
| `agent-run-setup.ts` | Request-local workspace, connection, provider, cache and history initialization |
| `agent-model-turn.ts` | Model event forwarding, image fallback, recovery and bounded finalization |
| `agent-tool-turn.ts` | Tool batch permissions, activity lifecycle, execution, evidence and persistence |
| `agent-approval.ts` | Approval registration, cancellation and listener cleanup |
| `agent-terminal.ts` | Final event emission and atomic closure of steering acceptance |
| `agent-run-state.ts` | Mutable run-loop state: plan, budgets, stalls and requested ops |
| `agent-activity-lifecycle.ts` | Activity titles, permission categories, status and structured results |
| `agent-round-policy.ts` | Round evidence snapshot, empty-turn recovery, auto-continue and stall decisions |
| `agent-command.ts` | Spawned command helper, failure classification and mutation paths |
| `process-tools.ts` | Background process start/output/stop |
| `web-tools.ts` | Public web search and URL fetch |
| `credential-tools.ts` | Credential list/save/forget and website origin helpers |
| `browser-tools.ts` | Browser open/snapshot/click/type/fill/screenshot/record |
| `ssh-session-tools.ts` | SSH connect/workspace/run/file/disconnect |
| `database-tools.ts` | MySQL, SQL Server and MongoDB connect/query/disconnect |
| `subagent-tools.ts` | spawn/list/message/wait/stop child agents |
| `agent-control-tools.ts` | Plan, MCP, diagnostics, local command and user-input tools |
| `agent-tool-runtime.ts` | Tool dispatch, approvals, undo and connection operations |
| `agent-tool-schema.ts` | Advertised schemas and accepted tool names |
| `agent-input.ts` | Tool input redaction and structured input requests |
| `agent-evidence.ts` | Activity-to-evidence conversion and connection facts |
| `agent-finalization.ts` | Evidence checks, pause results and fallback summaries |
| `agent-public-page.ts` | Public URL validation, fetch and page cache |
| `model-turn.ts` | Prompt/request construction and provider fallbacks |
| `model-response-parser.ts` | Streamed and JSON response normalization |
| `model-stream-runner.ts` | Stream retry, shared deadline and text reconciliation |

The tool runtime receives the child runner as a callback. It must not import
`agent.ts` or `agent-runner.ts`: that would create a runtime dependency cycle.
Each call to `runAgent` owns its file read cache and passes it to tool execution.
Starting another task or child must not replace that cache.

The runner delegates model and tool phases with `yield*` so streamed events keep
their original order and async-generator cancellation is forwarded. The model
phase returns a discriminated `ready`, `continue` or `stop` result; only `ready`
provides a turn for completion checks or tool execution. Recovery updates the
request's existing budgets and history before handing control back to the loop.
The tool phase returns round progress, failures and pending user input. The
runner owns the transition to the next model round or a terminal outcome.
Neither phase imports the runner: child execution is supplied as a callback.

Recovered validation is the starting point of the ordered evidence ledger:
any new proven mutation invalidates it until a later successful validation.
Recovered non-validation operations remain available for continuation.

The runner opens steering acceptance before setup and closes it in `finally`.
Terminal emission checks for accepted steering between final events and closes
acceptance before publishing `done` or `error`. Pending input resumes the loop;
cancellation takes precedence. Steering also retires older user-input requests.
Approval resolvers are registered before publishing the waiting activity and
are removed together with their abort listeners on settlement or closure.

Protocol parsers return a `Turn`; they do not decide whether the task is complete.
Completion, pause and recovery remain decisions of the runner and evidence
helpers. Changes to transport or parsing must preserve visible text events,
tool IDs, arguments, usage and the failure/completion distinction.

Stream error events become UpstreamStreamError instances with code, type,
status and request metadata. Retry policy and UI classification inspect these
fields before falling back to message text. Authentication, quota and invalid
request codes must not be retried because their message resembles a transport
failure. Logs retain the selected metadata, never the entire error payload.

Run `npm run typecheck`, `npm test` and `npm run build` after changes to these
boundaries. The parser, stream-runner and cache-isolation integration tests cover
the module connections in addition to the existing agent-loop tests.
`agent-turn-phases.test.ts` covers phase return values, event ordering, text reset
offsets, permission denial and user-input handoff. Run `npm run cli:build` when
changing these shared runtime module boundaries to check the CLI bundle too.
`agent-stability-integration.test.ts`, `agent-approval.test.ts` and
`agent-recovery-validation.test.ts` cover late steering, immediate approvals,
cancellation cleanup and the validity of recovered validation.
