import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, multipartFile, openAIError, readMultipart } from '../shared/http.ts';

// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040
export const parseOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiAudioTranscriptions', 'requestedModel'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const invalid = (message: string) => {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(message)) };
    };
    const parsed = await readMultipart(facts.http, 'OpenAI Audio Transcriptions');
    if (!parsed.ok) return invalid(parsed.error);
    const form = parsed.value;
    const model = form.get('model');
    if (typeof model !== 'string' || model.length === 0) {
      return invalid('OpenAI Audio Transcriptions request body must include a model field.');
    }
    scope.services.dump?.requestedModel(model);
    const files = form.getAll('file');
    if (files.length === 0 || files.some(value => typeof value === 'string')) {
      return invalid('OpenAI Audio Transcriptions request body must include a file upload.');
    }
    const entries = await Promise.all([...form].map(async ([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : await multipartFile(value),
    })));
    return await scope.next({ ...facts, requestedModel: model, openaiAudioTranscriptions: { entries } });
  },
});
