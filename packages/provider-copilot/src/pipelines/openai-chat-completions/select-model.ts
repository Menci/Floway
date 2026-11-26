import { selectCopilotRawModel } from '../../model-selection.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';

export const selectModel = rewritePayload('openaiChatCompletions', 'selectModel', (payload, model) => {
  // Copilot Chat Completions reports the base tier even if a fast id is used.
  // https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
  const effort = payload.reasoning_effort;
  return {
    ...payload,
    model: selectCopilotRawModel(model, 'openaiChatCompletions', { reasoningEffort: effort === 'none' ? undefined : effort ?? undefined }),
  };
});
