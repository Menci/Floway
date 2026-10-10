import type { AnthropicMessagesContentBlockDeltaEvent, AnthropicMessagesContentBlockStartEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi } from '@floway-dev/provider';

export const isFirstOutputTokenFrame = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): boolean => {
  if (frame.type === 'done') return false;

  const event = frame.event as Record<string, unknown>;
  if (targetApi === 'anthropicMessages') return isAnthropicMessagesOutputEvent(event);
  if (targetApi === 'openaiResponses') return isOpenAIResponsesOutputEvent(event);
  return isOpenAIChatCompletionsOutputEvent(event);
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isAnthropicMessagesOutputEvent = (event: Record<string, unknown>): boolean => {
  // A tool name can arrive before its streamed JSON input; it is already model output.
  // https://platform.claude.com/docs/en/build-with-claude/streaming#input-json-delta
  if (event.type === 'content_block_start') {
    const block = event.content_block as AnthropicMessagesContentBlockStartEvent['content_block'] | undefined;
    if (!block) return false;
    switch (block.type) {
    case 'tool_use':
    case 'server_tool_use': return nonEmptyString(block.name);
    case 'text': return nonEmptyString(block.text);
    case 'thinking': return nonEmptyString(block.thinking);
    default: return false;
    }
  }
  if (event.type !== 'content_block_delta') return false;
  const delta = event.delta as AnthropicMessagesContentBlockDeltaEvent['delta'] | undefined;
  if (!delta) return false;
  switch (delta.type) {
  case 'text_delta': return nonEmptyString(delta.text);
  case 'thinking_delta': return nonEmptyString(delta.thinking);
  case 'input_json_delta': return nonEmptyString(delta.partial_json);
  case 'citations_delta': return delta.citation !== undefined;
  // Compaction is a separate inference iteration, excluded from the top-level
  // output token count used by performance telemetry.
  // https://github.com/anthropics/anthropic-sdk-python/blob/b4b7916deaf4e5570cd627b1ae7ee4394a4de39f/src/anthropic/types/beta/beta_usage.py#L50-L56
  case 'compaction_delta': return false;
  default: return false;
  }
};

const hasResponsesText = (part: unknown): boolean => {
  const content = part as { text?: unknown; refusal?: unknown };
  return nonEmptyString(content.text) || nonEmptyString(content.refusal);
};

const hasWebSearchInput = (action: OpenAIResponsesWebSearchAction | undefined): boolean => {
  switch (action?.type) {
  case 'search': return nonEmptyString(action.query) || action.queries?.some(nonEmptyString) === true;
  case 'open_page': return nonEmptyString(action.url);
  case 'find_in_page': return nonEmptyString(action.url) || nonEmptyString(action.pattern);
  default: return false;
  }
};

// Known items expose generated input separately from execution results and
// replay metadata. New modeled types must state their output fields here;
// unrecognized wire types use their item announcement as the timing boundary.
// https://github.com/openai/openai-python/blob/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses/response_output_item.py#L46-L328
const RESPONSES_ITEM_OUTPUT = {
  message: item => item.content.some(hasResponsesText),
  reasoning: item => item.summary.some(hasResponsesText) || item.content?.some(hasResponsesText) === true,
  function_call: item => nonEmptyString(item.name) || nonEmptyString(item.arguments),
  custom_tool_call: item => nonEmptyString(item.name) || nonEmptyString(item.input),
  mcp_call: item => nonEmptyString(item.name) || nonEmptyString(item.arguments),
  mcp_approval_request: item => nonEmptyString(item.name) || nonEmptyString(item.arguments),
  web_search_call: item => hasWebSearchInput(item.action),
  file_search_call: item => item.queries.some(nonEmptyString),
  computer_call: item => item.action !== undefined || (item.actions !== undefined && item.actions.length > 0),
  tool_search_call: item => item.arguments !== undefined && item.arguments !== null && (typeof item.arguments !== 'string' || nonEmptyString(item.arguments)),
  program: item => nonEmptyString(item.code),
  agent_message: item => item.content.some(hasResponsesText),
  multi_agent_call: item => nonEmptyString(item.action) || nonEmptyString(item.arguments),
  code_interpreter_call: item => nonEmptyString(item.code),
  local_shell_call: item => item.action.command.some(nonEmptyString),
  shell_call: item => item.action.commands.some(nonEmptyString),
  apply_patch_call: item => nonEmptyString(item.operation.path) || ('diff' in item.operation && nonEmptyString(item.operation.diff)),
  // The mainline model generates revised_prompt; result is the hosted image tool's output.
  // https://developers.openai.com/api/docs/guides/tools-image-generation#revised-prompt
  image_generation_call: item => nonEmptyString(item.revised_prompt),
  function_call_output: () => false,
  custom_tool_call_output: () => false,
  computer_call_output: () => false,
  tool_search_output: () => false,
  program_output: () => false,
  multi_agent_call_output: () => false,
  local_shell_call_output: () => false,
  shell_call_output: () => false,
  apply_patch_call_output: () => false,
  additional_tools: () => false,
  mcp_list_tools: () => false,
  mcp_approval_response: () => false,
  compaction: () => false,
  compaction_summary: () => false,
  context_compaction: () => false,
} satisfies {
  [Type in OpenAIResponsesOutputItemEx['type']]: (item: OpenAIResponsesOutputItemEx & { type: Type }) => boolean;
};

const isResponsesItemOutput = (item: OpenAIResponsesOutputItemEx, added: boolean): boolean => {
  if (!Object.hasOwn(RESPONSES_ITEM_OUTPUT, item.type)) return added;
  const read = RESPONSES_ITEM_OUTPUT[item.type] as (item: OpenAIResponsesOutputItemEx) => boolean;
  return read(item);
};

// Some fields arrive atomically in item/part or content completion events.
// Their payload still marks first output when no earlier delta carried data.
// https://github.com/openai/openai-python/tree/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses
const isOpenAIResponsesOutputEvent = (event: Record<string, unknown>): boolean => {
  switch (event.type) {
  case 'response.output_item.added':
  case 'response.output_item.done': return isResponsesItemOutput(event.item as OpenAIResponsesOutputItemEx, event.type === 'response.output_item.added');
  case 'response.content_part.added':
  case 'response.content_part.done':
  case 'response.reasoning_summary_part.added':
  case 'response.reasoning_summary_part.done': return hasResponsesText(event.part);
  case 'response.output_text.done':
  case 'response.reasoning.done':
  case 'response.reasoning_text.done':
  case 'response.reasoning_summary_text.done': return nonEmptyString(event.text);
  case 'response.refusal.done': return nonEmptyString(event.refusal);
  case 'response.function_call_arguments.done':
  case 'response.mcp_call_arguments.done': return nonEmptyString(event.arguments);
  case 'response.custom_tool_call_input.done': return nonEmptyString(event.input);
  case 'response.code_interpreter_call_code.done': return nonEmptyString(event.code);
  case 'response.shell_call_command.added':
  case 'response.shell_call_command.done': return nonEmptyString(event.command);
  case 'response.apply_patch_call_operation_diff.done': return nonEmptyString(event.diff);
  default: return typeof event.type === 'string' && event.type.startsWith('response.') && event.type.endsWith('.delta') && nonEmptyString(event.delta);
  }
};

// Tool identity fields are envelopes; names and input are generated output.
// https://github.com/openai/openai-python/blob/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/chat/chat_completion_chunk.py#L37-L79
const hasToolCallOutput = (call: { function?: { name?: string; arguments?: string }; custom?: { name?: string; input?: string } }): boolean =>
  nonEmptyString(call.function?.name) || nonEmptyString(call.function?.arguments)
  || nonEmptyString(call.custom?.name) || nonEmptyString(call.custom?.input);

// Readable reasoning can stream exclusively in structured carriers. Signatures
// and encrypted replay data alone do not establish a generated-text boundary.
// https://github.com/OpenRouterTeam/docs/blob/427f46bb902c41b6c475dc46e9541c2c4ab9cc90/guides/best-practices/reasoning-tokens.mdx
const hasReasoningDetailsOutput = (details: unknown): boolean => Array.isArray(details) && details.some((detail: { type?: string; text?: string; summary?: string }) =>
  (detail.type === 'reasoning.text' && nonEmptyString(detail.text))
  || (detail.type === 'reasoning.summary' && nonEmptyString(detail.summary)));

const hasReasoningItemsOutput = (items: unknown): boolean => Array.isArray(items) && items.some((item: OpenAIChatCompletionsReasoningItem) =>
  item.type === 'reasoning' && item.summary?.some(part => nonEmptyString(part.text)) === true);

const isOpenAIChatCompletionsOutputEvent = (event: Record<string, unknown>): boolean => {
  const choices = event.choices as OpenAIChatCompletionsStreamEvent['choices'] | undefined;
  return Array.isArray(choices) && choices.some(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx | undefined;
    if (!delta) return false;
    return nonEmptyString(delta.content) || nonEmptyString(delta.refusal)
      || nonEmptyString(delta.reasoning) || nonEmptyString(delta.reasoning_content) || nonEmptyString(delta.reasoning_text)
      || nonEmptyString(delta.audio?.data) || nonEmptyString(delta.audio?.transcript)
      || (delta.function_call !== undefined && hasToolCallOutput({ function: delta.function_call }))
      || delta.tool_calls?.some(hasToolCallOutput) === true
      || hasReasoningDetailsOutput(delta.reasoning_details) || hasReasoningItemsOutput(delta.reasoning_items);
  });
};
