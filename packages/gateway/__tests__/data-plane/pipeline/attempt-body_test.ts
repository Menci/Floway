// A provider is handed the record's own values.
//
// Nothing is deep-copied: the object built here exists to carry the addressed model and then
// drop it, and everything under it is the record's, frozen. A provider that tried to shape its
// payload by writing into what it was given would be writing into a fact — so what is pinned
// here is that the refusal reaches it, at the depth where the rule that used to do it worked.

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
  it('hands over children no one can write into', () => {
    const recorded = recordedRequest();
    const body = bodyForAttempt(recorded, candidateFor('upstream-model'), body => body);

    // What the Copilot cache-control rule used to do, at the node it did it to. It rebuilds
    // now, and this is why: the message it was reaching into is the record's own.
    let refused: unknown;
    try {
      (body.messages[0] as Record<string, unknown>).copilot_cache_control = { type: 'ephemeral' };
    } catch (error) { refused = error; }

    assertEquals(refused instanceof TypeError, true);
    assertEquals('copilot_cache_control' in recorded.messages[0], false);
    assertEquals(recorded.model, 'alias-name');
  });

  it('addresses the model the candidate resolved and drops the one the client named', () => {
    const body = bodyForAttempt(recordedRequest(), candidateFor('upstream-model'), body => body);
    assertEquals('model' in body, false);
  });

  it('applies the alias rules over the body it addressed', () => {
    const rules = { reasoning: { effort: 'high' } } as NonNullable<ModelCandidate['rules']>;
    let addressed: string | undefined;
    const body = bodyForAttempt(
      recordedRequest(),
      candidateFor('upstream-model', rules),
      (payload, applied) => {
        addressed = payload.model;
        return { ...payload, reasoning_effort: applied.reasoning?.effort };
      },
    );
    assertEquals((body as Record<string, unknown>).reasoning_effort, 'high');
    // The overlay ran over the model this attempt is for rather than the alias the client
    // addressed, which is what lets a rule speak about the upstream it is actually dialling.
    assertEquals(addressed, 'upstream-model');
  });

  it('applies nothing where the alias carries no rules', () => {
    let ran = false;
    bodyForAttempt(recordedRequest(), candidateFor('upstream-model'), body => { ran = true; return body; });
    assertEquals(ran, false);
  });
});
