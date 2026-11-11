import { buildSourceEventsFor } from '../../../src/composition/index.ts';
import { emptyPayload, pairs } from '../../composition/helpers.ts';
import { testOutputTranslation } from '../../ir/translation-cases.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', (frames, codec) => {
  const [source, target] = pairs.responsesToChat;
  return buildSourceEventsFor(source, target, emptyPayload.responses, { sidecarCodec: codec }, frames);
});
