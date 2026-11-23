import { deleteHeader, setHeader } from './headers.ts';
import type { HeaderEntry } from '@floway-dev/http';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const setAnthropicBetaHeader = (headers: readonly HeaderEntry[], anthropicBeta: readonly string[]): readonly HeaderEntry[] =>
  anthropicBeta.length === 0 ? deleteHeader(headers, 'anthropic-beta') : setHeader(headers, 'anthropic-beta', anthropicBeta.join(','));

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/client.ts
export const headersForAnthropicMessagesCall = (headers: readonly HeaderEntry[], anthropicBeta: readonly string[]): readonly HeaderEntry[] =>
  setHeader(setAnthropicBetaHeader(headers, anthropicBeta), 'anthropic-version', '2023-06-01');
