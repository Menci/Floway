import { translateToSourceEvents } from '../../../../src/protocols/openai-chat-completions/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../fixtures.ts';

testOutputTranslation('openai-chat-completions', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, {}, codec));
