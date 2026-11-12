import { translateToSourceEvents } from '../../../../src/protocols/gemini-generate-content/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../fixtures.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, codec));
