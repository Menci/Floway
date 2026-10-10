
import type { IRJSONValue } from '../ir.ts';
import type { IRPath } from '../stream.ts';
import type { IATReference, IRReplayCandidate, OpenAIResponsesThinAssistantTurn } from '../thin-types.ts';
import { createIRRoundTripReplayCheck, verifyIRRoundTripReplayCheck } from './replay-check.ts';
import { replaceIRRoundTripReferences } from './thin-builder.ts';
import type { IRRoundTripAssistantTurnInspection, IRRoundTripConversationTurn, IRRoundTripReplayCheck } from './types.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputContent,
  OpenAIResponsesOutputContentBlock,
  OpenAIResponsesOutputItemEx,
  OpenAIResponsesOutputReasoning,
} from '@floway-dev/protocols/openai-responses';

export const OPENAI_RESPONSES_REPLAY_CHECK_VERSION = 1;

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];
export type OpenAIResponsesConversationTurn = IRRoundTripConversationTurn<'assistant' | 'bare', CanonicalOpenAIResponsesInputItem>;

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

type SplitResponsesDiscriminant<T> = T extends { type: infer Kind extends string }
  ? Kind extends string ? Omit<T, 'type'> & { type: Kind } : never
  : never;

type OpenAIResponsesReplayMessagePart = SplitResponsesDiscriminant<OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock>;

// These are assistant-produced entries in the Responses input item union.
// https://platform.openai.com/docs/api-reference/responses/create
const assistantItemTypeNames = [
  'reasoning', 'function_call', 'custom_tool_call', 'web_search_call', 'file_search_call', 'computer_call', 'tool_search_call',
  'program', 'agent_message', 'multi_agent_call', 'compaction', 'compaction_summary', 'context_compaction', 'image_generation_call',
  'code_interpreter_call', 'local_shell_call', 'shell_call', 'apply_patch_call', 'mcp_call', 'mcp_approval_request',
] as const;

const assistantItemTypes = new Set<string>(assistantItemTypeNames);

type OpenAIResponsesAssistantOutputItem = Extract<OpenAIResponsesOutputItemEx,
  | { type: 'message'; role: 'assistant' }
  | { type: (typeof assistantItemTypeNames)[number] }
>;

const isResponsesAssistantItem = (item: CanonicalOpenAIResponsesInputItem): boolean => item.type === 'message'
  ? item.role === 'assistant'
  : assistantItemTypes.has(item.type);

const reasoningBody = (item: Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }>): IRJSONValue | undefined => {
  const summary = item.summary.map(part => ({ type: part.type, text: part.text }));
  const content = item.content?.map(part => ({ type: part.type, text: part.text }));
  if (summary.length === 0 && (content === undefined || content.length === 0)) return undefined;
  return { type: 'reasoning', summary, ...(content === undefined ? {} : { content }) };
};

const responseMessagePartMaterial = (part: OpenAIResponsesReplayMessagePart): unknown => {
  if (part.type === 'input_text' || part.type === 'output_text') return {
    type: part.type,
    text: part.text,
    ...('prompt_cache_breakpoint' in part && part.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint } : {}),
  };
  if (part.type === 'input_image') return {
    type: part.type,
    image_url: part.image_url,
    file_id: part.file_id,
    detail: part.detail,
    ...(part.prompt_cache_breakpoint === undefined ? {} : { prompt_cache_breakpoint: part.prompt_cache_breakpoint }),
  };
  if (part.type === 'input_file') return { ...part };
  if (part.type === 'refusal') return { type: part.type, refusal: part.refusal };
  return part satisfies never;
};

const responseMessageContent = (content: string | Array<OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock>): unknown => {
  if (typeof content === 'string') return content;
  return content.map(part => responseMessagePartMaterial(part as OpenAIResponsesReplayMessagePart));
};

const replayItemMaterial = (item: OpenAIResponsesAssistantTurnItem): unknown => {
  if (item.type === 'reasoning') return typeof item.encrypted_content === 'string' ? reasoningBody(item) : item;
  if (item.type === 'message') return {
    type: item.type,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.status === undefined ? {} : { status: item.status }),
    role: item.role,
    content: responseMessageContent(item.content),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    ...('internal_chat_message_metadata_passthrough' in item ? { internal_chat_message_metadata_passthrough: item.internal_chat_message_metadata_passthrough } : {}),
  };
  if (item.type === 'function_call') return {
    type: item.type,
    ...(item.id === undefined ? {} : { id: item.id }),
    call_id: item.call_id,
    name: item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    ...(item.encrypted_function_args === undefined ? {} : { encrypted_function_args: item.encrypted_function_args }),
    arguments: item.arguments,
    ...(item.status === undefined ? {} : { status: item.status }),
    ...('async' in item && item.async !== undefined ? { async: item.async } : {}),
    ...(item.caller === undefined ? {} : { caller: item.caller as unknown as IRJSONValue }),
  };
  if (item.type === 'custom_tool_call') return {
    type: item.type,
    ...(item.id === undefined ? {} : { id: item.id }),
    call_id: item.call_id,
    name: item.name,
    input: item.input,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.caller === undefined ? {} : { caller: item.caller as unknown as IRJSONValue }),
  };
  return item;
};

