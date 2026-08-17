// A provider is handed a body it owns.
//
// Provider interceptors shape their payload in place — Copilot marks individual messages for
// caching — and the record they are built from is deep-frozen. A copy that stopped at the top
// level would satisfy every type in the system and still throw at the dial, so the depth of it
// is the property worth pinning.

import { describe, it } from 'vitest';

import { bodyForAttempt } from '../../../src/data-plane/pipeline/attempt-body.ts';
import { move } from '@floway-dev/pipeline';
import type { ModelCandidate } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const candidateFor = (id: string, rules?: ModelCandidate['rules']): ModelCandidate =>
  ({ model: { id }, ...(rules === undefined ? {} : { rules }) }) as ModelCandidate;

const recordedRequest = () => {
  const { request } = move({
    request: {
      model: 'alias-name',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    },
  });
  return request;
};

describe('bodyForAttempt', () => {
  it('hands over children a provider can write into', () => {
    const body = bodyForAttempt(recordedRequest(), candidateFor('upstream-model'), () => {});

    // What the Copilot cache-control rule does, at the node it does it to.
    const message = body.messages[0] as Record<string, unknown>;
    message.copilot_cache_control = { type: 'ephemeral' };
    assertEquals(message.copilot_cache_control, { type: 'ephemeral' });
  });

  it('leaves the record it was built from untouched', () => {
    const recorded = recordedRequest();
    const body = bodyForAttempt(recorded, candidateFor('upstream-model'), () => {});
    (body.messages[0] as Record<string, unknown>).copilot_cache_control = { type: 'ephemeral' };

    assertEquals('copilot_cache_control' in recorded.messages[0], false);
    assertEquals(recorded.model, 'alias-name');
  });

  it('addresses the model the candidate resolved and drops the one the client named', () => {
    const body = bodyForAttempt(recordedRequest(), candidateFor('upstream-model'), () => {});
    assertEquals('model' in body, false);
  });

  it('applies the alias rules over the copy', () => {
    const rules = { reasoning: { effort: 'high' } } as NonNullable<ModelCandidate['rules']>;
    const body = bodyForAttempt(
      recordedRequest(),
      candidateFor('upstream-model', rules),
      (payload, applied) => { (payload as Record<string, unknown>).reasoning_effort = applied.reasoning?.effort; },
    );
    assertEquals((body as Record<string, unknown>).reasoning_effort, 'high');
  });

  it('applies nothing where the alias carries no rules', () => {
    let ran = false;
    bodyForAttempt(recordedRequest(), candidateFor('upstream-model'), () => { ran = true; });
    assertEquals(ran, false);
  });
});
