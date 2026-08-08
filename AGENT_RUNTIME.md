# KCode Agent Runtime

KCode now gives every model request a canonical runtime identity:

```text
Thread (taskId) -> Turn (requestId) -> Item (itemId)
```

The Electron renderer is a projection client. It may display messages,
activities, progress, or a mobile stream, but it must not invent a second
ordering source.

## Event Contract

Every event crossing the main-process IPC boundary carries:

- `protocolVersion`
- `eventId` (`requestId:sequence`)
- `itemId`
- `taskId` and `requestId`
- request-local `sequence`
- `eventKind` and `itemStatus`
- `emittedAt`

Text, reasoning, and tool-output deltas are coalesced for a short interval.
Structural events and terminal events flush immediately.

## Persistence

The `runtime_events` SQLite table is append-only. `(requestId, sequence)` and
`eventId` are unique, so reconnects and retries are idempotent. Task messages
and activities remain queryable through their existing paginated tables; the
runtime journal is the durable source for replay, status recovery, and remote
diagnostics.

Useful IPC methods are:

- `state:runtime-events`
- `state:runtime-statuses`
- `runtime:statuses`
- `chat:steer`

## State Rules

The main process owns the active run registry. The renderer mirrors it with a
sequence-aware state machine. A task can remain running while another task is
selected, and an older terminal event cannot clear a newer request.

`context_compaction` is a first-class event with `started` and `completed`
phases. Context usage prefers the latest upstream prompt-token observation;
local estimates are labeled as estimates and belong to an explicit context
window.

## Configuration

`src/config-layer.ts` defines the compatible precedence chain
`defaults -> system -> user -> project -> task -> session`. It preserves the
origin and version of every effective value so settings can expose provenance
without changing the existing provider records all at once.

## Tool Evidence

Every tool activity has a separate `toolCallId` and passes through the tool
registry lifecycle. File changes, command exit codes, and mutation evidence
continue to be validated by the existing completion verifier. A text-only
answer is not treated as proof of a change.

Hooks are available at session start, before and after tools, and around
compaction. Managed child processes are persisted and supervised so exited
records are removed after crashes or restarts.

## Remote Clients

Remote stream snapshots retain their old shape and now optionally include
runtime event metadata. Older clients can ignore the new fields. New clients
should deduplicate by `runtimeEventId`, use `runtimeEventKind` for terminal
state, and use `runtimeItemStatus` for waiting/active labels.

The agent loop still runs inside the Electron main process because browser,
SSH, and database sessions currently live there. The protocol, journal, tool
registry, and runtime service are the extraction boundary for moving it into a
separate worker later without changing renderer or mobile contracts.
