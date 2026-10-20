import { translateToSourceEvents } from '../../../../src/protocols/gemini-generate-content/via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'openai-chat-completions', (frames, codec) => translateToSourceEvents(frames, codec));
