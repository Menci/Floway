import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesContentBlockDeltaEvent, AnthropicMessagesContentBlockStartEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi } from '@floway-dev/provider';

type FirstOutputTokenSignal =
  | { type: 'decode' }
  | { type: 'runtime-output'; outputType: string };

const decodeSignal = (hasOutput: boolean): FirstOutputTokenSignal | null => hasOutput ? { type: 'decode' } : null;

export const firstOutputTokenSignal = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): FirstOutputTokenSignal | null => {
  if (frame.type === 'done') return null;

  const event = frame.event as Record<string, unknown>;
  if (targetApi === 'anthropicMessages') return anthropicMessagesTimingSignal(event);
  if (targetApi === 'openaiResponses') return responsesTimingSignal(event);
  return decodeSignal(isOpenAIChatCompletionsOutputEvent(event));
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// Empty text blocks can be announced before upstream generation is invoked.
// Thinking blocks observed in model-backed producers instead follow generated
// reasoning, including hidden thinking that never exposes readable text.
// https://github.com/xwteam/gemini2api/blob/6b60269a93f075b7cd71d3e0b3161956f10aadef/app/routers/claude.py#L218-L246
// https://github.com/vllm-project/vllm/blob/3709632ff2944a5f2ecdacc84ede5cd134b7ae08/vllm/entrypoints/anthropic/serving.py#L1065-L1093
// https://platform.claude.com/docs/en/build-with-claude/streaming#thinking-delta
const ANTHROPIC_BLOCK_TIMING_SIGNALS = {
  text: null,
  thinking: 'decode',
  redacted_thinking: 'decode',
  tool_use: 'decode',
  server_tool_use: 'decode',
  mcp_tool_use: 'decode',
  // Results normally follow model-selected calls, but a resumed server-tool
  // execution can also begin a response without a new model sampling step.
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools#the-server_tool_use-block
  web_search_tool_result: 'runtime-output',
  web_fetch_tool_result: 'runtime-output',
  advisor_tool_result: 'runtime-output',
  code_execution_tool_result: 'runtime-output',
  bash_code_execution_tool_result: 'runtime-output',
  text_editor_code_execution_tool_result: 'runtime-output',
  tool_search_tool_result: 'runtime-output',
  mcp_tool_result: 'runtime-output',
  // Uploaded files, tool discovery, model transitions and context maintenance
  // are preparation/control state, not ordinary model-output boundaries.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/2979ed5cef4b2f059b95af23e08728c01e588f86/src/resources/beta/messages/messages.ts#L4869-L4887
  container_upload: null,
  mcp_tool_listing: null,
  fallback: null,
  compaction: null,
} satisfies Record<AnthropicMessagesAssistantContentBlock['type'], FirstOutputTokenSignal['type'] | null>;

const anthropicMessagesTimingSignal = (event: Record<string, unknown>): FirstOutputTokenSignal | null => {
  if (event.type === 'content_block_start') {
    const block = event.content_block as AnthropicMessagesContentBlockStartEvent['content_block'];
    if (block.type === 'text') return decodeSignal(nonEmptyString(block.text));
    if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
      if (!nonEmptyString(block.name)) return null;
      // A program can invoke tools without sampling the model again. Its
      // original code-execution call normally already established timing.
      // https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling#the-caller-field-in-responses
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.caller !== undefined && block.caller.type !== 'direct') {
        return { type: 'runtime-output', outputType: block.type };
      }
    }
    if (!Object.hasOwn(ANTHROPIC_BLOCK_TIMING_SIGNALS, block.type)) return null;
    const disposition = ANTHROPIC_BLOCK_TIMING_SIGNALS[block.type];
    return disposition === 'runtime-output' ? { type: disposition, outputType: block.type } : decodeSignal(disposition === 'decode');
  }
  if (event.type !== 'content_block_delta') return null;
  const delta = event.delta as AnthropicMessagesContentBlockDeltaEvent['delta'];
  if (!Object.hasOwn(ANTHROPIC_DELTA_OUTPUT_FIELDS, delta.type)) return null;
  const field = ANTHROPIC_DELTA_OUTPUT_FIELDS[delta.type];
  if (field === undefined || field === null) return null;
  const value = (delta as unknown as Record<string, unknown>)[field];
  return decodeSignal(field === 'citation' ? value !== undefined : nonEmptyString(value));
};

