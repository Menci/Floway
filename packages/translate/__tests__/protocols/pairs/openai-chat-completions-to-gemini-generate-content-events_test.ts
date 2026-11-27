import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('openai-chat-completions', 'gemini-generate-content', (frames, codec) => {
  const [source, target] = pairs.chatToGemini;
  return buildSourceEventsFor(source, target, emptyPayload.chat, { sidecarCodec: codec }, frames);
});
