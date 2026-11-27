import { expect, test } from 'vitest';

import { geminiGenerateContentBodyStages } from '../../../../../src/data-plane/chat/gemini-generate-content/pipeline/body-stages.ts';
import { compose, defineStage, type ChatOperation } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { operationHost } from '../../../non-chat/count-tokens/fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const runShape = async (
  payload: GeminiGenerateContentPayload,
  target: ChatOperation,
  upstream: readonly GeminiGenerateContentStreamEvent[] = [],
) => {
  let dispatched: GeminiGenerateContentPayload | undefined;
  const ending = defineStage({
    name: 'capture-gemini-shape',
    request: { needs: ['geminiGenerateContent'] },
    return: { provides: ['geminiGenerateContent'] },
    async execute({ geminiGenerateContent }, scope) {
      dispatched = geminiGenerateContent;
      const stream = scope.createStream<GeminiGenerateContentStreamEvent, ProtocolStreamError>(async function* () {
        for (const value of upstream) yield { ok: true, value };
      });
      return { geminiGenerateContent: { kind: 'stream', stream } };
    },
  });
  const entry = asEntry(compose('gemini-shape-test', {
    entry: ['geminiGenerateContent', 'chat.target'],
    exit: ['geminiGenerateContent'],
    stages: geminiGenerateContentBodyStages,
    ending,
  }));
  const host = operationHost([], async () => { throw new Error('Shape test reached transport'); });
  const running = run(entry, { geminiGenerateContent: payload, 'chat.target': target }, host.options);
  const answer = await running.result;
  if (answer.geminiGenerateContent.kind !== 'stream') throw new TypeError('Expected shaped stream');
  const frames: GeminiGenerateContentStreamEvent[] = [];
  for await (const item of running.read(answer.geminiGenerateContent.stream)) {
    if (!item.ok) throw item.error.cause;
    frames.push(item.value);
  }
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  return { dispatched, frames };
};

test('cleans unsupported Gemini tools and parts only before translating', async () => {
  const declaration = { name: 'lookup', description: 'Find data' };
  const supported = { text: 'answer', thoughtSignature: 'opaque' };
  const payload: GeminiGenerateContentPayload = {
    contents: [{
      parts: [
        { fileData: { fileUri: 'gs://file' } },
        supported,
        { executableCode: { language: 'PYTHON', code: 'print(1)' } },
        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
      ],
    }],
    systemInstruction: { parts: [{ text: 'rules' }, { fileData: { fileUri: 'gs://rules' } }] },
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    tools: [
      { googleSearch: {} },
      { codeExecution: {}, functionDeclarations: [declaration] },
    ],
  };
  const translated = await runShape(payload, 'openaiChatCompletions');
  expect(translated.dispatched).toEqual({
    contents: [{ parts: [supported] }], systemInstruction: { parts: [{ text: 'rules' }] }, tools: [{ functionDeclarations: [declaration] }],
  });
  expect((await runShape(payload, 'geminiGenerateContent')).dispatched).toEqual(payload);
  const empty = await runShape({ contents: [], tools: [{ googleSearch: {} }] }, 'anthropicMessages');
  expect(empty.dispatched).toEqual({ contents: [] });
});

test('suppresses thought-only Gemini candidates but keeps a finishReason', async () => {
  const think = { content: { role: 'model', parts: [{ text: 'private', thought: true }] } };
  const mixed = {
    candidates: [
      { ...think, index: 0 },
      { index: 1, content: { role: 'model', parts: [{ text: 'private', thought: true }, { text: 'visible' }] } },
    ],
  };
  const done = { candidates: [{ ...think, finishReason: 'STOP' }] };
  const upstream = [{ candidates: [think] }, mixed, done];
  const body: GeminiGenerateContentPayload = { contents: [] };
  expect((await runShape(body, 'openaiChatCompletions', upstream)).frames).toEqual([
    { candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'visible' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] },
  ]);
  expect((await runShape({
    ...body, generationConfig: { thinkingConfig: { includeThoughts: true } },
  }, 'openaiChatCompletions', upstream)).frames).toEqual(upstream);
  expect((await runShape(body, 'geminiGenerateContent', upstream)).frames).toEqual(upstream);
});
