import { translateToSourceEvents } from '../../../../src/protocols/gemini-generate-content/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('gemini-generate-content', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, codec));
