import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.geminiToMessages;
  return buildSourceEventsFor(source, target, { ...emptyPayload.gemini, generationConfig: { thinkingConfig: { includeThoughts: true } } }, { sidecarCodec: codec }, frames);
});
