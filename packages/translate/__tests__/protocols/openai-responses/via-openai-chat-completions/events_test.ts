import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-openai-chat-completions/events.ts';
import { emptyNamespaceToolNames } from '../../../round-trip/test-helpers.ts';
import { testOutputTranslation } from '../../fixtures.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', (frames, codec) => translateToSourceEvents(frames, new Set(), codec, emptyNamespaceToolNames()));
