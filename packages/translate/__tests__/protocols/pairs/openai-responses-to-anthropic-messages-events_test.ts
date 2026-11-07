import { translateSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('openai-responses', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.responsesToMessages;
  return translateSourceEventsFor(source, target, emptyPayload.responses, { sidecarCodec: codec }, frames);
});
