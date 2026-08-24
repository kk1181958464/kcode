import { z } from "zod";

export const stateKeySchema = z.enum([
  "tasks",
  "mcpServers",
  "scheduledTasks",
]);
export const idSchema = z.string().trim().min(1).max(256);
export const taskNameSchema = z.string().trim().min(1).max(80);
export const taskIdsSchema = z.array(idSchema).min(1).max(5_000);
export const steerContentSchema = z.string().trim().min(1).max(20_000);
export const optionalIdSchema = idSchema.optional();
export const taskItemPageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    before: idSchema.optional(),
    after: idSchema.optional(),
  })
  .refine((value) => !(value.before && value.after), {
    message: "分页游标不能同时指定 before 和 after",
  });
export const saveTaskOptionsSchema = z.object({
  preserveUnloadedItems: z.boolean().optional(),
});
export const taskRequestIdsSchema = z.array(idSchema).max(100);
export const runtimeEventPageOptionsSchema = z.object({
  requestId: idSchema.optional(),
  afterSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export const urlSchema = z.string().trim().min(1).max(8192);
export const workspacePathSchema = z.string().trim().min(1).max(32767);
export const localPathSchema = z.string().trim().min(1).max(32767);
export const browserWidthSchema = z.number().finite().min(200).max(4096);
export const sshRemoteConnectSchema = z.object({
  taskId: idSchema,
  profileId: idSchema.optional(),
  name: z.string().trim().max(160).optional(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).optional(),
  username: z.string().trim().min(1).max(255),
  rootPath: z.string().trim().max(32_767).optional(),
  authType: z.enum(["password", "private-key"]),
  password: z.string().max(16_384).optional(),
  privateKeyPath: z.string().max(32_767).optional(),
  privateKey: z.string().max(2_000_000).optional(),
  passphrase: z.string().max(16_384).optional(),
  remember: z.boolean().optional(),
});
export const sshRemotePathSchema = z.string().trim().min(1).max(32_767);
export const sshRemoteContentSchema = z.string().max(2_000_000);
export const sshRemoteExpectedContentSchema = sshRemoteContentSchema
  .nullable()
  .optional();

const imageSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataUrl: z.string(),
  size: z.number().nonnegative(),
});

const reasoningEffortSchema = z.enum([
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
]);

const collaborationSchema = z.object({
  mode: z.literal("planner-executor"),
  executor: z.object({
    providerId: idSchema,
    modelId: idSchema,
    displayName: z.string().trim().min(1).max(256),
    reasoningEffort: reasoningEffortSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
  }),
});

export const modelRequestSchema = z.object({
  requestId: idSchema.optional(),
  taskId: idSchema.optional(),
  connectionSessionId: idSchema.optional(),
  providerId: idSchema,
  modelId: idSchema,
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      images: z.array(imageSchema).optional(),
    }),
  ),
  reasoningEffort: reasoningEffortSchema.optional(),
  permissionMode: z.enum(["confirm", "read-only", "full-access"]),
  permissionPolicy: z
    .object({
      workspaceWrite: z.enum(["allow", "confirm", "deny"]),
      deletePaths: z.enum(["allow", "confirm", "deny"]),
      runCommands: z.enum(["allow", "confirm", "deny"]),
      longRunningProcesses: z.enum(["allow", "confirm", "deny"]),
      network: z.enum(["allow", "confirm", "deny"]),
      gitPublish: z.enum(["allow", "confirm", "deny"]),
    })
    .optional(),
  workspacePath: workspacePathSchema,
  remoteWorkspace: z
    .object({
      id: idSchema,
      name: z.string().trim().min(1).max(160),
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65_535),
      username: z.string().trim().min(1).max(255),
      rootPath: sshRemotePathSchema,
      authType: z.enum(["password", "private-key"]),
      hostFingerprint: z.string().trim().min(1).max(512).optional(),
      remembered: z.boolean(),
    })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  agentRole: z.enum(["planner", "executor"]).optional(),
  collaboration: collaborationSchema.optional(),
  agentDepth: z.number().int().min(0).max(2).optional(),
  recoveryContext: z.string().max(20_000).optional(),
});
