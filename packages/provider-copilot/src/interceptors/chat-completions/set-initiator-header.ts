import type { CopilotChatCompletionsBoundaryInterceptor } from './types.ts';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Chat Completions the
 * discriminator is the last message: when its role is `assistant` (model
 * replay) or `tool` (a tool result being fed back into the model), the agent
 * is driving the turn.
 *
 * Responses tool-output images expose a deliberate translation loss here:
 * Chat tool messages cannot carry image parts, so translation lifts them into
 * a legal user message after the contiguous tool results. The Chat wire role
 * remains authoritative, and that turn is therefore reported as user-initiated
 * even though its image originated in tool output. Preserving the source-side
 * provenance would require a contradictory out-of-band signal.
 *
 * Official clients do not offer one wire-derived rule to copy. VS Code keeps
 * image content on a private multimodal `role: "tool"` Chat message and lifts
 * only for Responses, while initiator provenance can travel separately from
 * serialized roles. Floway has neither private Chat tool-image syntax nor
 * client loop metadata; this remains a payload-shape heuristic, and translated
 * or synthetic final user messages can therefore be classified differently
 * from their source-side turn.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
 * - https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
 * - https://github.com/microsoft/vscode-prompt-tsx/blob/86cc3a025fb54b72b0b5be9ddbc786ea16ef4073/src/base/output/openaiConvert.ts#L15-L81
 * - https://github.com/microsoft/vscode/blob/fb5e582d1c8edb9ad0a69e50fe6f508a8c095466/extensions/copilot/src/platform/endpoint/node/responsesApi.ts#L419-L468
 * - https://github.com/microsoft/vscode/blob/fb5e582d1c8edb9ad0a69e50fe6f508a8c095466/extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts#L1453-L1474
 */
export const withInitiatorHeaderSet: CopilotChatCompletionsBoundaryInterceptor = async (ctx, _request, run) => {
  const lastMessage = ctx.payload.messages.at(-1);
  const agentInitiated = lastMessage?.role === 'assistant'
    || lastMessage?.role === 'tool';
  ctx.headers.set('x-initiator', agentInitiated ? 'agent' : 'user');

  return await run();
};
