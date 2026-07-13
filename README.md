# KCode

KCode is an early multi-provider desktop coding agent. The current MVP includes provider management, encrypted API keys, model discovery, manual model registration, and streaming chat through OpenAI-compatible and Anthropic-compatible APIs.

## Development

```bash
npm install
npm run dev
```

## Supported endpoints

- OpenAI-compatible: `GET /v1/models`, `POST /v1/chat/completions`
- Anthropic-compatible: `GET /v1/models`, `POST /v1/messages`

API keys are encrypted by Electron `safeStorage` and are only decrypted in the main process.

## Next milestone

The next milestone is the coding-agent tool loop: workspace file access, ripgrep search, patch application, terminal execution, permission approval, and Git diff presentation.
