import { buildSourceEventsFor } from '../../../src/composition/index.ts';
import { emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.geminiToMessages;
  return buildSourceEventsFor(source, target, emptyPayload.gemini, { sidecarCodec: codec }, frames);
});
