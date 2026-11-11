import { translateToSourceEvents } from '../../../../src/protocols/gemini-generate-content/via-openai-responses/events.ts';
import { testOutputTranslation } from '../../fixtures.ts';

testOutputTranslation('gemini-generate-content', 'openai-responses', (frames, codec) => translateToSourceEvents(frames, codec));
