// Ollama catalog discovery. Ollama exposes two relevant endpoints:
//   GET  /api/tags          → enumerates installed/hosted models with a
//                             short metadata blob ({name, modified_at, ...}).
//                             The cloud variant leaves the `details` sub-object
//                             empty, so this call alone does not reveal model
//                             capabilities or context length.
//   POST /api/show {name}   → returns the per-model `capabilities` array
//                             (`completion`/`tools`/`thinking`/`vision`/
//                             `embedding`) and the `model_info` map (keyed by
//                             a varying-per-architecture prefix that carries
//                             `<arch>.context_length`).
//
// We fetch /api/show through a bounded pool and synthesize the per-model shape
// the gateway consumes. /api/show calls are independent and read-only; a
// single failure drops just that model from the catalog, while cancellation
// terminates the catalog request so a partial result cannot enter the cache.
//
// /api/embeddings (legacy) is not used — the modern Ollama embedding path is
// /api/embed for native callers and /v1/embeddings for the OpenAI shim.

import type { OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchShow, ollamaFetchTags } from './fetch.ts';
import { fetchUpstreamModels, type Fetcher, identityWrapUpstreamCall, isAbortError, ProviderModelsUnavailableError, readBoundedJsonResponse, runProviderModelsTask } from '@floway-dev/provider';

const MAX_CONCURRENT_SHOW_REQUESTS = 8;
const MAX_SHOW_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface OllamaRawModel {
  // The slug Ollama uses everywhere (e.g. `gpt-oss:120b`, `deepseek-v4-flash`,
  // `nomic-embed-text:latest`). This is the value the gateway sends back to
  // Ollama as the `model` field on every inference call.
  id: string;
  modifiedAt?: number;
  capabilities: ReadonlySet<string>;
  contextLength?: number;
}

export interface OllamaCatalog {
  data: OllamaRawModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

interface TagEntry {
  name: string;
  modifiedAt?: number;
}

const parseTagEntry = (value: unknown): TagEntry | null => {
  if (!isRecord(value)) return null;
  const name = optionalStringField(value.name);
  if (!name) return null;
  const entry: TagEntry = { name };
  const modifiedAtRaw = optionalStringField(value.modified_at);
  if (modifiedAtRaw) {
    const ms = Date.parse(modifiedAtRaw);
    if (!Number.isNaN(ms)) entry.modifiedAt = Math.floor(ms / 1000);
  }
  return entry;
};

const parseTagsResponse = (value: unknown): TagEntry[] | null => {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const entries: TagEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.models) {
    const entry = parseTagEntry(item);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      entries.push(entry);
    }
  }
  if (value.models.length > 0 && entries.length === 0) return null;
  return entries;
};

// model_info keys are prefixed by the architecture identifier the GGUF
// publishes (e.g. `gptoss.context_length`, `qwen3moe.context_length`,
// `kimi-k2.context_length`). The prefix varies per family — sometimes it
// includes a hyphen, sometimes a digit — so consumers must enumerate the keys
// rather than hardcoding the prefix. Skip `general.*` (carries
// `general.architecture` / `general.parameter_count`) so a hypothetical
// `general.context_length` cannot shadow the real per-arch entry.
const findArchSuffixedNumber = (modelInfo: Record<string, unknown>, suffix: string): number | undefined => {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.startsWith('general.')) continue;
    if (key.endsWith(suffix)) {
      const n = optionalNumberField(value);
      if (n !== undefined && n > 0) return n;
    }
  }
  return undefined;
};

const parseShowResponse = (id: string, modifiedAt: number | undefined, value: unknown): OllamaRawModel | null => {
  if (!isRecord(value)) return null;

  const capabilities = new Set<string>();
  if (Array.isArray(value.capabilities)) {
    for (const cap of value.capabilities) {
      if (typeof cap === 'string' && cap !== '') capabilities.add(cap);
    }
  }

  const modelInfo = isRecord(value.model_info) ? value.model_info : null;

  const raw: OllamaRawModel = { id, capabilities };
  if (modifiedAt !== undefined) raw.modifiedAt = modifiedAt;
  if (modelInfo) {
    const contextLength = findArchSuffixedNumber(modelInfo, '.context_length');
    if (contextLength !== undefined) raw.contextLength = contextLength;
  }

  return raw;
};

