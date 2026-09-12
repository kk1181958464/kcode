# Agent Runtime

`agent.ts` is the compatibility entry point for desktop, CLI and existing tests.
Keep the implementation in the modules below and re-export public APIs from
the entry point.

| Module | Responsibility |
| --- | --- |
| `agent-types.ts` | Shared tool, history, turn and runner contracts |
| `agent-runner.ts` | Turn loop, steering, tool activity lifecycle and run history |
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

Protocol parsers return a `Turn`; they do not decide whether the task is complete.
Completion, pause and recovery remain decisions of the runner and evidence
helpers. Changes to transport or parsing must preserve visible text events,
tool IDs, arguments, usage and the failure/completion distinction.

Run `npm run typecheck`, `npm test` and `npm run build` after changes to these
boundaries. The parser, stream-runner and cache-isolation integration tests cover
the module connections in addition to the existing agent-loop tests.
