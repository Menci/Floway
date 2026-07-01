// Ollama upstream — talks to any Ollama-compatible HTTP server: ollama.com
// (the hosted offering) by default, or a self-hosted daemon URL the operator
// supplies. The catalog is discovered live via the Ollama-native /api/tags +
// /api/show endpoints, since the OpenAI-compat /v1/models response strips the
// capability/context-length metadata we need to project a ProviderModel.
//
// Auth is a single optional bearer token: required against ollama.com, often
// omitted on a private daemon, and sent as `Authorization: Bearer <key>` when
// present. Endpoints are fixed — Ollama serves `/v1/chat/completions`,
// `/v1/responses`, and `/v1/messages` natively under the same auth — so a
// gateway client can reach the matching upstream endpoint for whichever
// protocol it speaks without going through a translation pair.
//
// Operators can pin per-model overrides via `models[]`; auto-fetched and
// manual entries merge the same way as the custom provider (manual wins on
// id collision).

import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { modelsField } from '@floway-dev/provider';

export interface OllamaUpstreamConfig {
  baseUrl: string;
  // Optional: required for ollama.com cloud, typically absent for a private
  // daemon. Sent as `Authorization: Bearer <apiKey>` when set; omitted
  // entirely when blank so an unauthenticated daemon does not reject the
  // request.
  apiKey?: string;
  models: UpstreamModelConfig[];
}

export type OllamaUpstreamRecord = UpstreamRecord & {
  kind: 'ollama';
  config: OllamaUpstreamConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed ollama upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed ollama upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

const apiKeyField = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Malformed ollama upstream config: apiKey must be a string');
  return value;
};

export const assertOllamaUpstreamRecord = (record: UpstreamRecord): OllamaUpstreamRecord => {
  if (record.kind !== 'ollama') throw new Error(`Expected ollama upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed ollama upstream config: config must be an object');

  const apiKey = apiKeyField(record.config.apiKey);
  return {
    ...record,
    kind: 'ollama',
    config: {
      baseUrl: baseUrlField(record.config.baseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      models: modelsField(record.config.models ?? [], 'ollama'),
    },
  };
};
