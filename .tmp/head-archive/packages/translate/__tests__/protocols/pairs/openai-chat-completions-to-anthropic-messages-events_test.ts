import { buildSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.chatToMessages;
  return buildSourceEventsFor(source, target, emptyPayload.chat, { sidecarCodec: codec }, frames);
});
