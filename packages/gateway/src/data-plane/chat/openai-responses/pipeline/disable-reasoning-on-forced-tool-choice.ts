import { openAIResponsesFactSpace } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';

const { defineStage } = openAIResponsesFactSpace<{}>();

const hasForcedToolChoice = ({ tool_choice: choice }: OpenAIResponsesPayloadEx): boolean =>
  choice != null && (typeof choice !== 'string' || choice === 'required');

export const disableOpenAIResponsesReasoningOnForcedToolChoice = defineStage({
  name: 'openaiResponses.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      if (!facts['serve.candidate'].model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')
        || !hasForcedToolChoice(payload)) return facts;
      return { ...facts, 'request.openaiResponses': move({ ...payload, reasoning: { effort: 'none' } }) };
    },
  })),
});
