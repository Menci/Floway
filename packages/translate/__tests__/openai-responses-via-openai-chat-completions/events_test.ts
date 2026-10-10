import { translateToSourceEvents } from '../../src/openai-responses-via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', frames => translateToSourceEvents(frames));
