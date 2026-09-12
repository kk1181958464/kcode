import { type AgentToolName } from "../src/types";
import { localShellToolDescription } from "./local-shell";
import type { ToolCall } from "./agent-types";

export const tools = [
  {
    name: "list_directory",
    description:
      "List files and directories on this computer in the local project workspace. Use this instead of shell dir/Get-ChildItem.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "glob_files",
    description:
      "Find files on this computer in the local project workspace using a glob such as **/*.ts.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read_many_files",
    description:
      "Read up to 20 UTF-8 files from the local project workspace on this computer in one call.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "path_info",
    description:
      "Get type, size, and timestamps for a path in the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file in the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description:
      "Search text in files in the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, glob: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a Begin Patch text patch for precise file edits. Never invoke apply_patch through run_command; call this tool directly. Supports Update File, Add File, and Delete File sections. LF, CRLF, and CR files are matched automatically, and existing line endings are preserved. Use @@ lines with scope hints (e.g. '@@ functionName' or '@@ ClassName.methodName') to target specific code blocks when duplicate context lines exist in the file.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or replace a UTF-8 file in the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "make_directory",
    description:
      "Create a directory and missing parents in the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "move_path",
    description:
      "Move or rename a file or directory inside the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_path",
    description:
      "Delete a file or directory inside the local project workspace on this computer.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description:
      "Show concise Git working tree status for the local project on this computer.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "git_remote_status",
    description:
      "Verify whether local HEAD is present on a remote branch using native Git. Prefer this over fetch_url or GitHub pages when checking whether a push succeeded.",
    parameters: {
      type: "object",
      properties: {
        remote: { type: "string" },
        branch: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description: "Show Git diff for the local project workspace or one path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, staged: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description: "Show recent Git commits for the local project workspace.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "git_show",
    description:
      "Show a Git revision or file at a revision in the local project workspace.",
    parameters: {
      type: "object",
      properties: { revision: { type: "string" }, path: { type: "string" } },
      required: ["revision"],
      additionalProperties: false,
    },
  },
  {
    name: "start_process",
    description: `${localShellToolDescription(true)} Use this for a dev server or another background service and return a process id.`,
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "process_output",
    description: "Read buffered output and status for a background process.",
    parameters: {
      type: "object",
      properties: { processId: { type: "string" } },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_process",
    description: "Stop a background process started by start_process.",
    parameters: {
      type: "object",
      properties: { processId: { type: "string" } },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "diagnostics",
    description:
      "Run a common project validation command (typecheck, test, lint, or build).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["typecheck", "test", "lint", "build"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "report_no_change",
    description:
      "Report that the requested code or configuration change is unnecessary after successful read-only inspection. Use only when the inspected target already satisfies the request, the issue is outside the workspace, or there is no actionable target. Give a specific evidence-based reason; never use this merely because editing is difficult.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 8, maxLength: 1000 },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_user_input",
    description:
      "Record that the task cannot continue until the user supplies specific missing information or completes a required human action. Use only when the information cannot be discovered with available tools. Ask one concise question and list the exact fields/actions required; never use this to avoid executable work. A successful call ends the current run immediately, so do not include other tool calls in the same response.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 8, maxLength: 1000 },
        fields: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 120 },
          minItems: 1,
          maxItems: 12,
        },
      },
      required: ["question", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: "get_context_remaining",
    description:
      "Query how much context window budget remains for this conversation. Returns the estimated remaining tokens. Use this to decide whether to compress output, skip verbose explanations, or request context compaction.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the public internet. Returns structured titles, URLs, and snippets. Use this for current facts and finding documentation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 10 },
        domain: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch and extract readable text from a public HTTP or HTTPS URL. Use after web_search to inspect a source.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "number", minimum: 1000, maximum: 50000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "credential_list",
    description:
      "List locally saved SSH or database credential aliases and non-sensitive connection metadata. The caller must supply the explicit connection category; never infer a website from generic account, password, or login wording. Secrets are never returned.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["ssh", "mysql", "sqlserver", "mongodb"],
        },
        query: {
          type: "string",
          description: "Optional alias, host, database, or website filter.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_list_credentials",
    description:
      "List saved website credential aliases for the origin currently open in the task browser. This tool is available only while a real browser page is open and never returns secrets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional account alias or username filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_save_credential",
    description:
      "Securely save an account for the website origin currently open in the task browser, only when the user explicitly asks to remember that website account. The current browser origin is the scope; this tool cannot save SSH, database, desktop-app, or unclassified credentials. The password is encrypted by the operating system and is never returned.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "credential_forget",
    description:
      "Delete one locally saved credential from exactly one credential category. Use only when the user explicitly asks to forget it.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["ssh", "mysql", "sqlserver", "mongodb", "website"],
        },
        name: { type: "string" },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_open",
    description:
      "Open a visible isolated browser window at an HTTP/HTTPS URL for interactive or authenticated tasks.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Return page text and fresh references for visible interactive elements, including iframe and accessible Shadow DOM controls. Take a new snapshot after navigation or a page-changing interaction. When human verification is present, this tool waits while the user completes it in the visible browser, then returns the verified page automatically.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description:
      "Click an element reference from the latest browser snapshot using a trusted Chromium input event.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Replace the value of an element from the latest browser snapshot using trusted Chromium keyboard input, including credentials explicitly provided by the user.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill_credential",
    description:
      "Fill username/password controls from a saved website credential without revealing the decrypted secret to the model. The currently open page origin must match the saved website origin. Use refs from the latest browser_snapshot.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        usernameRef: { type: "string" },
        passwordRef: { type: "string" },
      },
      required: ["credentialName", "passwordRef"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture the current browser page to a local PNG. For responsive validation, provide width and height together (for example 1280x720 desktop or 390x844 mobile). Use fullPage to capture beyond the visible viewport.",
    parameters: {
      type: "object",
      properties: {
        width: { type: "number", minimum: 320, maximum: 2560 },
        height: { type: "number", minimum: 320, maximum: 2000 },
        mobile: { type: "boolean" },
        fullPage: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_start",
    description:
      "Start an optional browser recording for this task. Call only when the user explicitly asks to record. Captures subsequent page operations, network requests, headers, bodies, responses, and tokens.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_stop",
    description:
      "Stop the active browser recording and export the captured session as JSON plus a Python Playwright script.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ssh_connect",
    description:
      "Connect this task to an SSH server without replacing the local project workspace. To reuse a local credential, pass credentialName alone after credential_list. For a new connection, pass host/username plus password or private key and optionally name; after a successful connection it is stored with operating-system encryption by default. Never invent a credential alias. Set remember=false only when the user requests a temporary connection.",
    parameters: {
      type: "object",
      properties: {
        credentialName: {
          type: "string",
          description: "Existing saved SSH alias, id, host, or user@host.",
        },
        name: {
          type: "string",
          description: "Alias used when saving a new successful connection.",
        },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        privateKeyPath: {
          type: "string",
          description:
            "Absolute local private-key path explicitly supplied by the user.",
        },
        passphrase: { type: "string" },
        remember: {
          type: "boolean",
          description:
            "Store credentials with operating-system encryption for future reconnects. Defaults to true.",
        },
        rootPath: {
          type: "string",
          description: "Remote project directory to open in the editor.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ssh_set_workspace",
    description:
      "Set or change the editable project root on the SSH server already connected to this task. This changes only the remote root and never the local project workspace. Call this when the remote project directory becomes known after ssh_connect.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_run",
    description:
      "Run a command on the SSH server connected to this task. Defaults to a 180 second timeout and stops when the task is cancelled. Set purpose to modify whenever the command intentionally changes remote files, database records, configuration, deployments, services, caches, or other durable state. Set it to validate only for a separate deterministic post-change check whose exit code proves the result, and inspect for read-only queries. Set pty and stdin only for commands that require controlled interactive input.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        purpose: {
          type: "string",
          enum: ["execute", "inspect", "modify", "validate"],
          description:
            "Structured command purpose. Use modify for an intentional state change, validate only for a separate deterministic pass/fail check, inspect for read-only work, and execute for other commands.",
        },
        stdin: { type: "string" },
        pty: { type: "boolean" },
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 600_000,
          description:
            "Optional timeout in milliseconds. Defaults to 300000 for build/test/install commands and 180000 otherwise.",
        },
      },
      required: ["command", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_list_directory",
    description:
      "List a directory on the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_read_file",
    description:
      "Read a UTF-8 text file from the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_write_file",
    description:
      "Create or replace a UTF-8 text file on the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_upload_file",
    description:
      "Upload a local file to the SSH server connected to this task using SFTP. localPath is an absolute path on this machine; remotePath is the destination on the server. Handles binary files.",
    parameters: {
      type: "object",
      properties: {
        localPath: { type: "string" },
        remotePath: { type: "string" },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_download_file",
    description:
      "Download a file from the SSH server connected to this task to this machine using SFTP. remotePath is the source on the server; localPath is an absolute destination path on this machine. Handles binary files.",
    parameters: {
      type: "object",
      properties: {
        remotePath: { type: "string" },
        localPath: { type: "string" },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_disconnect",
    description: "Disconnect the SSH session associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mysql_connect",
    description:
      "Connect directly to MySQL. Pass credentialName to reuse an encrypted local MySQL profile, or pass new host/username/password fields and optional name; a successful new connection is remembered by default. MySQL profiles never resolve as SSH or other credential types.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        ssl: { type: "boolean" },
        sslCa: { type: "string" },
        sslCert: { type: "string" },
        sslKey: { type: "string" },
        sslPassphrase: { type: "string" },
        sslRejectUnauthorized: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mysql_connect_via_ssh",
    description:
      "Connect to MySQL through SSH. credentialName selects only a saved MySQL profile; sshCredentialName independently selects a saved SSH profile. New database details are remembered after success unless remember=false. If no SSH fields/alias are supplied, reuse this task's active SSH session.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        sshHost: { type: "string" },
        sshPort: { type: "number", minimum: 1, maximum: 65535 },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        ssl: { type: "boolean" },
        sslCa: { type: "string" },
        sslCert: { type: "string" },
        sslKey: { type: "string" },
        sslPassphrase: { type: "string" },
        sslRejectUnauthorized: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mysql_query",
    description:
      "Execute one SQL statement on the MySQL connection for this task. Supports positional ? placeholders through the values array. Multiple statements are disabled.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        values: { type: "array" },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "mysql_disconnect",
    description: "Close the MySQL connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sqlserver_connect",
    description:
      "Connect directly to Microsoft SQL Server using either an encrypted local credentialName or new connection fields. A successful new connection is remembered by default under name or a generated endpoint alias.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        encrypt: { type: "boolean" },
        trustServerCertificate: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_connect_via_ssh",
    description:
      "Connect to SQL Server through SSH. credentialName and sshCredentialName resolve from separate SQL Server and SSH categories. New database details are remembered after success unless remember=false.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        encrypt: { type: "boolean" },
        trustServerCertificate: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_query",
    description:
      "Execute one parameterized T-SQL statement. Use @p1, @p2, etc. placeholders corresponding to the values array. Multiple statements are not permitted.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" }, values: { type: "array" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_disconnect",
    description: "Close the SQL Server connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mongodb_connect",
    description:
      "Connect directly to MongoDB using an encrypted local credentialName or new URI/host credentials. A successful new connection is remembered by default. Saved URI secrets are never shown in activity details.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        uri: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        authSource: { type: "string" },
        tls: { type: "boolean" },
        tlsCA: { type: "string" },
        tlsCertificateKeyFile: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_connect_via_ssh",
    description:
      "Connect to MongoDB through SSH. credentialName and sshCredentialName resolve from separate MongoDB and SSH categories. New database details are remembered after success unless remember=false.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        authSource: { type: "string" },
        tls: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_execute",
    description:
      "Execute a structured MongoDB operation: find, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, countDocuments, or distinct. Arbitrary JavaScript is not supported.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "find",
            "aggregate",
            "insertOne",
            "insertMany",
            "updateOne",
            "updateMany",
            "deleteOne",
            "deleteMany",
            "countDocuments",
            "distinct",
          ],
        },
        collection: { type: "string" },
        filter: { type: "object" },
        document: { type: "object" },
        documents: { type: "array" },
        update: { type: "object" },
        pipeline: { type: "array" },
        field: { type: "string" },
        options: { type: "object" },
      },
      required: ["operation", "collection"],
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_disconnect",
    description: "Close the MongoDB connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_plan",
    description:
      "Update the task checklist using structured step statuses. Use this for multi-step work instead of writing a numbered plan in prose. Every step must declare requires: use an empty array for explanation-only steps; use modify, execute, validate, connect, upload, or download for real runtime obligations. At most one step may be in_progress, and never mark an obligated step completed before its native tool result succeeds.",
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              requires: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "inspect",
                    "modify",
                    "execute",
                    "validate",
                    "connect",
                    "upload",
                    "download",
                  ],
                },
                maxItems: 7,
                description:
                  "Native evidence required for this step. Use [] when no tool side effect is needed.",
              },
            },
            required: ["step", "status", "requires"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "spawn_agent",
    description:
      "Start a background subagent for a self-contained task that can run independently. In planner-executor collaboration, role executor uses the task's configured execution model; otherwise subagents inherit the current model. Workspace and permissions are inherited. Prefer separate files or research areas to avoid edit conflicts. Returns an agent id immediately.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        name: { type: "string" },
        role: { type: "string", enum: ["executor"] },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    description:
      "List direct subagents created by this agent and their current status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "message_agent",
    description:
      "Send an additional instruction to a running direct subagent. It will be applied before that subagent's next model turn.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        message: { type: "string" },
      },
      required: ["agentId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_agent",
    description:
      "Wait for the first selected direct subagent final result, or any direct subagent when agentIds is omitted. Pass every relevant agent id in one call; do not emit one wait call per child in the same turn. A timeout only ends this wait call and never stops the subagent. Completed results include final text, tool summaries, usage, and file changes.",
    parameters: {
      type: "object",
      properties: {
        agentIds: { type: "array", items: { type: "string" } },
        timeoutMs: {
          type: "number",
          description:
            "Wait timeout in milliseconds. Defaults to 60000 and is capped at 60000; all wait_agent calls in one model turn share that 60000 ms budget. Timeout does not stop agents.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stop_agent",
    description:
      "Stop a running direct subagent and return its partial result.",
    parameters: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "mcp_list_tools",
    description:
      "List the tools exposed by a configured MCP server. Use this before calling an external MCP tool so you know its exact name and input schema.",
    parameters: {
      type: "object",
      properties: { server: { type: "string" } },
      required: ["server"],
      additionalProperties: false,
    },
  },
  {
    name: "mcp_call_tool",
    description:
      "Call a tool on a configured Model Context Protocol (MCP) server. The server must be enabled in KCode settings; arguments must match the schema returned by mcp_list_tools.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: `${localShellToolDescription()} Set purpose to modify whenever the command intentionally changes files, database records, configuration, deployments, services, caches, or other durable state. Set it to validate only for a separate deterministic post-change check whose exit code proves the result, and inspect for read-only queries. Prefer browser tools for page interaction, responsive screenshots, and DOM inspection; do not launch a browser from this tool. Use start_process for background services.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        purpose: {
          type: "string",
          enum: ["execute", "inspect", "modify", "validate"],
          description:
            "Structured command purpose. Use modify for an intentional state change, validate only for a separate deterministic pass/fail check, inspect for read-only work, and execute for other commands.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 600_000,
          description:
            "Optional timeout in milliseconds. Defaults to 300000 for build/test/install commands and 120000 otherwise.",
        },
      },
      required: ["command", "purpose"],
      additionalProperties: false,
    },
  },
] as const;

const toolNames = new Set<AgentToolName>(tools.map((tool) => tool.name));
// Accept persisted legacy calls without advertising the unscoped tool.
toolNames.add("credential_save");

export function validCalls(calls: ToolCall[]) {
  for (const call of calls)
    if (!toolNames.has(call.name))
      throw new Error(`模型请求了不支持的工具：${call.name}`);
  return calls;
}
