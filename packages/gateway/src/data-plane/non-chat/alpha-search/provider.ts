import { defineStage } from '../../pipeline/facts.ts';
import { chatgptPipelines } from '@floway-dev/upstream-chatgpt';
import { customPipelines } from '@floway-dev/upstream-custom';

export const targets = {
  chatgpt: chatgptPipelines.alphaSearch,
  custom: customPipelines.alphaSearch,
};

const boundary = {
  request: { needs: ['http', 'upstream', 'model', 'alphaSearch'], provides: [], consumes: [] },
  response: { needs: ['http', 'alphaSearch'], provides: [], consumes: [] },
} as const;

export const provider = defineStage({
  name: 'alphaSearch.provider',
  request: { needs: ['http', 'upstream', 'model', 'alphaSearch'] },
  into: { chatgpt: boundary, custom: boundary },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind !== 'chatgpt' && kind !== 'custom') throw new Error(`The ${kind} upstream has no Alpha Search pipeline`);
    return await scope.into[kind](facts);
  },
});
