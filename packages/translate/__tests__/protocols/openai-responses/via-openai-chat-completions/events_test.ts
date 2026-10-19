import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', frames => translateToSourceEvents(frames));
