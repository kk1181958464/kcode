# kcode-cli

Multi-provider coding agent, CLI edition — the KCode agent runtime in your terminal.

`kcode` drives the same agent loop as the KCode desktop app (tool calls, streaming,
planner/executor collaboration, SSH & database tools, MCP) but renders to your
terminal instead of a GUI window.

## Install

```bash
npm install -g @kk1181958464/kcode
```

Requires **Node.js >= 20**.

## Usage

```bash
kcode [workspacePath]
```

- `workspacePath` — the project directory the agent operates in. Defaults to the
  current working directory.
- Piped/non-interactive input runs in `read-only` mode by default. Pass
  `--yolo` or `--full-access` explicitly when an automated run must modify the
  workspace.
- On first run, `kcode` guides you through adding the first model provider. It
  detects the protocol and model list when possible, then stores the channel
  under `~/.kcode`.
- Interactive terminals use a persistent bordered prompt. Type `/` to open the
  command menu, use `↑`/`↓` to select, `Tab` to complete, and `Enter` to run.
- The first-run wizard hides the API key and provides an arrow-key model picker.
- Use `/provider` to add and manage multiple channels. You can switch the
  current channel/model, rename a channel, edit its endpoint and protocol,
  refresh models, enable/disable it, or delete it. CLI and desktop share the
  same `providers.json`, so channels configured in either interface are visible
  in the other.
- Type a task and press Enter. `Ctrl+C` exits the prompt or interrupts the
  current turn. `/exit` quits.

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

API keys are encrypted with AES-256-GCM using a per-user local key stored under
`KCODE_HOME`; the state directory and credential files are restricted to the
current OS account where the platform supports POSIX file modes. This protects
against accidental disclosure and casual file inspection; it does not protect
secrets from an attacker who already has access to the same OS account and its
entire KCode state directory.

### Supported provider protocols

| Protocol             | Providers (examples)                         |
| -------------------- | -------------------------------------------- |
| `openai-chat`        | DeepSeek, xAI, most OpenAI-compatible relays |
| `openai-responses`   | OpenAI                                       |
| `anthropic-messages` | Anthropic                                    |

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
