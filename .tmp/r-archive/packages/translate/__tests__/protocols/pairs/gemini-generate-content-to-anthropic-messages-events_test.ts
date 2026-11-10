import { buildSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.geminiToMessages;
  return buildSourceEventsFor(source, target, emptyPayload.gemini, { sidecarCodec: codec }, frames);
});
