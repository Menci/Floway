import { openaiChatCompletionsContentToOpenAIResponsesInputContent, openaiChatCompletionsContentToText } from '../shared/openai-chat-completions-and-openai-responses/content.ts';
import { scalarToOpenAIResponsesReasoningItem, translateOpenAIChatCompletionsReasoningItems } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesInputItem, OpenAIResponsesInputReasoning, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

const translateChatTools = (tools?: OpenAIChatCompletionsTool[] | null): OpenAIResponsesTool[] | null =>
  tools?.length
    ? tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
        // OpenAI Chat Completions function tools are non-strict by default while OpenAI Responses function
        // tools default strict; make omission explicit to preserve OpenAI Chat Completions semantics.
        strict: tool.function.strict ?? false,
        ...(tool.function.description ? { description: tool.function.description } : {}),
      }))
    : null;

const translateChatToolChoice = (choice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): OpenAIResponsesToolChoice =>
  typeof choice === 'string' ? choice : { type: 'function', name: choice.function.name };

const translateAssistantContent = (message: OpenAIChatCompletionsMessage): OpenAIResponsesInputContent[] => {
  const content: OpenAIResponsesInputContent[] = [];
  let hasRefusalPart = false;

  if (typeof message.content === 'string') {
    if (message.content) content.push({ type: 'output_text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'output_text', text: part.text });
      else if (part.type === 'refusal') {
        content.push({ type: 'refusal', refusal: part.refusal });
        hasRefusalPart = true;
      }
    }
  }

  if (message.refusal !== undefined && message.refusal !== null && !hasRefusalPart) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }

  return content;
};

export const buildTargetRequest = (payload: OpenAIChatCompletionsPayload): CanonicalOpenAIResponsesPayload => {
  const instructions: string[] = [];
  const input: OpenAIResponsesInputItem[] = [];
  let hoistSystemPrefix = true;

  for (const message of payload.messages) {
    // Only the initial OpenAI Chat Completions `system` prefix maps cleanly to OpenAI Responses
    // `instructions`; later `system` and `developer` turns are
    // chronology-bearing input items.
    if (hoistSystemPrefix && message.role === 'system') {
      const text = openaiChatCompletionsContentToText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: openaiChatCompletionsContentToOpenAIResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const assistantContent = translateAssistantContent(message);
      const reasoningItems = translateOpenAIChatCompletionsReasoningItems<OpenAIResponsesInputReasoning>(message.reasoning_items);
      const scalarReasoning = scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(message.reasoning_text);
      if (reasoningItems) {
        input.push(...reasoningItems);
      } else if (scalarReasoning) {
        input.push(scalarReasoning);
      }

      if (message.tool_calls?.length) {
        if (assistantContent.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: assistantContent,
          });
        }

        for (const toolCall of message.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: 'completed',
          });
        }

        continue;
      }

      input.push({
        type: 'message',
        role: 'assistant',
        content: assistantContent.length > 0 ? assistantContent : '',
      });
      continue;
    }

    if (message.role === 'system' || message.role === 'developer') {
      input.push({
        type: 'message',
        role: message.role,
        content: openaiChatCompletionsContentToOpenAIResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role !== 'tool') {
      throw new TranslatorInputError(`Invalid role '${(message as { role: string }).role}'.`);
    }

    if (!message.tool_call_id) {
      throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
    }

    input.push({
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    });
  }

  const responseTextConfig = payload.response_format === undefined ? undefined : payload.response_format === null ? null : { format: payload.response_format };

  // OpenAI Chat Completions' `reasoning_effort: 'none'` disables reasoning without an OpenAI Responses
  // equivalent (OpenAI Responses `reasoning.effort` has no 'none' member); drop the
  // field instead of forwarding a value the upstream rejects.
  const reasoningEffort = payload.reasoning_effort && payload.reasoning_effort !== 'none' ? payload.reasoning_effort : undefined;
  const reasoning = reasoningEffort !== undefined ? { effort: reasoningEffort } : undefined;

  return {
    model: payload.model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined ? { max_output_tokens: payload.max_tokens } : {}),
    ...(payload.tools !== undefined ? { tools: translateChatTools(payload.tools) } : {}),
    // OpenAI Responses upstreams disagree on an orphaned `tool_choice` — one sent
    // without tools: OpenAI-backed models ignore it, while xAI-backed ones
    // reject the request with `invalid-argument: A tool_choice was set on the
    // request but no tools were specified`. Other gateways hit the same wall on
    // both the native OpenAI Responses path and the OpenAI Responses → OpenAI Chat Completions path:
    // https://github.com/Wei-Shaw/sub2api/issues/4819
    // https://github.com/jlcodes99/cockpit-tools/issues/1727
    ...(payload.tool_choice != null && payload.tools?.length ? { tool_choice: translateChatToolChoice(payload.tool_choice) } : {}),
    // Same-purpose OpenAI fields are normal OpenAI Chat Completions/OpenAI Responses adapter surface;
    // provider-specific policy filtering belongs at the target boundary, not in
    // pairwise translation.
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    stream: true,
    // Preserve OpenAI Chat Completions' omitted `store` as omitted instead of synthesizing
    // `store: false`. OpenAI's migration guide treats storage as the default
    // behavior for both OpenAI Responses and new OpenAI Chat Completions accounts; callers
    // disable it explicitly with `store: false`.
    // Reference:
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(responseTextConfig !== undefined ? { text: responseTextConfig } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
  };
};
