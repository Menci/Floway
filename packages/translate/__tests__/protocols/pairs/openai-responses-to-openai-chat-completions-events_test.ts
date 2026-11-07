import { translateSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.responsesToChat;
  return translateSourceEventsFor(source, target, emptyPayload.responses, { model: 'm', sidecarCodec: codec }, frames);
});
