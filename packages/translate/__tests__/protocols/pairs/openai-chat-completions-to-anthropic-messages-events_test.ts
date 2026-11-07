import { translateSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.chatToMessages;
  return translateSourceEventsFor(source, target, emptyPayload.chat, { model: 'm', sidecarCodec: codec }, frames);
});
