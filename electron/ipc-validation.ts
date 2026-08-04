import { z } from "zod";

export const stateKeySchema = z.literal("tasks");
export const idSchema = z.string().trim().min(1).max(256);
export const optionalIdSchema = idSchema.optional();
export const urlSchema = z.string().trim().min(1).max(8192);
export const workspacePathSchema = z.string().trim().min(1).max(32767);
export const localPathSchema = z.string().trim().min(1).max(32767);
export const browserWidthSchema = z.number().finite().min(200).max(4096);

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
  taskId: z.string().optional(),
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
  contextWindow: z.number().int().positive().optional(),
  agentRole: z.enum(["planner", "executor"]).optional(),
  collaboration: collaborationSchema.optional(),
  agentDepth: z.number().int().min(0).max(2).optional(),
  recoveryContext: z.string().max(20_000).optional(),
});
