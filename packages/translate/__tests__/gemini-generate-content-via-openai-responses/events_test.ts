import { translateToSourceEvents } from '../../src/gemini-generate-content-via-openai-responses/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'openai-responses', frames => translateToSourceEvents(frames));
