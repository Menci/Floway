import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('anthropic-messages', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.messagesToResponses;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});
