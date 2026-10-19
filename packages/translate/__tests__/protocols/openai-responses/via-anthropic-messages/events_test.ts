import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';

testOutputTranslation('openai-responses', 'anthropic-messages', frames => translateToSourceEvents(frames, 'resp_test'));
