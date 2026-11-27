import { lowerOpenAIResponsesAgentMessage } from './agent-message.ts';
import { normalizeOpenAIResponsesAssistantInput } from './assistant-input.ts';
import { applyOpenAIResponsesCollaboration } from './collaboration.ts';
import { compactOpenAIResponsesHistory } from './compaction.ts';
import { normalizeOpenAIResponsesEmptyToolsToolChoice } from './empty-tools-tool-choice.ts';
import { nullOpenAIResponsesUnresolvedFunctionCallNamespace } from './function-call-namespace.ts';
import { disableOpenAIResponsesReasoningOnForcedToolChoice } from './reasoning-tool-choice.ts';
import { lowerOpenAIResponsesStandaloneToolOutput } from './standalone-tool-output.ts';
import { answerOpenAIResponsesWebSocketWarmup } from './warmup.ts';

export const openaiResponsesBodyBeforeHostedTools = [
  answerOpenAIResponsesWebSocketWarmup,
  normalizeOpenAIResponsesAssistantInput,
  lowerOpenAIResponsesAgentMessage,
  lowerOpenAIResponsesStandaloneToolOutput,
  compactOpenAIResponsesHistory,
  applyOpenAIResponsesCollaboration,
] as const;

export const openaiResponsesBodyAfterHostedTools = [
  nullOpenAIResponsesUnresolvedFunctionCallNamespace,
  disableOpenAIResponsesReasoningOnForcedToolChoice,
  normalizeOpenAIResponsesEmptyToolsToolChoice,
] as const;
