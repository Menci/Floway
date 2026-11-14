import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../fixtures.ts';

testOutputTranslation('gemini-generate-content', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.geminiToChat;
  return buildSourceEventsFor(source, target, { ...emptyPayload.gemini, generationConfig: { thinkingConfig: { includeThoughts: true } } }, { sidecarCodec: codec }, frames);
});
