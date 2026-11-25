import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

// The provider can translate OpenAI's `none` setting to its native wire.
// https://platform.openai.com/docs/api-reference/chat/create#chat-create-reasoning_effort
export const disableReasoningOnForcedToolChoice = defineStage({
  name: 'openaiChatCompletions.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts[key];
      if (!facts['serve.candidate'].model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice') || !hasForcedToolChoice(payload)) return facts;
      return { ...facts, [key]: move({ ...payload, reasoning_effort: 'none' }) };
    },
  })),
});

const hasForcedToolChoice = ({ tool_choice: choice }: OpenAIChatCompletionsPayloadEx): boolean =>
  choice != null && (typeof choice === 'string' ? choice === 'required' : true);
