import type { Flag, FlagOverrides } from "@floway-dev/provider/flags";

import type {
  BackoffRow,
  CustomRawModel,
  ModelEndpoints,
  ProxyRecord,
  UpstreamModelConfig,
  UpstreamProviderKind,
  UpstreamRecord,
  UpstreamRecordEnvelope,
} from "../../api/types";
import { authFetch, callApi, getCurrentSession } from "../../api/auth";

export interface RuntimeInfo {
  kind: "node" | "cloudflare";
  runtimeLocation: string;
}

export interface EditorAuxData {
  flags: Flag[];
  proxies: ProxyRecord[];
  backoffs: BackoffRow[];
  runtime: RuntimeInfo;
  upstreams: UpstreamRecord[];
}

export interface UpstreamEditorLoaderData extends EditorAuxData {
  mode: "create" | "edit";
  record: UpstreamRecord;
  nextSortOrder: number;
}

export interface UpstreamEditorValues {
  name: string;
  enabled: boolean;
  color: UpstreamRecord["color"];
  proxyFallbackList: UpstreamRecord["proxy_fallback_list"];
  modelPrefix: UpstreamRecord["model_prefix"];
  disabledPublicModelIds: string[];
  flagOverrides: UpstreamRecord["flag_overrides"];
  config: UpstreamRecord["config"];
  state: UpstreamRecord["state"];
  manualModels: UpstreamModelConfig[];
}

// Compatibility for records written before Floway commit 5289ba35 (2026-06-25).
// That backend change renamed this flag without a SQL data migration: repository
// reads still return the old key, while PATCH validation rejects it as unknown.
// Keep this narrow alias at the editor boundary until deployed gateways migrate
// their stored upstream- and model-level overrides; do not turn it into a generic
// unknown-flag filter, because silently dropping operator settings is unsafe.
const LEGACY_FLAG_ID_ALIASES = {
  "downgrade-developer-role": "demote-developer-to-system",
} as const;

export function migrateLegacyFlagOverrides(
  value: FlagOverrides | Readonly<Record<string, boolean>>,
): FlagOverrides {
  const migrated = { ...value } as Record<string, boolean>;
  for (const [legacyId, currentId] of Object.entries(LEGACY_FLAG_ID_ALIASES)) {
    if (legacyId in migrated && !(currentId in migrated)) migrated[currentId] = migrated[legacyId]!;
    delete migrated[legacyId];
  }
  return migrated as FlagOverrides;
}

export const providerKinds: readonly UpstreamProviderKind[] = [
  "custom", "azure", "copilot", "codex", "claude-code", "ollama",
];

export const providerDefaultName: Record<UpstreamProviderKind, string> = {
  custom: "Custom upstream",
  azure: "Azure AI",
  copilot: "GitHub Copilot",
  codex: "ChatGPT Codex",
  "claude-code": "Claude Code",
  ollama: "Ollama",
};

export async function requireAdmin() {
  const session = await getCurrentSession();
  return !session.error && session.data.user.isAdmin;
}

export async function loadEditorAux(): Promise<EditorAuxData> {
  const [flags, proxies, backoffs, runtime, upstreams] = await Promise.all([
    callApi<Flag[]>(() => authFetch("/api/upstreams/flags")),
    callApi<ProxyRecord[]>(() => authFetch("/api/proxies")),
    callApi<BackoffRow[]>(() => authFetch("/api/proxies/backoffs")),
    callApi<RuntimeInfo>(() => authFetch("/api/runtime-info")),
    callApi<UpstreamRecord[]>(() => authFetch("/api/upstreams")),
  ]);
  const error = flags.error ?? proxies.error ?? backoffs.error ?? runtime.error ?? upstreams.error;
  if (error) throw new Error(error.message);
  return {
    flags: flags.data!,
    proxies: proxies.data!,
    backoffs: backoffs.data!,
    runtime: runtime.data!,
    upstreams: upstreams.data!,
  };
}

