import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { flattenNamespaceTools } from '../../../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import { openaiResponsesFromIR } from '../../../../src/protocols/openai-responses/as-source/sse-to.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/reference/reference-builder.ts';
import { type RoundTripWriter } from '../../../../src/round-trip/stream.ts';

test('collects sparse namespace-restored Responses state from emitted IR atoms', async () => {
  const namespace = flattenNamespaceTools({
    model: 'model',
    input: [],
    tools: [{ type: 'namespace', name: 'tools', description: '', tools: [{ type: 'custom', name: 'script' }, { type: 'function', name: 'lookup', parameters: { type: 'object' } }] }],
  });
  const flatScript = namespace.names.sourceToTarget.get('tools.script');
  const flatLookup = namespace.names.sourceToTarget.get('tools.lookup');
  if (flatScript === undefined || flatLookup === undefined) throw new Error('Namespace tools were not flattened');

  const references = createReferenceBuilder();
  const field = (parts: readonly string[]) => {
    const state = createFieldState('text');
    const referencePieceIds = parts.map(part => appendField(references, state, part));
    return { state, referencePieceIds, original: parts.join('') };
  };
  const functionArguments = field(['{"code":', '1}']);
  const messageText = field(['A', 'B']);
  const refusal = field(['N', 'O']);
  const reasoningSummary = field(['S', 'C']);
  const reasoningContent = field(['D']);
  const customInput = field(['{"q":', '1}']);
  let prepared: Parameters<RoundTripWriter<'openaiResponses'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'openaiResponses'> = {
    builder: references,
    prepareSidecar: async (...args) => {
      prepared = args;
      return 'sidecar';
    },
  };

  const builder = createIRBuilder();
  builder.choice(0);
  builder.assign(['model'], 'model');
  builder.event({ type: 'start', id: 'response' });

  builder.initialize(['choices', 0, 'items', 0], { type: 'function_call', name: flatScript, arguments: '' });
  builder.append(['choices', 0, 'items', 0, 'arguments'], '{"code":', [functionArguments.referencePieceIds[0]]);
  builder.append(['choices', 0, 'items', 0, 'arguments'], '1}', [functionArguments.referencePieceIds[1]]);

  builder.initialize(['choices', 0, 'items', 1], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 1, 'content', 0], { type: 'text', text: '' });
  builder.append(['choices', 0, 'items', 1, 'content', 0, 'text'], 'A', [messageText.referencePieceIds[0]]);
  builder.append(['choices', 0, 'items', 1, 'content', 0, 'text'], 'B', [messageText.referencePieceIds[1]]);
  builder.initialize(['choices', 0, 'items', 1, 'content', 1], { type: 'refusal', refusal: '' });
  builder.append(['choices', 0, 'items', 1, 'content', 1, 'refusal'], 'N', [refusal.referencePieceIds[0]]);
  builder.append(['choices', 0, 'items', 1, 'content', 1, 'refusal'], 'O', [refusal.referencePieceIds[1]]);

  builder.initialize(['choices', 0, 'items', 2], { type: 'reasoning', summary: [''], content: [''] });
  builder.append(['choices', 0, 'items', 2, 'summary', 0], 'S', [reasoningSummary.referencePieceIds[0]]);
  builder.append(['choices', 0, 'items', 2, 'summary', 0], 'C', [reasoningSummary.referencePieceIds[1]]);
  builder.append(['choices', 0, 'items', 2, 'content', 0], 'D', [reasoningContent.referencePieceIds[0]]);

  builder.initialize(['choices', 0, 'items', 3], { type: 'custom_tool_call', call_id: 'lookup', name: flatLookup, input: '' });
  builder.append(['choices', 0, 'items', 3, 'input'], '{"q":', [customInput.referencePieceIds[0]]);
  builder.append(['choices', 0, 'items', 3, 'input'], '1}', [customInput.referencePieceIds[1]]);

  builder.assign(['choices', 0, 'items', 0, 'call_id'], 'script');
  builder.event({ type: 'part_end', choice: 0, item: 1, part: 0 });
  builder.event({ type: 'part_end', choice: 0, item: 1, part: 1 });
  builder.event({ type: 'item_end', choice: 0, item: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 1 });
  builder.event({ type: 'item_end', choice: 0, item: 2 });
  builder.event({ type: 'item_end', choice: 0, item: 3 });

  builder.initialize(['choices', 0, 'items', 4], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 4, 'content', 0], { type: 'image', image: { data: 'literal', mime_type: 'image/png' } });
  builder.event({ type: 'part_end', choice: 0, item: 4, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 4 });

  builder.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
  builder.event({ type: 'finish', status: 'completed' });

  for await (const _frame of openaiResponsesFromIR((async function* () { yield* builder.drain(); })(), { roundTrip, namespaceToolNames: namespace.names })) {}
  if (prepared === undefined) throw new Error('Responses sidecar was not prepared');
  const [, , turn, state] = prepared;

  expect(turn).toMatchObject([
    { type: 'custom_tool_call', namespace: 'tools', name: 'script', input: '{"code":1}' },
    { type: 'message', content: [{ type: 'output_text', text: 'AB' }, { type: 'refusal', refusal: 'NO' }] },
    { type: 'reasoning', summary: [{ text: 'SC' }], content: [{ text: 'D' }] },
    { type: 'function_call', namespace: 'tools', name: 'lookup', arguments: '{"q":1}' },
    { type: 'image_generation_call', result: 'literal' },
  ]);
  expect(state[0]).toMatchObject({ input: {} });
  expect(state[1]).toMatchObject({ content: [{ text: {} }, { refusal: {} }] });
  expect(state[2]).toMatchObject({ summary: [{ text: {} }], content: [{ text: {} }] });
  expect(state[3]).toMatchObject({ arguments: {} });
  expect(4 in state).toBe(false);

  const finalizer = createReferenceFinalizer(references, collectContentViews(turn, state));
  for (const source of [functionArguments, messageText, refusal, reasoningSummary, reasoningContent, customInput]) {
    expect(await finalizer.finalizeField(source.original, source.state)).not.toBe(source.original);
  }
});
