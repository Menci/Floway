import { buildSourceEventsFor } from '../../../src/protocols/composition.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';
import { emptyPayload, pairs } from '../composition-helpers.ts';

// The client speaks Messages; the upstream stream it receives is Chat Completions.
testOutputTranslation('anthropic-messages', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.messagesToChat;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});
