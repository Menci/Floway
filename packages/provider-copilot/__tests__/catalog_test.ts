import { expect, test } from 'vitest';

import { projectCopilotModels } from '../src/catalog.ts';

test('projects Copilot chat endpoints by preference and recognizes Claude Messages capability', () => {
  const [dual, claude] = projectCopilotModels([
    { id: 'gpt-dual', supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'] },
    { id: 'claude-haiku-chat-listed', supported_endpoints: ['/chat/completions'] },
  ], {});
  expect(dual.endpoints).toEqual({ openaiResponses: {} });
  expect(claude.endpoints).toEqual({ anthropicMessages: {} });
});

test('applies the Copilot per-model flag after operator upstream overrides', () => {
  const flag = 'rewrite-mid-conv-system-to-user';
  const models = projectCopilotModels([
    { id: 'claude-opus-4.6', supported_endpoints: ['/chat/completions'] },
    { id: 'claude-opus-4.8', supported_endpoints: ['/chat/completions'] },
    { id: 'gpt-test', supported_endpoints: ['/chat/completions'] },
  ], { [flag]: false });

  expect(models.map(model => [model.id, model.enabledFlags.has(flag)])).toEqual([
    ['claude-opus-4-6', true],
    ['claude-opus-4-8', false],
    ['gpt-test', false],
  ]);
});

test('projects independent Copilot image endpoints and decision dialects from the catalog', () => {
  const [image, systemOne, decisions] = projectCopilotModels([
    { id: 'gpt-image-2.5-flare', supported_endpoints: ['/v1/images/generations', '/v1/images/edits'] },
    { id: 'microsoft-decision-1', supported_endpoints: ['/v1/systemone'] },
    { id: 'gpt-6-luna-decisions', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/decisions'] },
  ], {});

  expect(image.endpoints).toEqual({ openaiImagesGenerations: {}, openaiImagesEdits: {} });
  expect(systemOne).toMatchObject({ kind: 'decision', endpoints: { decision: {} }, decisionTarget: { protocol: 'typesafe-systemone' } });
  expect(decisions).toMatchObject({ kind: 'decision', endpoints: { decision: {} }, decisionTarget: { protocol: 'openai-decisions' } });
});

test('rejects a Copilot Decision catalog model with missing or ambiguous dialect metadata', () => {
  expect(() => projectCopilotModels([{ id: 'decision', capabilities: { type: 'decisions' } }], {}))
    .toThrow('advertises no decision path');
  expect(() => projectCopilotModels([{ id: 'decision', supported_endpoints: ['/v1/systemone', '/v1/decisions'] }], {}))
    .toThrow('advertises multiple decision dialects');
});
