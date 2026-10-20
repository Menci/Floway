import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-anthropic-messages/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';
import { emptyNamespaceToolNames } from '../../../round-trip/test-helpers.ts';

testOutputTranslation('openai-responses', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, 'resp_test', new Set(), codec, emptyNamespaceToolNames()));
