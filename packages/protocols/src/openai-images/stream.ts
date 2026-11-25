import { isJsonObject } from '../common/json.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { eventFrame, type ParsedProtocolFrame } from '../common/sse.ts';

export interface OpenAIImagesStreamEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

// https://developers.openai.com/api/reference/resources/images
export const isOpenAIImagesCompletedEvent = ({ type }: OpenAIImagesStreamEvent): boolean =>
  type === 'image_generation.completed' || type === 'image_edit.completed';

export const isOpenAIImagesTerminalEvent = (event: OpenAIImagesStreamEvent): boolean =>
  isOpenAIImagesCompletedEvent(event) || event.type === 'error';

export const openAIImagesStreamRequested = (value: unknown): boolean => value === true || value === 'true';

export const parseOpenAIImagesStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: { readonly signal?: AbortSignal | undefined } = {},
): AsyncGenerator<ParsedProtocolFrame<OpenAIImagesStreamEvent>> {
  for await (const frame of parseTargetStreamFrames<unknown>(parseSSEStream(body, options), { protocol: 'OpenAI Images' })) {
    if (frame.type === 'done' || frame.type === 'error') {
      yield frame;
      return;
    }

    const data = frame.data;
    const eventName = frame.frame.type === 'sse' ? frame.frame.event : undefined;
    const type = isJsonObject(data) && typeof data.type === 'string' ? data.type : eventName;
    if (type === 'keepalive' || type === 'ping') continue;
    if (!isJsonObject(data) || type === undefined) {
      yield { type: 'error', cause: new Error('Malformed OpenAI Images stream event', { cause: data }) };
      return;
    }
    yield eventFrame({ ...data, type });
  }
};
