import { buildSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('anthropic-messages', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.messagesToResponses;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});
