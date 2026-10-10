import { translateToSourceEvents } from '../../src/openai-responses-via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';

testOutputTranslation('openai-responses', 'anthropic-messages', frames => translateToSourceEvents(frames, 'resp_test', 'requested-model'));
