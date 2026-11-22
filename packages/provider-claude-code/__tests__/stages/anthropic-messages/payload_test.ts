import { parse, validate, version } from 'uuid';
import { test } from 'vitest';

import { parseMetadataUserID } from '../../../src/detection.ts';
import { backfillRequiredFieldsPayload } from '../../../src/stages/anthropic-messages/backfill-required-fields.ts';
import { hoistUserSystemToMessagesPayload } from '../../../src/stages/anthropic-messages/hoist-user-system-to-messages.ts';
import { injectBillingBlockPayload } from '../../../src/stages/anthropic-messages/inject-billing-block.ts';
import { injectDefaultTemplatePayload } from '../../../src/stages/anthropic-messages/inject-default-template.ts';
import { injectIdentityBlockPayload } from '../../../src/stages/anthropic-messages/inject-identity-block.ts';
import { synthesizeMetadataUserIdPayload } from '../../../src/stages/anthropic-messages/synthesize-metadata-user-id.ts';
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK, computeCcVersionFingerprint } from '../../../src/stages/anthropic-messages/system-blocks.ts';
import type { AnthropicMessagesClientTool, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

test('required fields use the model output limit and backfill temperature', () => {
  const payload = {
    max_tokens: undefined,
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as MessagePayload;
  const result = backfillRequiredFieldsPayload(payload, { limits: { max_output_tokens: 64_000 } });
  assertEquals(result.max_tokens, 64_000);
  assertEquals(result.temperature, 1);

  const explicit = {
    max_tokens: 10,
    temperature: 0.4,
    messages: [{ role: 'user', content: 'hi' }],
  } as MessagePayload;
  assertEquals(backfillRequiredFieldsPayload(explicit, { limits: {} }), explicit);
});

test('system text is hoisted into an alternating synthetic turn', () => {
  const payload: MessagePayload = {
    max_tokens: 16,
    messages: [{ role: 'user', content: 'real question' }],
    system: 'You are a pirate.',
  };
  assertEquals(hoistUserSystemToMessagesPayload(payload), {
    max_tokens: 16,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nYou are a pirate.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
      { role: 'user', content: 'real question' },
    ],
  });
});

test('billing fingerprint matches the known vector and precedes identity and template blocks', () => {
  const body = {
    messages: [{ role: 'user', content: 'hello world this is a test prompt' }],
  } as MessagePayload;
  assertEquals(computeCcVersionFingerprint('2.1.280', body), '309');

  const billed = injectBillingBlockPayload({ ...body, max_tokens: 1024 });
  const withIdentity = injectIdentityBlockPayload(billed);
  const shaped = injectDefaultTemplatePayload(withIdentity);
  const system = shaped.system as AnthropicMessagesTextBlockParam[];
  assertEquals(system.length, 3);
  assertEquals(system[0]!.text.startsWith('x-anthropic-billing-header: cc_version='), true);
  assertEquals(system[0]!.text.endsWith('cch=00000;'), true);
  assertEquals(system[1], IDENTITY_BLOCK);
  assertEquals(system[2], DEFAULT_TEMPLATE_BLOCK);
});

test('metadata user id is deterministic and session-scoped to the first user message', () => {
  const first = synthesizeMetadataUserIdPayload<MessagePayload>({
    max_tokens: 1,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  }, 'up_test');
  const same = synthesizeMetadataUserIdPayload<MessagePayload>({
    max_tokens: 1,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  }, 'up_test');
  const other = synthesizeMetadataUserIdPayload<MessagePayload>({
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Who wrote The Great Gatsby?' }],
  }, 'up_test');

  assertEquals(first, same);
  const parsed = parseMetadataUserID(first.metadata!.user_id!)!;
  const otherParsed = parseMetadataUserID(other.metadata!.user_id!)!;
  assertEquals(parsed.isNewFormat, true);
  assertEquals(parsed.accountUuid, '');
  assertEquals(parsed.deviceId.length, 64);
  assertEquals(parsed.deviceId, otherParsed.deviceId);
  assertEquals(parsed.sessionId === otherParsed.sessionId, false);
  assertEquals(validate(parsed.sessionId), true);
  assertEquals(version(parsed.sessionId), 4);
  assertEquals(parse(parsed.sessionId)[8]! & 0xc0, 0x80);
});

test('template cache control stays within four caller breakpoints', () => {
  const cachedTool: AnthropicMessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedSystem: AnthropicMessagesTextBlockParam = {
    type: 'text',
    text: 'caller system',
    cache_control: { type: 'ephemeral' },
  };
  const cachedA: AnthropicMessagesTextBlockParam = {
    type: 'text',
    text: 'cached A',
    cache_control: { type: 'ephemeral' },
  };
  const cachedB: AnthropicMessagesTextBlockParam = {
    type: 'text',
    text: 'cached B',
    cache_control: { type: 'ephemeral' },
  };

  const atCap = injectDefaultTemplatePayload({
    max_tokens: 16,
    messages: [{ role: 'user', content: [cachedA, cachedB, { type: 'text', text: 'hi' }] }],
    system: [{ type: 'text', text: 'billing' }, IDENTITY_BLOCK, cachedSystem],
    tools: [cachedTool],
  });
  const atCapSystem = atCap.system as AnthropicMessagesTextBlockParam[];
  assertEquals(atCapSystem.length, 4);
  assertEquals(atCapSystem[3]!.text, DEFAULT_TEMPLATE_BLOCK.text);
  assertEquals(atCapSystem[3]!.cache_control, undefined);
});
