import { translateToSourceEvents } from '../../../../src/protocols/anthropic-messages/via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('anthropic-messages', 'openai-chat-completions', (frames, codec) => translateToSourceEvents(frames, codec));
