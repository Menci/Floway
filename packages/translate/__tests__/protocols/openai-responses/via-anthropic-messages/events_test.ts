import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-anthropic-messages/events.ts';
import { emptyNamespaceToolNames } from '../../../round-trip/test-helpers.ts';
import { testOutputTranslation } from '../../fixtures.ts';

testOutputTranslation('openai-responses', 'anthropic-messages', (frames, codec) => translateToSourceEvents(frames, 'resp_test', new Set(), codec, emptyNamespaceToolNames()));
