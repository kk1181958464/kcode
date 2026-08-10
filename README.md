# KCode

KCode is an early multi-provider desktop coding agent. The current MVP includes provider management, encrypted API keys, model discovery, manual model registration, and streaming chat through OpenAI-compatible and Anthropic-compatible APIs.

## Development

```bash
npm install
npm run dev
```

## Install

### macOS: first launch ("KCode is damaged and can't be opened")

This message does **not** mean the file is broken. macOS Gatekeeper blocks
apps that are downloaded from the internet and not signed/notarized with an
Apple Developer ID. KCode is currently distributed unsigned, so pick one of
the following (each only needs to be done once):

**Option 1 — Terminal (most reliable)**

Move `KCode.app` into `/Applications`, then run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/KCode.app
```

Enter your login password (it stays hidden while typing), then open KCode
normally. If the app lives elsewhere, adjust the path (e.g.
`~/Downloads/KCode.app`).

**Option 2 — System Settings**

1. Double-click KCode; when the "damaged" dialog appears, click **Cancel**.
2. Open **System Settings → Privacy & Security** and scroll to the bottom.
3. Find the "KCode was blocked" row and click **Open Anyway**, then confirm.

> Root cause: proper Apple code signing + notarization requires a paid Apple
> Developer account and is not yet configured in the release workflow.

## Mobile

The Flutter Android/iOS client lives in [`mobile/`](mobile/README.md). It reuses the remote service for accounts, tasks, live output, approvals, and attachments.

## Supported endpoints

- OpenAI-compatible: `GET /v1/models`, `POST /v1/chat/completions`
- Anthropic-compatible: `GET /v1/models`, `POST /v1/messages`

API keys are encrypted by Electron `safeStorage` and are only decrypted in the main process.

## Next milestone

The next milestone is the coding-agent tool loop: workspace file access, ripgrep search, patch application, terminal execution, permission approval, and Git diff presentation.
