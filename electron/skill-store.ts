import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SKILL_REGISTRY_URL =
  "https://raw.githubusercontent.com/kk1181958464/kcode/main/skills/registry.json";

export type RegistryFile = {
  path: string;
  url: string;
  sha256?: string;
};

export type RegistrySkill = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  repository?: string;
  categories?: string[];
  verified?: boolean;
  hasScripts?: boolean;
  files: RegistryFile[];
  [key: string]: unknown;
};

export type SkillRegistry = {
  skills: RegistrySkill[];
};

export type InstalledSkill = {
  id: string;
  version?: string;
  installedAt: string;
};

export type SkillStoreState = {
  installed: Record<string, InstalledSkill>;
  enabled: Record<string, boolean>;
};

export type ListedSkill = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  repository?: string;
  categories: string[];
  verified: boolean;
  hasScripts: boolean;
  available: boolean;
  bundled: boolean;
  installed: boolean;
  enabled: boolean;
  directory?: string;
};

export type SkillStoreFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "arrayBuffer">>;

export type CreateSkillStoreOptions = {
  userSkillsRoot: string;
  stateFile: string;
  bundledSkillsRoot?: string;
  bundledRegistryPath?: string;
  registryUrl?: string;
  fetchImpl?: SkillStoreFetch;
  registryTimeoutMs?: number;
};

const emptyState = (): SkillStoreState => ({ installed: {}, enabled: {} });
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 100;

function validateSkillId(id: string) {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    path.posix.basename(id) !== id ||
    path.win32.basename(id) !== id ||
    path.win32.isAbsolute(id)
  )
    throw new Error(`Invalid skill id: ${id}`);
}

function safeRelativeFile(file: string) {
  if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
    throw new Error(`Invalid skill file path: ${file}`);
  const parts = file.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`Invalid skill file path: ${file}`);
  return parts.join(path.sep);
}

function parseRegistry(value: unknown): SkillRegistry {
  const skills = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as SkillRegistry).skills)
      ? (value as SkillRegistry).skills
      : undefined;
  if (!skills) throw new Error("Invalid skill registry");
  for (const skill of skills) {
    if (!skill || typeof skill !== "object")
      throw new Error("Invalid registry skill");
    validateSkillId(skill.id);
    if (!Array.isArray(skill.files))
      throw new Error(`Skill ${skill.id} must declare files`);
    if (skill.categories !== undefined && !Array.isArray(skill.categories))
      throw new Error(`Skill ${skill.id} has invalid categories`);
    if (
      (skill.categories as unknown[] | undefined)?.some(
        (category: unknown) => typeof category !== "string",
      )
    )
      throw new Error(`Skill ${skill.id} has invalid categories`);
  }
  return { skills };
}

