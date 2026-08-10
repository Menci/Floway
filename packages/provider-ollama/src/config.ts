// Ollama upstream — talks to any Ollama-compatible HTTP server: ollama.com
// (the hosted offering) by default, or a self-hosted daemon URL the operator
// supplies. The catalog is discovered live via the Ollama-native /api/tags +
// /api/show endpoints, since the OpenAI-compat /v1/models response strips the
// capability/context-length metadata we need to project a ProviderModel.
//
// Auth is a single optional bearer token: required against ollama.com, often
// omitted on a private daemon, and sent as `Authorization: Bearer <key>` when
// present. Endpoints are fixed — Ollama serves `/v1/chat/completions`,
// `/v1/responses`, `/v1/messages`, and `/v1/audio/transcriptions` natively
// under the same auth — so a
// gateway client can reach the matching upstream endpoint for whichever
// protocol it speaks without going through a translation pair.
//
// `/api/show` does not expose a dedicated transcription capability, so audio
// models reach the catalog only through manual `models[]` entries.
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1909-L1922
//
// A manual `models[]` entry wins over an auto-fetched row carrying the same
// upstream id.

import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { modelsField } from '@floway-dev/provider';

export interface OllamaUpstreamConfig {
  baseUrl: string;
  // Optional: required for ollama.com cloud, typically absent for a private
  // daemon. Sent as `Authorization: Bearer <apiKey>` when set; omitted
  // entirely when blank so an unauthenticated daemon does not reject the
  // request.
  apiKey?: string;
  // Whether this upstream is an Ollama Cloud account whose usage windows the
  // gateway should read. The endpoint that reports them belongs to ollama.com,
  // not to the Ollama binary, and a base URL cannot answer the question on its
  // own: an operator may reach the cloud through their own domain, and a
  // private daemon may sit behind one that looks like anything. So the operator
  // states it, and the dashboard offers the answer for the endpoint they typed.
  cloudUsage: boolean;
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

// Parses an upstream's stored/draft config object. Exported because the
// control plane's usage-probe action receives a config on its own — from an
// edit form that has not been saved yet — and needs the same validation the
// record asserter applies.
export const parseOllamaUpstreamConfig = (config: unknown): OllamaUpstreamConfig => {
  if (!isRecord(config)) throw new Error('Malformed ollama upstream config: config must be an object');

  const apiKey = apiKeyField(config.apiKey);
  const models = modelsField(config.models ?? [], 'ollama');
  if (models.some(model => model.kind === 'rerank')) {
    throw new Error('Malformed ollama upstream config: rerank models require a custom upstream');
  }
  return {
    baseUrl: baseUrlField(config.baseUrl),
    ...(apiKey !== undefined ? { apiKey } : {}),
    cloudUsage: cloudUsageField(config.cloudUsage),
    models,
  };
};

const cloudUsageField = (value: unknown): boolean => {
  // Stored rows carry the flag from `0078_ollama_cloud_usage.sql`, so an absent
  // one is a record built by hand or by an API client that did not ask for
  // usage. It reads as off rather than being inferred from the base URL — the
  // inference is the dashboard's opening answer, not a rule the gateway keeps
  // applying behind the operator.
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error('Malformed ollama upstream config: cloudUsage must be a boolean');
  return value;
};

export const assertOllamaUpstreamRecord = (record: UpstreamRecord): OllamaUpstreamRecord => {
  if (record.kind !== 'ollama') throw new Error(`Expected ollama upstream record, got ${record.kind}`);
  return { ...record, kind: 'ollama', config: parseOllamaUpstreamConfig(record.config) };
};