const responsesReplayCheckMaterial = (turn: OpenAIResponsesAssistantTurn): unknown => turn.flatMap(item => {
  const material = replayItemMaterial(item);
  return material === undefined ? [] : [material];
});

const responseSidecars = (turn: OpenAIResponsesAssistantTurn): string[] => turn.flatMap(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string' ? [item.encrypted_content] : []);

const collectResponseContentCandidates = (candidates: IRReplayCandidate[], content: string | Array<OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock>): void => {
  if (typeof content === 'string') {
    candidates.push(content);
    return;
  }
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') candidates.push(part.text);
    else if (part.type === 'refusal') candidates.push(part.refusal);
  }
};

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: OpenAIResponsesConversationTurn[] = [];
  for (const item of input) {
    const role = isResponsesAssistantItem(item) ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(item);
    else turns.push({ role, items: [item] });
  }
  return turns;
};

export const inspectOpenAIResponsesAssistantTurn = (turn: OpenAIResponsesAssistantTurn): IRRoundTripAssistantTurnInspection => {
  const candidates: IRReplayCandidate[] = [];
  for (const item of turn) {
    if (item.type === 'message') collectResponseContentCandidates(candidates, item.content);
    else if (item.type === 'reasoning') {
      for (const part of item.summary) candidates.push(part.text);
      for (const part of item.content ?? []) candidates.push(part.text);
    } else if (item.type === 'function_call') candidates.push(item.arguments);
    else if (item.type === 'custom_tool_call') candidates.push(item.input);
    else if (item.type === 'image_generation_call' && typeof item.result === 'string') candidates.push(item.result);
  }
  return { sidecars: responseSidecars(turn), candidates, checkMaterial: responsesReplayCheckMaterial(turn) };
};

export const createOpenAIResponsesReplayCheck = async (turn: OpenAIResponsesAssistantTurn): Promise<IRRoundTripReplayCheck | undefined> => {
  const inspection = inspectOpenAIResponsesAssistantTurn(turn);
  return inspection.sidecars.length === 1
    ? await createIRRoundTripReplayCheck(inspection.checkMaterial, OPENAI_RESPONSES_REPLAY_CHECK_VERSION)
    : undefined;
};

export const verifyOpenAIResponsesReplayCheck = async (turn: OpenAIResponsesAssistantTurn, replayCheck: IRRoundTripReplayCheck): Promise<boolean> => {
  const inspection = inspectOpenAIResponsesAssistantTurn(turn);
  return await (inspection.sidecars.length === 1 && verifyIRRoundTripReplayCheck(inspection.checkMaterial, replayCheck, OPENAI_RESPONSES_REPLAY_CHECK_VERSION));
};

export const cleanOpenAIResponsesAssistantTurn = (turn: OpenAIResponsesAssistantTurn): OpenAIResponsesAssistantTurn =>
  turn.filter(item => item.type !== 'reasoning' || typeof item.encrypted_content !== 'string');

export const createOpenAIResponsesSidecarCarrier = (id: string, data: string): OpenAIResponsesSidecarCarrier => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: data,
});

const responsesThinReferencePaths = (turn: readonly CanonicalOpenAIResponsesInputItem[]): IRPath[] => {
  const paths: IRPath[] = [];
  turn.forEach((item, itemIndex) => {
    if (item.type === 'message' && item.role === 'assistant') {
      if (typeof item.content === 'string') paths.push([itemIndex, 'content']);
      else item.content.forEach((part, contentIndex) => {
        if (part.type === 'input_text' || part.type === 'output_text') paths.push([itemIndex, 'content', contentIndex, 'text']);
        else if (part.type === 'refusal') paths.push([itemIndex, 'content', contentIndex, 'refusal']);
      });
    } else if (item.type === 'reasoning') {
      item.summary.forEach((_part, summaryIndex) => paths.push([itemIndex, 'summary', summaryIndex, 'text']));
      item.content?.forEach((_part, contentIndex) => paths.push([itemIndex, 'content', contentIndex, 'text']));
    } else if (item.type === 'function_call') paths.push([itemIndex, 'arguments']);
    else if (item.type === 'custom_tool_call') paths.push([itemIndex, 'input']);
    else if (item.type === 'image_generation_call' && typeof item.result === 'string') paths.push([itemIndex, 'result']);
  });
  return paths;
};

const outputContentToHistoryContent = (part: OpenAIResponsesOutputContentBlock): OpenAIResponsesInputContent => part.type === 'output_text'
  ? { type: 'output_text', text: part.text }
  : part;

const outputItemToHistoryItem = (item: OpenAIResponsesAssistantOutputItem): CanonicalOpenAIResponsesInputItem => {
  if (item.type === 'message') return {
    type: 'message',
    role: item.role,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    content: item.content.map(outputContentToHistoryContent),
  };
  return item;
};

export const buildOpenAIResponsesThinAssistantTurn = (
  turn: readonly OpenAIResponsesAssistantOutputItem[],
  referencesByProtocolPath: ReadonlyMap<string, IATReference>,
): OpenAIResponsesThinAssistantTurn<IATReference> => {
  const historyTurn = turn.map(outputItemToHistoryItem);
  return replaceIRRoundTripReferences(
    historyTurn,
    referencesByProtocolPath,
    responsesThinReferencePaths(historyTurn),
  ) as OpenAIResponsesThinAssistantTurn<IATReference>;
};