const fetchShowForTag = (
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
  tag: TagEntry,
  signal: AbortSignal,
  maxResponseBytes: number,
  idleTimeoutMs: number | undefined,
  totalTimeoutMs: number | undefined,
): Promise<OllamaRawModel | null> => runProviderModelsTask(async taskSignal => {
  const response = await ollamaFetchShow(
    config,
    { method: 'POST', body: JSON.stringify({ name: tag.name }), signal: taskSignal },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  if (!response.ok) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedJsonResponse(response, maxResponseBytes, undefined, { idleTimeoutMs, signal: taskSignal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
  return parseShowResponse(tag.name, tag.modifiedAt, parsed);
}, { signal, totalTimeoutMs });

export const fetchOllamaCatalog = (
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
  options: { idleTimeoutMs?: number; maxShowResponseBytes?: number; signal?: AbortSignal; totalTimeoutMs?: number } = {},
): Promise<OllamaCatalog> => runProviderModelsTask(async catalogSignal => {
  const maxShowResponseBytes = options.maxShowResponseBytes ?? MAX_SHOW_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxShowResponseBytes) || maxShowResponseBytes <= 0) {
    throw new TypeError('maxShowResponseBytes must be a positive safe integer');
  }
  // /api/tags through the shared scaffold so network / non-2xx / shape errors
  // surface as ProviderModelsUnavailableError — same envelope every other
  // provider's catalog fetch produces, which the control-plane and SWR cache
  // both branch on.
  const tags = await fetchUpstreamModels(
    signal => ollamaFetchTags(config, { method: 'GET', signal }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    parseTagsResponse,
    { idleTimeoutMs: options.idleTimeoutMs, signal: catalogSignal, totalTimeoutMs: options.totalTimeoutMs },
  );
  const results: Array<OllamaRawModel | null | undefined> = new Array(tags.length);
  const controller = new AbortController();
  const onCatalogAbort = () => controller.abort(catalogSignal.reason);
  catalogSignal.addEventListener('abort', onCatalogAbort, { once: true });
  let nextIndex = 0;
  let fatalAbort: unknown;
  let firstShowError: unknown;
  let rejectFatalAbort!: (error: unknown) => void;
  const fatalAbortPromise = new Promise<never>((_resolve, reject) => { rejectFatalAbort = reject; });
  const worker = async (): Promise<void> => {
    while (fatalAbort === undefined && !controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= tags.length) return;
      try {
        results[index] = await fetchShowForTag(
          config,
          fetcher,
          tags[index],
          controller.signal,
          maxShowResponseBytes,
          options.idleTimeoutMs,
          options.totalTimeoutMs,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isAbortError(error)) {
          if (fatalAbort === undefined) {
            fatalAbort = error;
            rejectFatalAbort(error);
            controller.abort(error);
          }
          return;
        }
        if (firstShowError === undefined) firstShowError = error;
        results[index] = null;
      }
    }
  };
  const workers = Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_SHOW_REQUESTS, tags.length) },
    worker,
  ));
  try {
    try {
      await Promise.race([workers, fatalAbortPromise]);
    } catch (error) {
      void workers.catch(() => undefined);
      throw error;
    }
  } finally {
    catalogSignal.removeEventListener('abort', onCatalogAbort);
  }

  const data: OllamaRawModel[] = [];
  for (const model of results) {
    if (model !== null && model !== undefined) data.push(model);
  }
  if (tags.length > 0 && data.length === 0) {
    throw new ProviderModelsUnavailableError(
      null,
      firstShowError ?? new Error('Every Ollama /api/show request failed'),
    );
  }
  return { data };
}, options).catch((cause: unknown) => {
  if (options.signal?.aborted) throw options.signal.reason;
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  throw cause;
});
