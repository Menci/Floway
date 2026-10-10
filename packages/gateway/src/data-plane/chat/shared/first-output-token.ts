import type { AnthropicMessagesContentBlockDeltaEvent, AnthropicMessagesContentBlockStartEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';
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

// Model-output item announcements approximate decode starting, even when the
// producer opens an empty body after receiving sampled output. Private reasoning
// need not expose a summary, so waiting for its text would count decode as prefill.
// https://github.com/vllm-project/vllm/blob/3709632ff2944a5f2ecdacc84ede5cd134b7ae08/vllm/entrypoints/openai/responses/streaming_events.py#L562-L595
// https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries
// Unknown wire types start timing at their announcement.
const RESPONSES_ITEM_DECODE_SIGNALS = {
  message: true,
  reasoning: true,
  function_call: true,
  custom_tool_call: true,
  mcp_call: true,
  mcp_approval_request: true,
  web_search_call: true,
  file_search_call: true,
  computer_call: true,
  tool_search_call: true,
  program: true,
  agent_message: true,
  multi_agent_call: true,
  code_interpreter_call: true,
  local_shell_call: true,
  shell_call: true,
  apply_patch_call: true,
  image_generation_call: true,

  // Tool/agent runtimes supply execution results; their arrival does not mark
  // this response's model starting to decode. Execution may be client- or
  // server-side, as tool_search_output explicitly supports both.
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L7156-L7190
  function_call_output: false,
  custom_tool_call_output: false,
  computer_call_output: false,
  tool_search_output: false,
  program_output: false,
  multi_agent_call_output: false,
  local_shell_call_output: false,
  shell_call_output: false,
  apply_patch_call_output: false,

  // Tool definitions and approval decisions are configuration/control state,
  // even when returned as output items; their direction alone is not the reason
  // for exclusion. An approval response records the caller's decision, whereas
  // an approval request above exposes the model-selected invocation.
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5116-L5136
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5399-L5425
  additional_tools: false,
  mcp_approval_response: false,

  // MCP discovery can emit a populated tool list before inference is invoked;
  // it establishes available tools, not a model-selected call.
  // https://github.com/sgl-project/sglang/blob/de487f8039e06853b5f376fd5f068ea9d7c400bb/sgl-model-gateway/src/routers/grpc/regular/responses/streaming.rs#L542-L613
  mcp_list_tools: false,

  // Compaction can involve inference and appear in the response stream before
  // normal inference continues. We exclude its context-maintenance boundary
  // from ordinary response timing; the resulting state can also be replayed
  // as input in later turns.
  // https://developers.openai.com/api/docs/guides/compaction
  // https://github.com/openai/codex/blob/e0a64cf2bc4535eb330c22857260a7856c1e8749/codex-rs/protocol/src/models.rs#L1226-L1252
  compaction: false,
  compaction_summary: false,
  context_compaction: false,
} satisfies Record<OpenAIResponsesOutputItemEx['type'], boolean>;

const isResponsesDecodeItem = (item: OpenAIResponsesOutputItemEx, added: boolean): boolean =>
  Object.hasOwn(RESPONSES_ITEM_DECODE_SIGNALS, item.type) ? RESPONSES_ITEM_DECODE_SIGNALS[item.type] : added;

// Streams can expose their first decode evidence as an item announcement or
// atomically completed content. Both complement streamed string deltas.
// https://github.com/openai/openai-python/tree/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses
const isOpenAIResponsesOutputEvent = (event: Record<string, unknown>): boolean => {
  switch (event.type) {
  case 'response.output_item.added':
  case 'response.output_item.done': return isResponsesDecodeItem(event.item as OpenAIResponsesOutputItemEx, event.type === 'response.output_item.added');
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
