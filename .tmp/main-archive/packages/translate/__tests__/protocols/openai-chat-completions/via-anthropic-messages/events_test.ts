import { translateToSourceEvents } from '../../../../src/protocols/openai-chat-completions/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, {}, codec));
