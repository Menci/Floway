import { translateSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('anthropic-messages', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.messagesToResponses;
  return translateSourceEventsFor(source, target, emptyPayload.messages, { model: 'm', sidecarCodec: codec }, frames);
});
