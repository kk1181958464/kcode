# kcode-cli

Multi-provider coding agent, CLI edition — the KCode agent runtime in your terminal.

`kcode` drives the same agent loop as the KCode desktop app (tool calls, streaming,
planner/executor collaboration, SSH & database tools, MCP) but renders to your
terminal instead of a GUI window.

## Install

```bash
npm install -g kcode-cli
```

Requires **Node.js >= 20**.

## Usage

```bash
kcode [workspacePath]
```

- `workspacePath` — the project directory the agent operates in. Defaults to the
  current working directory.
- On first run, `kcode` prompts once for a provider (Base URL, protocol, model
  ID, API key) and stores it under `~/.kcode`.
- Type a task and press Enter. `Ctrl+C` interrupts the current turn.
  `/exit` quits.

Example:

```bash
cd ~/my-project
kcode
› 给 utils.ts 里的 formatDate 补充单元测试
```

## Configuration

State lives in `~/.kcode` by default (providers, conversations, caches).
Override the location with the `KCODE_HOME` environment variable:

```bash
KCODE_HOME=/path/to/state kcode
```

### Supported provider protocols

| Protocol             | Providers (examples)              |
| -------------------- | --------------------------------- |
| `openai-chat`        | DeepSeek, xAI, most OpenAI-compatible relays |
| `openai-responses`   | OpenAI                            |
| `anthropic-messages` | Anthropic                         |

## What's included

- File tools (read / write / patch / move / delete), code search (ripgrep with
  native fallback), command execution.
- SSH remote tools and MySQL / MongoDB / SQL Server database tools.
- Planner → Executor multi-model collaboration and subagents.

## Not included (vs. desktop)

- Browser automation tools (the desktop app embeds Chromium; the CLI does not).
- The graphical editor, diff viewer, and status panels.

## License

MIT
