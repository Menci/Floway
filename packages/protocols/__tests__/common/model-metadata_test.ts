import { expect, test } from 'vitest';

import { chatMetadataWithRules, intersectChatMetadata } from '../../src/common/model-metadata.ts';

test('intersects capabilities while keeping only agreed client policies and instructions', () => {
  const first = { verbosity: { supported: true }, codex: { default_context_window_tokens: 272000, use_responses_lite: true, model_messages: { instructions_template: 'first' }, shell_type: 'unified_exec' } };
  const second = { verbosity: { supported: false }, codex: { default_context_window_tokens: 128000, use_responses_lite: false, model_messages: { instructions_template: 'second' }, shell_type: 'unified_exec' } };
  expect(intersectChatMetadata([first, second])).toEqual({ verbosity: { supported: false }, codex: { default_context_window_tokens: 128000, use_responses_lite: false, shell_type: 'unified_exec' } });
  expect(intersectChatMetadata([first, {}])).toBeUndefined();
});

test('compares opaque instruction sections structurally instead of JSON property order', () => {
  expect(intersectChatMetadata([
    { codex: { model_messages: { tools: { one: 1, two: 2 }, instructions_template: '' } } },
    { codex: { model_messages: { instructions_template: '', tools: { two: 2, one: 1 } } } },
  ])?.codex?.model_messages).toEqual({ tools: { one: 1, two: 2 }, instructions_template: '' });
});

test('pinned alias rules remove configurable defaults from the announced profile', () => {
  expect(chatMetadataWithRules({ verbosity: { supported: true }, codex: { default_verbosity: 'low', default_reasoning_summary: 'auto', use_responses_lite: true } }, { verbosity: 'high', reasoning: { summary: 'detailed' } })).toEqual({ codex: { use_responses_lite: true } });
});
