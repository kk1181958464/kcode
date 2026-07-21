import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  directory: string;
};

const FRONTEND_DESIGN_TERMS = [
  /\b(frontend|front-end|ui|ux|css|scss|tailwind|styled-components)\b/i,
  /\b(page|website|landing page|dashboard|component|design system|visual|redesign|modernize|polish)\b/i,
  /界面|页面|前端|样式|配色|按钮|布局|动效|动画|主题|视觉|设计系统|响应式|美化|好看|现代化|外观|重做/,
];

const skillCache = new Map<
  string,
  { modifiedAt: number; skills: AgentSkill[] }
>();
let configuredUserSkillsRoot: string | undefined;
let configuredStateFile: string | undefined;

export function configureAgentSkills(options: {
  userSkillsRoot: string;
  stateFile: string;
}) {
  configuredUserSkillsRoot = options.userSkillsRoot;
  configuredStateFile = options.stateFile;
  skillCache.clear();
}

export function clearAgentSkillCache() {
  skillCache.clear();
}

function parseFrontmatter(
  source: string,
  directory: string,
): AgentSkill | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return undefined;
  let metadata: { name?: unknown; description?: unknown };
  try {
    metadata = parseYaml(match[1]) as typeof metadata;
  } catch {
    return undefined;
  }
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;
  const description =
    typeof metadata?.description === "string"
      ? metadata.description
      : undefined;
  const instructions = match[2].trim();
  if (!name || !description || !instructions) return undefined;
  return {
    id: path.basename(directory),
    name,
    description,
    instructions,
    directory,
  };
}

export async function loadSkillsFromDirectory(
  root: string,
): Promise<AgentSkill[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const skillFiles = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "SKILL.md"));
    const modifiedAt = Math.max(
      0,
      ...(await Promise.all(
        skillFiles.map(async (file) => {
          try {
            return (await stat(file)).mtimeMs;
          } catch {
            return 0;
          }
        }),
      )),
    );
    const cached = skillCache.get(root);
    if (cached?.modifiedAt === modifiedAt) return cached.skills;
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const directory = path.join(root, entry.name);
          try {
            return parseFrontmatter(
              await readFile(path.join(directory, "SKILL.md"), "utf8"),
              directory,
            );
          } catch {
            return undefined;
          }
        }),
    );
    const loaded = skills.filter((skill): skill is AgentSkill =>
      Boolean(skill),
    );
    skillCache.set(root, { modifiedAt, skills: loaded });
    return loaded;
  } catch {
    return [];
  }
}

export function skillMatchesRequest(skill: AgentSkill, request: string) {
  if (skill.name === "frontend-design")
    return FRONTEND_DESIGN_TERMS.some((term) => term.test(request));
  const words = `${skill.name} ${skill.description}`
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((word) => word.length >= 3);
  const normalized = request.toLowerCase();
  return words.some((word) => normalized.includes(word));
}

function skillRootCandidates() {
  const candidates = [path.join(process.cwd(), "skills")];
  if (process.resourcesPath)
    candidates.unshift(path.join(process.resourcesPath, "skills"));
  if (configuredUserSkillsRoot) candidates.unshift(configuredUserSkillsRoot);
  return [...new Set(candidates)];
}

async function disabledSkillIds() {
  if (!configuredStateFile) return new Set<string>();
  try {
    const state = JSON.parse(await readFile(configuredStateFile, "utf8")) as {
      enabled?: Record<string, boolean>;
    };
    return new Set(
      Object.entries(state.enabled ?? {})
        .filter(([, enabled]) => enabled === false)
        .map(([id]) => id),
    );
  } catch {
    return new Set<string>();
  }
}

export async function loadActiveSkillInstructions(request: string) {
  const disabled = await disabledSkillIds();
  const skillsByName = new Map<string, AgentSkill>();
  for (const root of skillRootCandidates()) {
    try {
      await access(root);
    } catch {
      continue;
    }
    const skills = await loadSkillsFromDirectory(root);
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  return [...skillsByName.values()]
    .filter(
      (skill) => !disabled.has(skill.id) && skillMatchesRequest(skill, request),
    )
    .map(
      (skill) =>
        `<agent_skill name="${skill.name}">\n${skill.instructions}\n</agent_skill>`,
    )
    .join("\n\n");
}
