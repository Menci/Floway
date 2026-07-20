import { describe, expect, test } from 'vitest';

import { activeCodexMultiAgentMode, redirectCodexUltraEffort } from './ultra-redirect.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

const proactive = '<multi_agent_mode>Proactive multi-agent delegation is active. Use sub-agents when parallel work helps.</multi_agent_mode>';
const explicit = '<multi_agent_mode>Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents.</multi_agent_mode>';

const developer = (text: string): ResponsesInputItem => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text }],
});

const payload = (input: ResponsesInputItem[], effort = 'max'): CanonicalResponsesPayload => ({
  model: 'model-a',
  input,
  reasoning: { effort, summary: 'detailed' },
});

describe('Codex Ultra effort redirect', () => {
  test('maps the max wire value only when the latest mode is Proactive', () => {
    const source = payload([developer(explicit), developer(proactive)]);
    const result = redirectCodexUltraEffort(source, 'medium');
    expect(result.reasoning).toEqual({ effort: 'medium', summary: 'detailed' });
    expect(source.reasoning).toEqual({ effort: 'max', summary: 'detailed' });
  });

  test('keeps explicit Max after a previous Ultra mode', () => {
    const source = payload([developer(proactive), developer(explicit)]);
    expect(activeCodexMultiAgentMode(source.input)).toBe('explicit-request-only');
    expect(redirectCodexUltraEffort(source, 'low')).toBe(source);
  });

  test('fails open when a newer custom mode supersedes Proactive', () => {
    const source = payload([
      developer(proactive),
      developer('<multi_agent_mode>Use a custom delegation policy.</multi_agent_mode>'),
    ]);
    expect(activeCodexMultiAgentMode(source.input)).toBe('unknown');
    expect(redirectCodexUltraEffort(source, 'high')).toBe(source);
  });

  test('finds the last mode block within a bundled developer message', () => {
    const source = payload([developer(`${proactive}\n${explicit}\n${proactive}`)]);
    expect(activeCodexMultiAgentMode(source.input)).toBe('proactive');
    expect(redirectCodexUltraEffort(source, 'xhigh').reasoning?.effort).toBe('xhigh');
  });

  test('preserves a direct open-string ultra wire value', () => {
    const source = payload([developer(proactive)], 'ultra');
    expect(redirectCodexUltraEffort(source, 'future-tier')).toBe(source);
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'future-tier'])('preserves non-Ultra effort %s', effort => {
    const source = payload([developer(proactive)], effort);
    expect(redirectCodexUltraEffort(source, 'low')).toBe(source);
  });

  test('ignores user-authored mode tags', () => {
    const source = payload([{ type: 'message', role: 'user', content: proactive }]);
    expect(activeCodexMultiAgentMode(source.input)).toBe('unknown');
    expect(redirectCodexUltraEffort(source, 'low')).toBe(source);
  });
});