export function valuesFromRecord(record: UpstreamRecord): UpstreamEditorValues {
  const config: UpstreamRecord["config"] = record.kind === "custom"
    ? {
        ...structuredClone(record.config),
        apiKey: "",
        ...(record.id === "" && Object.keys(record.config.endpoints).length === 0
          ? { endpoints: { chatCompletions: {} }, modelsFetch: { ...record.config.modelsFetch, enabled: true } }
          : {}),
      }
    : record.kind === "azure"
      ? { ...structuredClone(record.config), apiKey: "" }
      : record.kind === "ollama"
        ? { ...structuredClone(record.config), apiKey: "" }
        : structuredClone(record.config);
  const manualModels = record.kind === "custom" || record.kind === "azure" || record.kind === "ollama"
    ? structuredClone(record.config.models).map((model) => model.flagOverrides
      ? { ...model, flagOverrides: migrateLegacyFlagOverrides(model.flagOverrides) }
      : model)
    : [];
  return {
    name: record.name,
    enabled: record.enabled,
    color: record.color,
    proxyFallbackList: structuredClone(record.proxy_fallback_list),
    modelPrefix: structuredClone(record.model_prefix),
    disabledPublicModelIds: [...record.disabled_public_model_ids],
    flagOverrides: migrateLegacyFlagOverrides(record.flag_overrides),
    config,
    state: structuredClone(record.state),
    manualModels,
  };
}

export function configFromValues(
  record: UpstreamRecord,
  values: UpstreamEditorValues,
  options: { preserveStoredSecret?: boolean } = {},
): unknown {
  const config = structuredClone(values.config) as unknown as Record<string, unknown>;
  if (record.kind === "custom" || record.kind === "azure" || record.kind === "ollama") {
    config.models = structuredClone(values.manualModels);
    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (apiKey) config.apiKey = apiKey;
    else if (options.preserveStoredSecret && "apiKey" in record.config && record.config.apiKey) {
      config.apiKey = record.config.apiKey;
    } else delete config.apiKey;
  }
  if (record.kind === "custom") {
    const custom = config as Record<string, unknown>;
    if (custom.authStyle === "none") delete custom.apiKey;
    if (custom.pathOverrides && typeof custom.pathOverrides === "object") {
      const entries = Object.entries(custom.pathOverrides as Record<string, string>)
        .map(([key, value]) => [key, typeof value === "string" ? value.trim() : ""] as const)
        .filter(([, value]) => value.length > 0);
      if (entries.length) custom.pathOverrides = Object.fromEntries(entries);
      else delete custom.pathOverrides;
    }
  }
  return config;
}

export function previewRecord(record: UpstreamRecord, values: UpstreamEditorValues): UpstreamRecordEnvelope {
  return {
    ...record,
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    config: configFromValues(record, values, { preserveStoredSecret: true }),
    state: values.state,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    disabled_public_model_ids: values.disabledPublicModelIds,
    flag_overrides: values.flagOverrides,
  };
}

export function createBody(record: UpstreamRecord, values: UpstreamEditorValues, sortOrder: number) {
  return {
    kind: record.kind,
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    sort_order: sortOrder,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    config: configFromValues(record, values),
    ...((record.kind === "copilot" || record.kind === "codex" || record.kind === "claude-code")
      ? { state: values.state }
      : {}),
  };
}

export function updateBody(record: UpstreamRecord, values: UpstreamEditorValues) {
  return {
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    ...((record.kind === "custom" || record.kind === "azure" || record.kind === "ollama")
      ? { config: configFromValues(record, values) }
      : {}),
  };
}

export function discoveredModelsFromResponse(
  kind: UpstreamProviderKind,
  data: UpstreamModelConfig[] | CustomRawModel[],
  endpoints: ModelEndpoints,
): UpstreamModelConfig[] {
  if (kind !== "custom") return data as UpstreamModelConfig[];
  return (data as CustomRawModel[]).map((model) => {
    const modelEndpoints: ModelEndpoints = model.kind === "embedding"
      ? { embeddings: {} }
      : model.kind === "image"
        ? { imagesGenerations: {}, imagesEdits: {} }
        : Object.keys(endpoints).length ? structuredClone(endpoints) : { chatCompletions: {} };
    return {
      upstreamModelId: model.id,
      publicModelId: model.id,
      kind: model.kind ?? "chat",
      endpoints: modelEndpoints,
      ...(model.display_name ?? model.name ? { display_name: model.display_name ?? model.name } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
      ...(model.pricing ? { pricing: model.pricing } : {}),
    };
  });
}

export const publicModelId = (model: UpstreamModelConfig) => {
  const publicId = typeof model.publicModelId === "string" ? model.publicModelId.trim() : "";
  if (publicId) return publicId;
  return typeof model.upstreamModelId === "string" ? model.upstreamModelId : "";
};
