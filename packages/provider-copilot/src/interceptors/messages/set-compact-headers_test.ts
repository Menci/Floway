import { test } from 'vitest';

import { withCompactHeadersSet } from './set-compact-headers.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const COMPACT_LAST_MESSAGE_TEXT =
  'Your task is to create a detailed summary of the conversation so far.\n\n' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';

test('Compact headers set when the last user message carries all three markers', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: COMPACT_LAST_MESSAGE_TEXT }],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

test('Compact headers set from a multi-block last message that joins to the full marker set', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>ignore me</system-reminder>' },
          { type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' },
          { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nPending Tasks:\n- x' },
        ],
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

test('Compact headers set when the system prompt starts with a compact summarization prefix', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: 'You are a helpful AI assistant tasked with summarizing conversations and other things.',
    messages: [{ role: 'user', content: 'go ahead' }],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

test('Compact headers set when an array system prompt contains a compact prefix block', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: [
      { type: 'text', text: 'You are an anchored context summarization assistant for coding sessions. ...' },
      { type: 'text', text: 'unrelated' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-type'), 'conversation-compaction');
});

test('Compact headers absent when only the text-only guard is present (other markers missing)', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.' }],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Compact headers absent for an ordinary user turn', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello there' }],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

// Real client scenario: clients that round-trip the previous request's user
// turn back as assistant history can place compact-summary text under an
// assistant role. caozhiyuan's `getCompactCandidateText` returns empty text
// for any non-user role; we mirror that so the tagging stays anchored to the
// turn the human actually authored.
test('Compact headers absent when the last message is assistant-role with compact-summary text', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'kick off' },
      { role: 'assistant', content: COMPACT_LAST_MESSAGE_TEXT },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Compact headers absent when the last assistant message is a multi-block compact-summary replay', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'kick off' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' },
          { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nPending Tasks:\n- x' },
        ],
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Auto-continue absent when the assistant role carries the resume prompt verbatim', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-initiator'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Auto-continue marks Claude Code resume prompts with x-initiator: agent only', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nMore detail follows.',
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Auto-continue marks OpenCode primary continuation prompts with x-initiator: agent only', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});

test('Auto-continue marks OpenCode media-eviction continuation prompts with x-initiator: agent only', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context.",
      },
    ],
  });

  await withCompactHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
  assertEquals(ctx.headers.has('x-interaction-type'), false);
});
