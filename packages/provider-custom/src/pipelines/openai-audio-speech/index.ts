import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { decodeOpenAIAudioSpeechStream } from '@floway-dev/protocols/openai-audio';
import { parseHttpResponse } from '@floway-dev/provider';

export const openaiAudioSpeech = customOperation('openaiAudioSpeech', {
  parse: parseHttpResponse('openaiAudioSpeech', {
    select: payload => payload.stream_format === 'sse' ? 'stream' : 'result',
    stream: decodeOpenAIAudioSpeechStream,
    result: bytes => ({ ok: true, value: bytes }),
    format: openAIError,
  }),
  prepare: (payload, model, config) => ({
    path: customOperationPath(config, '/audio/speech'),
    ...jsonBody({ ...payload, model: model.upstreamModelId }),
  }),
});
