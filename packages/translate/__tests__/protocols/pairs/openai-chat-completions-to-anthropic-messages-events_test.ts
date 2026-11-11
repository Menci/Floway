import { buildSourceEventsFor } from '../../../src/composition/index.ts';
import { emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.chatToMessages;
  return buildSourceEventsFor(source, target, emptyPayload.chat, { sidecarCodec: codec }, frames);
});
