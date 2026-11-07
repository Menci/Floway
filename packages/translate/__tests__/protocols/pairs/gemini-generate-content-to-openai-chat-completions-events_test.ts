import { translateSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('gemini-generate-content', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.geminiToChat;
  return translateSourceEventsFor(source, target, emptyPayload.gemini, { model: 'm', sidecarCodec: codec }, frames);
});
