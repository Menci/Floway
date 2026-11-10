import { translateToSourceEvents } from '../../../../src/protocols/gemini-generate-content/via-openai-responses/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'openai-responses', (frames, codec) => translateToSourceEvents(frames, codec));
