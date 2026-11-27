import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('openai-responses', 'gemini-generate-content', (frames, codec) => {
  const [source, target] = pairs.responsesToGemini;
  return buildSourceEventsFor(source, target, emptyPayload.responses, { sidecarCodec: codec }, frames);
});
