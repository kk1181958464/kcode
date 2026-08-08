export type ConfigLayerName =
  "defaults" | "system" | "user" | "project" | "task" | "session";

export type ConfigLayer<T extends Record<string, unknown>> = {
  name: ConfigLayerName;
  values: Partial<T>;
  version?: string;
};

export type EffectiveConfig<T extends Record<string, unknown>> = {
  value: Partial<T>;
  origins: Partial<Record<keyof T, ConfigLayerName>>;
  versions: Partial<Record<ConfigLayerName, string>>;
};

export function resolveLayeredConfig<T extends Record<string, unknown>>(
  layers: readonly ConfigLayer<T>[],
): EffectiveConfig<T> {
  const value: Partial<T> = {};
  const origins: Partial<Record<keyof T, ConfigLayerName>> = {};
  const versions: Partial<Record<ConfigLayerName, string>> = {};
  for (const layer of layers) {
    if (layer.version) versions[layer.name] = layer.version;
    for (const [key, item] of Object.entries(layer.values)) {
      if (item === undefined) continue;
      (value as Record<string, unknown>)[key] = item;
      (origins as Record<string, ConfigLayerName>)[key] = layer.name;
    }
  }
  return { value, origins, versions };
}

export function configLayerFingerprint(value: unknown) {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, stable(child)]),
      );
    return item;
  };
  return JSON.stringify(stable(value));
}
