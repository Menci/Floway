import { translateToSourceEvents } from '../../src/gemini-generate-content-via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'openai-chat-completions', frames => translateToSourceEvents(frames));
