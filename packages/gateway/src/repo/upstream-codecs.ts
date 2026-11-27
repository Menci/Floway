import { parseStoredJson } from './stored-json.ts';
import { canonicalizeStoredJson } from './upstream-json.ts';
import type { UpstreamModel, ProxyFallbackEntry, UpstreamModelConfig } from '@floway-dev/upstream';
import type { FlagId } from '@floway-dev/upstream/flags';

type RawStoredUpstreamModel = Omit<UpstreamModel, 'enabledFlags'> & {
  enabledFlags: readonly FlagId[];
};

export const decodeUpstreamConfig = (raw: string, id: string): unknown =>
  parseStoredJson<unknown>(raw, `Malformed upstream config JSON for ${id}`);

export const decodeUpstreamState = (raw: string, id: string): unknown =>
  parseStoredJson<unknown>(raw, `Malformed upstream state JSON for ${id}`);

export const decodeUpstreamModel = (raw: string, upstreamId: string): UpstreamModel => {
  const parsed = parseStoredJson<RawStoredUpstreamModel>(raw, `Malformed upstream model JSON for ${upstreamId}`);
  return Object.assign(parsed, { enabledFlags: new Set(parsed.enabledFlags) });
};

export const encodeUpstreamModel = (model: UpstreamModel): string =>
  JSON.stringify(canonicalizeStoredJson(model));

export const decodeUpstreamManualModel = (raw: string, upstreamId: string): UpstreamModelConfig =>
  parseStoredJson<UpstreamModelConfig>(raw, `Malformed upstream manual model JSON for ${upstreamId}`);

export const encodeUpstreamManualModel = (model: UpstreamModelConfig): string =>
  JSON.stringify(canonicalizeStoredJson(model));

export const decodeUpstreamFlagOverrides = (raw: string, id: string): Record<string, boolean> =>
  parseStoredJson<Record<string, boolean>>(raw, `Malformed upstream flag_overrides JSON for ${id}`);

export const decodeDisabledPublicModelIds = (raw: string, id: string): string[] =>
  parseStoredJson<string[]>(raw, `Malformed upstream disabled_public_model_ids JSON for ${id}`);

export const decodeProxyFallbackList = (raw: string, id: string): ProxyFallbackEntry[] =>
  parseStoredJson<ProxyFallbackEntry[]>(raw, `Malformed upstream proxy_fallback_list_json for ${id}`);
