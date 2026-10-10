import { translateToSourceEvents } from '../../src/gemini-generate-content-via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', frames => translateToSourceEvents(frames));
