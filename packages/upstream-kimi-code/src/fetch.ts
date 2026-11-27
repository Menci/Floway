import type { KimiCodeUpstreamConfig } from './config.ts';
import { type FetchInit, type Fetcher, joinBaseAndPath } from '@floway-dev/upstream';

// Coding subscription keys use the regional coding service, independently of
// Moonshot Open Platform keys and billing.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const BASE_URLS = {
  china: 'https://api.kimi.com/coding/v1',
  overseas: 'https://api.kimi.ai/coding/v1',
} as const;

export const kimiCodeUrl = (region: KimiCodeUpstreamConfig['region'], path: string): string => joinBaseAndPath(BASE_URLS[region], path);

export const kimiCodeFetch = async (
  config: KimiCodeUpstreamConfig,
  path: string,
  init: FetchInit,
  fetcher: Fetcher,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${config.apiKey}`);
  return await fetcher(kimiCodeUrl(config.region, path), { ...init, headers });
};

const MAX_KIMI_CODE_PROBE_BODY_BYTES = 1024 * 1024;

const readProbeBody = async (body: ReadableStream<Uint8Array> | null, path: string): Promise<string> => {
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_KIMI_CODE_PROBE_BODY_BYTES) {
        const error = new RangeError(`Kimi Code ${path} response exceeds ${MAX_KIMI_CODE_PROBE_BODY_BYTES} bytes`);
        try {
          await reader.cancel(error);
        } catch (cause) {
          throw new AggregateError([error, cause], error.message);
        }
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

export const readKimiCodeJson = async (response: Response, path: string): Promise<unknown> => {
  const text = await readProbeBody(response.body, path);
  if (!response.ok) throw new Error(`Kimi Code ${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as unknown;
};
