import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadActiveSkillInstructions,
  loadSkillsFromDirectory,
  configureAgentSkills,
  skillMatchesRequest,
} from "./agent-skills";

test("loads valid Agent Skills and ignores malformed folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-skills-"));
  try {
    const valid = path.join(root, "frontend-design");
    const invalid = path.join(root, "invalid");
    await mkdir(valid);
    await mkdir(invalid);
    await writeFile(
      path.join(valid, "SKILL.md"),
      "---\nname: frontend-design\ndescription: Design frontend interfaces.\n---\n# Instructions\nBuild intentionally.\n",
    );
    await writeFile(path.join(invalid, "SKILL.md"), "missing frontmatter");

    const skills = await loadSkillsFromDirectory(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "frontend-design");
    assert.match(skills[0].instructions, /Build intentionally/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads user-installed skills and respects disabled state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-user-skills-"));
  const userSkillsRoot = path.join(root, "skills");
  const stateFile = path.join(root, "state.json");
  try {
    await mkdir(path.join(userSkillsRoot, "database-review"), {
      recursive: true,
    });
    await writeFile(
      path.join(userSkillsRoot, "database-review", "SKILL.md"),
      "---\nname: database-review\ndescription: Review database schemas and SQL queries.\n---\nCheck indexes before changing queries.\n",
    );
    configureAgentSkills({ userSkillsRoot, stateFile });
    assert.match(
      await loadActiveSkillInstructions("review this database query"),
      /database-review/,
    );
    await writeFile(
      stateFile,
      JSON.stringify({ installed: {}, enabled: { "database-review": false } }),
    );
    assert.equal(
      await loadActiveSkillInstructions("review this database query"),
      "",
    );
  } finally {
    configureAgentSkills({ userSkillsRoot: "", stateFile: "" });
    await rm(root, { recursive: true, force: true });
  }
});

test("activates frontend-design only for visual frontend work", () => {
  const skill = {
    id: "frontend-design",
    name: "frontend-design",
    description: "Design frontend interfaces.",
    instructions: "Build intentionally.",
    directory: "skills/frontend-design",
  };
  assert.equal(skillMatchesRequest(skill, "重新设计页面配色和按钮动画"), true);
  assert.equal(
    skillMatchesRequest(skill, "Build a responsive dashboard UI"),
    true,
  );
  assert.equal(skillMatchesRequest(skill, "把整个应用美化得现代一点"), true);
  assert.equal(skillMatchesRequest(skill, "查询 MySQL 中的用户记录"), false);
  assert.equal(skillMatchesRequest(skill, "连接 SSH 服务器并查看日志"), false);
});

test("injects the bundled frontend-design skill only for matching requests", async () => {
  const frontend =
    await loadActiveSkillInstructions("重新设计页面配色、按钮和过渡动画");
  const backend =
    await loadActiveSkillInstructions("连接 SSH 服务器并查看日志");
  assert.match(frontend, /<agent_skill name="frontend-design">/);
  assert.match(frontend, /# Frontend Design/);
  assert.equal(backend, "");
});
