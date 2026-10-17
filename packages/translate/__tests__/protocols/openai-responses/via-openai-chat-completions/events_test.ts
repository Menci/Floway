import { translateToSourceEvents } from '../../../../src/protocols/openai-responses/via-openai-chat-completions/events.ts';
import { testOutputTranslation } from '../../../ir/translation-cases.ts';
import { emptyNamespaceToolNames } from '../../../round-trip/test-helpers.ts';

testOutputTranslation('openai-responses', 'openai-chat-completions', (frames, codec) => translateToSourceEvents(frames, new Set(), codec, emptyNamespaceToolNames()));
