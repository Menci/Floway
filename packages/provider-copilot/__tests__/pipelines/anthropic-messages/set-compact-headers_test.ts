import { test } from 'vitest';

import { setCompactHeaders } from '../../../src/pipelines/anthropic-messages/set-compact-headers.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const COMPACT_LAST_MESSAGE_TEXT =
  'Your task is to create a detailed summary of the conversation so far.\n\n' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';

test('Compact headers set when the last user message carries all three markers', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: COMPACT_LAST_MESSAGE_TEXT }],
  });

  const ctx = await inspectStages('anthropicMessages', setCompactHeaders, fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

test('Compact headers set when the system prompt starts with a compact summarization prefix', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: 'You are a helpful AI assistant tasked with summarizing conversations and other things.',
    messages: [{ role: 'user', content: 'go ahead' }],
  });

  const ctx = await inspectStages('anthropicMessages', setCompactHeaders, fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

// Real client scenario: clients that round-trip the previous request's user
// turn back as assistant history can place compact-summary text under an
// assistant role. caozhiyuan's `getCompactCandidateText` returns empty text
// for any non-user role; we mirror that so the tagging stays anchored to the
// turn the human actually authored.
test('Compact headers absent when the last message is assistant-role with compact-summary text', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'kick off' },
      { role: 'assistant', content: COMPACT_LAST_MESSAGE_TEXT },
    ],
  });

  const ctx = await inspectStages('anthropicMessages', setCompactHeaders, fixture);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Auto-continue marks Claude Code resume prompts with x-initiator: agent only', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nMore detail follows.',
      },
    ],
  });

  const ctx = await inspectStages('anthropicMessages', setCompactHeaders, fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});