async function directoryNames(root?: string) {
  if (!root) return [];
  try {
    const entries = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
    const valid = await Promise.all(
      entries.map(async (entry) => {
        try {
          await access(path.join(root, entry.name, "SKILL.md"));
          return entry.name;
        } catch {
          return undefined;
        }
      }),
    );
    return valid.filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

export function createSkillStore(options: CreateSkillStoreOptions) {
  const registryUrl = options.registryUrl ?? DEFAULT_SKILL_REGISTRY_URL;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as SkillStoreFetch);
  const registryTimeoutMs = options.registryTimeoutMs ?? 5_000;
  let registryCache: Promise<SkillRegistry> | undefined;

  async function readState(): Promise<SkillStoreState> {
    try {
      const parsed = JSON.parse(
        await readFile(options.stateFile, "utf8"),
      ) as Partial<SkillStoreState>;
      return {
        installed:
          parsed.installed && typeof parsed.installed === "object"
            ? parsed.installed
            : {},
        enabled:
          parsed.enabled && typeof parsed.enabled === "object"
            ? parsed.enabled
            : {},
      };
    } catch {
      return emptyState();
    }
  }

  async function writeState(state: SkillStoreState) {
    await mkdir(path.dirname(options.stateFile), { recursive: true });
    const temporary = `${options.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rm(options.stateFile, { force: true });
    await rename(temporary, options.stateFile);
  }

  async function loadBundledRegistry() {
    if (!options.bundledRegistryPath) return { skills: [] };
    try {
      return parseRegistry(
        JSON.parse(await readFile(options.bundledRegistryPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { skills: [] };
      throw error;
    }
  }

  function mergeRegistries(
    bundled: SkillRegistry,
    remote: SkillRegistry,
  ): SkillRegistry {
    const skills = new Map(
      bundled.skills.map((skill) => [skill.id, skill] as const),
    );
    for (const skill of remote.skills) skills.set(skill.id, skill);
    return { skills: [...skills.values()] };
  }

  async function loadRegistry(fetchRemote = false) {
    if (!fetchRemote) return loadBundledRegistry();
    if (!registryCache) {
      registryCache = (async () => {
        try {
          const response = await fetchImpl(registryUrl, {
            cache: "no-store",
            signal: AbortSignal.timeout(registryTimeoutMs),
          });
          if (!response.ok)
            throw new Error(`Registry returned ${response.status}`);
          return mergeRegistries(
            await loadBundledRegistry(),
            parseRegistry(await response.json()),
          );
        } catch (remoteError) {
          if (!options.bundledRegistryPath) throw remoteError;
          return loadBundledRegistry();
        }
      })();
      registryCache.catch(() => {
        registryCache = undefined;
      });
    }
    return registryCache;
  }

  async function list(fetchRemote = false): Promise<ListedSkill[]> {
    const [registry, bundledIds, userIds, state] = await Promise.all([
      loadRegistry(fetchRemote),
      directoryNames(options.bundledSkillsRoot),
      directoryNames(options.userSkillsRoot),
      readState(),
    ]);
    const byId = new Map<string, ListedSkill>();
    for (const skill of registry.skills) {
      byId.set(skill.id, {
        id: skill.id,
        name: skill.name ?? skill.id,
        description: skill.description,
        version: skill.version,
        author: skill.author,
        license: skill.license,
        repository: skill.repository,
        categories: skill.categories ?? [],
        verified: Boolean(skill.verified),
        hasScripts: Boolean(skill.hasScripts),
        available: true,
        bundled: false,
        installed: false,
        enabled: state.enabled[skill.id] !== false,
      });
    }
    for (const id of bundledIds) {
      const current = byId.get(id);
      byId.set(id, {
        id,
        name: current?.name ?? id,
        description: current?.description,
        version: current?.version,
        author: current?.author,
        license: current?.license,
        repository: current?.repository,
        categories: current?.categories ?? [],
        verified: current?.verified ?? true,
        hasScripts: current?.hasScripts ?? false,
        available: current?.available ?? false,
        bundled: true,
        installed: true,
        enabled: state.enabled[id] !== false,
        directory: path.join(options.bundledSkillsRoot!, id),
      });
    }
    for (const id of userIds) {
      const current = byId.get(id);
      byId.set(id, {
        id,
        name: current?.name ?? id,
        description: current?.description,
        version: state.installed[id]?.version ?? current?.version,
        author: current?.author,
        license: current?.license,
        repository: current?.repository,
        categories: current?.categories ?? [],
        verified: current?.verified ?? false,
        hasScripts: current?.hasScripts ?? false,
        available: current?.available ?? false,
        bundled: current?.bundled ?? false,
        installed: true,
        enabled: state.enabled[id] !== false,
        directory: path.join(options.userSkillsRoot, id),
      });
    }
    return [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async function install(id: string) {
    validateSkillId(id);
    const skill = (await loadRegistry(true)).skills.find(
      (candidate) => candidate.id === id,
    );
    if (!skill) throw new Error(`Skill not found in registry: ${id}`);
    if (!skill.files.length) throw new Error(`Skill ${id} has no files`);
    if (skill.files.length > MAX_SKILL_FILES)
      throw new Error(`Skill ${id} declares too many files`);

    const files = skill.files.map((file) => ({
      ...file,
      safePath: safeRelativeFile(file.path),
    }));
    if (!files.some((file) => file.path.replace(/\\/g, "/") === "SKILL.md"))
      throw new Error(`Skill ${id} must include SKILL.md`);
    for (const file of files) {
      if (typeof file.url !== "string" || !file.url)
        throw new Error(`Skill ${id} has an invalid file URL`);
      const fileUrl = new URL(file.url);
      if (fileUrl.protocol !== "https:" || fileUrl.username || fileUrl.password)
        throw new Error(`Skill ${id} file URLs must use HTTPS`);
      if (file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256))
        throw new Error(`Skill ${id} has an invalid sha256`);
    }

    await mkdir(options.userSkillsRoot, { recursive: true });
    const stagingRoot = await mkdtemp(
      path.join(options.userSkillsRoot, ".install-"),
    );
    const stagedSkill = path.join(stagingRoot, id);
    const target = path.join(options.userSkillsRoot, id);
    const backup = path.join(
      options.userSkillsRoot,
      `.backup-${id}-${Date.now()}`,
    );
    let backedUp = false;
    let promoted = false;
    let totalBytes = 0;
    try {
      await mkdir(stagedSkill);
      for (const file of files) {
        const response = await fetchImpl(file.url, { cache: "no-store" });
        if (!response.ok)
          throw new Error(
            `Failed to download ${file.path}: ${response.status}`,
          );
        const content = Buffer.from(await response.arrayBuffer());
        if (content.length > MAX_SKILL_FILE_BYTES)
          throw new Error(`Skill file is too large: ${file.path}`);
        totalBytes += content.length;
        if (totalBytes > MAX_SKILL_TOTAL_BYTES)
          throw new Error(`Skill ${id} exceeds the download size limit`);
        if (file.sha256) {
          const actual = createHash("sha256").update(content).digest("hex");
          if (actual.toLowerCase() !== file.sha256.toLowerCase())
            throw new Error(`sha256 mismatch for ${file.path}`);
        }
        const destination = path.join(stagedSkill, file.safePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      await access(path.join(stagedSkill, "SKILL.md"));
      try {
        await rename(target, backup);
        backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(stagedSkill, target);
      promoted = true;
      const state = await readState();
      state.installed[id] = {
        id,
        version: skill.version,
        installedAt: new Date().toISOString(),
      };
      if (!(id in state.enabled)) state.enabled[id] = true;
      await writeState(state);
      if (backedUp)
        await rm(backup, { recursive: true, force: true }).catch(
          () => undefined,
        );
      return (await list()).find((entry) => entry.id === id)!;
    } catch (error) {
      if (promoted) await rm(target, { recursive: true, force: true });
      if (backedUp) {
        await rename(backup, target).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async function uninstall(id: string) {
    validateSkillId(id);
    const target = path.join(options.userSkillsRoot, id);
    try {
      await access(target);
    } catch {
      throw new Error(`User-installed skill not found: ${id}`);
    }
    await rm(target, { recursive: true });
    const state = await readState();
    delete state.installed[id];
    delete state.enabled[id];
    await writeState(state);
    return list();
  }

  async function setEnabled(id: string, enabled: boolean) {
    validateSkillId(id);
    const skills = await list();
    if (!skills.some((skill) => skill.id === id))
      throw new Error(`Skill not found: ${id}`);
    const state = await readState();
    state.enabled[id] = enabled;
    await writeState(state);
    return (await list()).find((skill) => skill.id === id)!;
  }

  return {
    list,
    install,
    uninstall,
    enable: (id: string) => setEnabled(id, true),
    disable: (id: string) => setEnabled(id, false),
    refresh: () => {
      registryCache = undefined;
    },
  };
}

export type SkillStore = ReturnType<typeof createSkillStore>;