// Signatures normally follow the thinking block that started timing. Compaction
// is a separate inference iteration excluded from ordinary output token usage.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/2979ed5cef4b2f059b95af23e08728c01e588f86/src/resources/beta/messages/messages.ts#L6139-L6145
// https://github.com/anthropics/anthropic-sdk-python/blob/b4b7916deaf4e5570cd627b1ae7ee4394a4de39f/src/anthropic/types/beta/beta_usage.py#L38-L72
const ANTHROPIC_DELTA_OUTPUT_FIELDS = {
  text_delta: 'text',
  thinking_delta: 'thinking',
  input_json_delta: 'partial_json',
  citations_delta: 'citation',
  signature_delta: null,
  compaction_delta: null,
} satisfies Record<AnthropicMessagesContentBlockDeltaEvent['delta']['type'], string | null>;

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
const RESPONSES_ITEM_TIMING_SIGNALS = {
  message: 'decode',
  reasoning: 'decode',
  function_call: 'decode',
  custom_tool_call: 'decode',
  mcp_call: 'decode',
  mcp_approval_request: 'decode',
  web_search_call: 'decode',
  file_search_call: 'decode',
  computer_call: 'decode',
  tool_search_call: 'decode',
  program: 'decode',
  agent_message: 'decode',
  multi_agent_call: 'decode',
  code_interpreter_call: 'decode',
  local_shell_call: 'decode',
  shell_call: 'decode',
  apply_patch_call: 'decode',
  image_generation_call: 'decode',

  // Client-tool results, supplied tool definitions, and approval decisions
  // normally enter request input, rather than response output. The output
  // schema also admits them, so exclude them if returned:
  // they carry external results/control state, not the start of model decode.
  // https://developers.openai.com/api/docs/guides/function-calling#how-it-works
  // https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input
  // https://developers.openai.com/api/docs/guides/tools-connectors-mcp#approvals
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5726-L5754
  function_call_output: null,
  custom_tool_call_output: null,
  computer_call_output: null,
  local_shell_call_output: null,
  apply_patch_call_output: null,
  additional_tools: null,
  mcp_approval_response: null,

  // Hosted runtime results normally follow a call/program item that has already
  // started timing. If the earlier signal is missing, start timing at the result
  // and warn that no earlier decode signal was observed in this response.
  // Client-executed tool search and shell results follow the input pattern above.
  // https://developers.openai.com/api/docs/guides/tools-tool-search#hosted-tool-search
  // https://developers.openai.com/api/docs/guides/tools-shell#shell-output-in-responses
  // https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling#understand-program-response-items
  tool_search_output: 'runtime-output',
  program_output: 'runtime-output',
  multi_agent_call_output: 'runtime-output',
  shell_call_output: 'runtime-output',

  // MCP discovery can emit a populated tool list before inference is invoked;
  // it establishes available tools, not a model-selected call.
  // https://github.com/sgl-project/sglang/blob/de487f8039e06853b5f376fd5f068ea9d7c400bb/sgl-model-gateway/src/routers/grpc/regular/responses/streaming.rs#L542-L613
  mcp_list_tools: null,

  // Compaction can involve inference and appear in the response stream before
  // normal inference continues. We exclude its context-maintenance boundary
  // from ordinary response timing; the resulting state can also be replayed
  // as input in later turns.
  // https://developers.openai.com/api/docs/guides/compaction
  // https://github.com/openai/codex/blob/e0a64cf2bc4535eb330c22857260a7856c1e8749/codex-rs/protocol/src/models.rs#L1226-L1252
  compaction: null,
  compaction_summary: null,
  context_compaction: null,
} satisfies Record<OpenAIResponsesOutputItemEx['type'], 'decode' | 'runtime-output' | null>;

const responsesItemTimingSignal = (item: OpenAIResponsesOutputItemEx | null, added: boolean): FirstOutputTokenSignal | null => {
  if (item === null) return null;
  const disposition = Object.hasOwn(RESPONSES_ITEM_TIMING_SIGNALS, item.type)
    ? RESPONSES_ITEM_TIMING_SIGNALS[item.type]
    : added ? 'decode' : null;
  if (disposition === null) return null;
  // Program-authored calls follow the earlier model-generated program rather
  // than demonstrating a fresh model decode step.
  // https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling#understand-program-response-items
  if (disposition === 'decode' && 'caller' in item && item.caller?.type === 'program') {
    return { type: 'runtime-output', outputType: item.type };
  }
  return disposition === 'runtime-output' ? { type: disposition, outputType: item.type } : { type: disposition };
};

const responsesTimingSignal = (event: Record<string, unknown>): FirstOutputTokenSignal | null => {
  switch (event.type) {
  case 'response.output_item.added':
  case 'response.output_item.done':
    return responsesItemTimingSignal(event.item as OpenAIResponsesOutputItemEx | null, event.type === 'response.output_item.added');
  // Shell output deltas carry stdout/stderr objects, not model-generated strings.
  // https://github.com/openai/openai-node/blob/1bbc425c836eca65222e7a3a2e79e53a6881ce9c/src/resources/responses/responses.ts#L7769-L7886
  case 'response.shell_call_output_content.delta': {
    const delta = event.delta as { stdout?: string; stderr?: string };
    return nonEmptyString(delta.stdout) || nonEmptyString(delta.stderr) ? { type: 'runtime-output', outputType: 'shell_call_output' } : null;
  }
  case 'response.shell_call_output_content.done': return { type: 'runtime-output', outputType: 'shell_call_output' };
  case 'response.completed':
  case 'response.incomplete':
  case 'response.failed': {
    // Abbreviated streams can expose their first model evidence only in the
    // terminal snapshot. This observes arrival, not an earlier sampling time.
    // https://github.com/openresponses/openresponses/blob/7078a8f1aecd3d1cd41c9891e21c307fcda7f4af/schema/events.tsp#L5-L37
    const response = event.response as { output?: OpenAIResponsesOutputItemEx[] } | undefined;
    if (response?.output === undefined) return null;
    let runtimeSignal: FirstOutputTokenSignal | null = null;
    for (const item of response.output) {
      const signal = responsesItemTimingSignal(item, false);
      if (signal?.type === 'decode') return signal;
      if (runtimeSignal === null && signal !== null) runtimeSignal = signal;
    }
    return runtimeSignal;
  }
  default: return decodeSignal(hasOpenAIResponsesOutputData(event));
  }
};

// Content snapshots can expose first decode evidence atomically; they
// complement streamed string deltas and item announcements.
// https://github.com/openai/openai-python/tree/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses
const hasOpenAIResponsesOutputData = (event: Record<string, unknown>): boolean => {
  switch (event.type) {
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
