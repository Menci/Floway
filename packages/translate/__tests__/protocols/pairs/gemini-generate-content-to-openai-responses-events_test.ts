import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.geminiToResponses;
  return buildSourceEventsFor(source, target, emptyPayload.gemini, { sidecarCodec: codec }, frames);
});
