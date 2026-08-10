import assert from "node:assert/strict";
import test from "node:test";
import {
  executorModelOverrides,
  isPlannerCoordinator,
  plannerCollaborationInstruction,
  plannerToolAllowed,
  remoteWorkspaceToolAllowed,
} from "./collaboration";
import type { ModelRequest } from "../src/types";

const request: ModelRequest = {
  providerId: "planner-provider",
  modelId: "gpt-5.6-sol",
  messages: [],
  permissionMode: "full-access",
  workspacePath: "D:\\project\\demo",
  agentRole: "planner",
  collaboration: {
    mode: "planner-executor",
    executor: {
      providerId: "executor-provider",
      modelId: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      reasoningEffort: "high",
      contextWindow: 353_400,
    },
  },
};

test("recognizes planner coordination and restricts mutation tools", () => {
  assert.equal(isPlannerCoordinator(request), true);
  assert.equal(plannerToolAllowed("read_file"), true);
  assert.equal(plannerToolAllowed("search_code"), true);
  assert.equal(plannerToolAllowed("spawn_agent"), true);
  assert.equal(plannerToolAllowed("wait_agent"), true);
  assert.equal(plannerToolAllowed("apply_patch"), false);
  assert.equal(plannerToolAllowed("run_command"), false);
  assert.equal(plannerToolAllowed("ssh_write_file"), false);
  assert.equal(plannerToolAllowed("ssh_set_workspace"), false);
  assert.equal(plannerToolAllowed("ssh_read_file"), false);
  assert.equal(plannerToolAllowed("ssh_read_file", true), true);
  assert.equal(plannerToolAllowed("ssh_list_directory", true), true);
  assert.equal(plannerToolAllowed("ssh_run", true), false);
});

test("managed SSH Remote tasks keep local workspace tools in hybrid mode", () => {
  // Hybrid mode: local file/git/command tools stay available alongside ssh_*
  // so the agent can build local sources and deploy to the remote server.
  assert.equal(remoteWorkspaceToolAllowed("read_file"), true);
  assert.equal(remoteWorkspaceToolAllowed("write_file"), true);
  assert.equal(remoteWorkspaceToolAllowed("apply_patch"), true);
  assert.equal(remoteWorkspaceToolAllowed("run_command"), true);
  assert.equal(remoteWorkspaceToolAllowed("list_directory"), true);
  assert.equal(remoteWorkspaceToolAllowed("git_status"), true);
  assert.equal(remoteWorkspaceToolAllowed("ssh_connect"), true);
  assert.equal(remoteWorkspaceToolAllowed("ssh_read_file"), true);
  assert.equal(remoteWorkspaceToolAllowed("ssh_write_file"), true);
  assert.equal(remoteWorkspaceToolAllowed("ssh_run"), true);
  assert.equal(remoteWorkspaceToolAllowed("web_search"), true);
  // Managed-session control + via_ssh tunnels stay disabled to protect recovery.
  assert.equal(remoteWorkspaceToolAllowed("ssh_set_workspace"), false);
  assert.equal(remoteWorkspaceToolAllowed("ssh_disconnect"), false);
  assert.equal(remoteWorkspaceToolAllowed("mysql_connect_via_ssh"), false);
});

test("routes an executor subagent to its configured model", () => {
  assert.deepEqual(executorModelOverrides(request), {
    providerId: "executor-provider",
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    reasoningEffort: "high",
    contextWindow: 353_400,
    agentRole: "executor",
    collaboration: undefined,
  });
  assert.match(plannerCollaborationInstruction(request), /GPT-5\.6 Luna/);
  assert.match(plannerCollaborationInstruction(request), /spawn_agent/);
});

test("keeps ordinary and executor requests on their current model", () => {
  assert.equal(
    executorModelOverrides({ ...request, agentRole: "executor" }),
    undefined,
  );
  assert.equal(
    plannerCollaborationInstruction({ ...request, collaboration: undefined }),
    "",
  );
});
