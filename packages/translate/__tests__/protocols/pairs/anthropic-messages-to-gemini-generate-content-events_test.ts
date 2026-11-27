import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('anthropic-messages', 'gemini-generate-content', (frames, codec) => {
  const [source, target] = pairs.messagesToGemini;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});
