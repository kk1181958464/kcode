import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ModelConfig, ProviderConfig } from "../types";
import { previewProviders } from "../lib/model-utils";

export interface ModelEntry {
  provider: ProviderConfig;
  model: ModelConfig;
}

export interface ProvidersState {
  providers: ProviderConfig[];
  setProviders(value: ProviderConfig[]): void;
  models: ModelEntry[];
}

const ProvidersCtx = createContext<ProvidersState | null>(null);

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  useEffect(() => {
    if (!window.kcode) {
      setProviders(previewProviders);
      return;
    }
    window.kcode.providers.list().then(setProviders);
  }, []);

  const models = useMemo<ModelEntry[]>(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [providers],
  );

  return (
    <ProvidersCtx.Provider value={{ providers, setProviders, models }}>
      {children}
    </ProvidersCtx.Provider>
  );
}

export function useProviders(): ProvidersState {
  const context = useContext(ProvidersCtx);
  if (!context)
    throw new Error("useProviders must be used within a ProvidersProvider");
  return context;
}
