import { defineStage, type OperationEvent } from '../../../src/data-plane/pipeline/facts.ts';
import { toProviderModelFact, type ProtocolStreamError } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

export const meteredStream = ({ failure, release }: { failure?: ProtocolStreamError; release?: Promise<void> } = {}) => defineStage({
  name: 'streaming-completions-fixture',
  request: { needs: [] },
  return: { provides: ['response.http', 'response.openaiCompletions', 'response.usageModelKey'] },
  async execute(_facts, scope) {
    const stream = scope.createStream<OperationEvent<'openaiCompletions'>, ProtocolStreamError>(async function* () {
      yield {
        ok: true,
        value: { id: 'generated', object: 'text_completion', created: 0, model: 'native', choices: [{ index: 0, text: 'output' }] },
      };
      await release;
      if (failure) yield { ok: false, error: failure };
    });
    return {
      'response.http': { status: 200, statusText: '', body: null, headers: [], startedAt: performance.now() - 20 },
      'response.openaiCompletions': { kind: 'stream', stream },
      'response.usageModelKey': 'native-fast-variant',
    };
  },
});

export const testCandidate = defineStage({
  name: 'streaming-completions-candidate',
  through: {
    request: { needs: [], provides: ['provider.upstream', 'provider.model'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    return await scope.next({
      ...facts,
      'provider.upstream': { id: 'upstream', name: 'Upstream', kind: 'custom', config: {} },
      'provider.model': toProviderModelFact(stubProviderModel()),
    });
  },
});
