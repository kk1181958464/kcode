import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFinalizationFallback } from "./agent";
import { compactOperationEvidenceResult } from "./coding-operation-verification";

test("finalization fallback prioritizes a successful download destination", () => {
  const destination = "D:\\exports\\account session.json";
  const history = [
    {
      kind: "calls" as const,
      calls: [
        {
          id: "download",
          name: "ssh_download_file" as const,
          input: {
            remotePath: "/root/export/account-session.json",
            localPath: destination,
          },
        },
        {
          id: "plan",
          name: "update_plan" as const,
          input: {
            plan: [
              { step: "下载文件", status: "completed", requires: ["download"] },
            ],
          },
        },
      ],
      rawCalls: [],
    },
    compactOperationEvidenceResult("download", "ssh_download_file", true, {
      changed: true,
      path: destination,
      output: "已下载远程文件到本地",
    }),
    compactOperationEvidenceResult("plan", "update_plan", true, {
      output: "计划已更新",
    }),
  ];

  const summary = runtimeFinalizationFallback(history as never, true);

  assert.match(summary, /下载完成：1 个文件已保存到本地/);
  assert.match(
    summary,
    /\[account session\.json\]\(D:\/exports\/account%20session\.json\)/,
  );
  assert.match(summary, /来自 `\/root\/export\/account-session\.json`/);
  assert.doesNotMatch(summary, /实际改动：1 个文件/);
  assert.doesNotMatch(summary, /计划已更新/);
});
