import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

// The client speaks Messages; the upstream stream it receives is Chat Completions.
testOutputTranslation('anthropic-messages', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.messagesToChat;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});
