import { translateToSourceEvents } from '../../src/openai-chat-completions-via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', frames => translateToSourceEvents(frames));
