import { ollamaDial } from '../dial.ts';
import { formatOpenAIError } from '../errors.ts';
import { serializeModelFieldOpenAIAudioTranscriptionRequest } from '@floway-dev/provider';

// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
export const dial = ollamaDial('openaiAudioTranscriptions', async (payload, model) => {
  const form = serializeModelFieldOpenAIAudioTranscriptionRequest({
    entries: payload.entries.map(({ name, value }) => ({
      name,
      value: typeof value === 'string' ? value : new File([Uint8Array.from(value.bytes)], value.name, { type: value.mediaType }),
    })),
  }, model.upstreamModelId);
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type');
  if (contentType === null) throw new Error('Multipart serialization did not produce a content-type header');
  return { path: '/v1/audio/transcriptions', contentType, body: await encoded.bytes() };
}, formatOpenAIError);
