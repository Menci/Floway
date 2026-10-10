import { translateToSourceEvents } from '../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('anthropic-messages', 'openai-chat-completions', frames => translateToSourceEvents(frames));
