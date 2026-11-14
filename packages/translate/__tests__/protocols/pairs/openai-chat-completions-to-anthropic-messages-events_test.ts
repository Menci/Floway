import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => {
  const [source, target] = pairs.chatToMessages;
  return buildSourceEventsFor(source, target, emptyPayload.chat, { sidecarCodec: codec }, frames);
});
