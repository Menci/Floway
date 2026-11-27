import type { ChatRequestFacts, ChatResponseFacts } from './facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { factSpace, type Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';

export interface ChatDelivery {
  stream: boolean;
  includeUsageChunk?: boolean;
  expectedChoices?: number;
  createdAt?: number;
  store?: boolean;
}

export const { defineStage: defineDeliveryStage } = factSpace<ChatRequestFacts, ChatResponseFacts, Pick<GatewayServices, 'dump'>>();

export const parseChatRequestBody = (body: HttpRequestFact['body']): Result<JsonObject, SyntaxError | TypeError> => {
  let value: unknown = body;
  try {
    if (typeof body === 'string') value = JSON.parse(body) as unknown;
    if (body instanceof Uint8Array) value = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
  return isJsonObject(value)
    ? { ok: true, value }
    : { ok: false, error: new TypeError('Expected a JSON request object') };
};
