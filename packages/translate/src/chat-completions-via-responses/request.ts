import { chatCompletionsContentToResponsesInputContent, chatCompletionsContentToText } from '../shared/chat-completions-and-responses/content.ts';
import { scalarToResponsesReasoningItem, translateChatCompletionsReasoningItems } from '../shared/chat-completions-and-responses/reasoning.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { ChatCompletionsMessage, ChatCompletionsPayload, ChatCompletionsTool } from '@floway-dev/protocols/chat-completions';
import type { CanonicalResponsesPayload, ResponsesInputContent, ResponsesInputItem, ResponsesInputReasoning, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

const translateChatTools = (tools?: ChatCompletionsTool[] | null): ResponsesTool[] | null =>
  tools?.length
    ? tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
        // Chat function tools are non-strict by default while Responses function
        // tools default strict; make omission explicit to preserve Chat semantics.
        strict: tool.function.strict ?? false,
        ...(tool.function.description ? { description: tool.function.description } : {}),
      }))
    : null;

const translateChatToolChoice = (choice: NonNullable<ChatCompletionsPayload['tool_choice']>): ResponsesToolChoice =>
  typeof choice === 'string' ? choice : { type: 'function', name: choice.function.name };

const translateAssistantContent = (message: ChatCompletionsMessage): ResponsesInputContent[] => {
  const content: ResponsesInputContent[] = [];
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

export const buildTargetRequest = (payload: ChatCompletionsPayload): CanonicalResponsesPayload => {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];
  let hoistSystemPrefix = true;

  for (const message of payload.messages) {
    // Only the initial Chat `system` prefix maps cleanly to Responses
    // `instructions`; later `system` and `developer` turns are
    // chronology-bearing input items.
    if (hoistSystemPrefix && message.role === 'system') {
      const text = chatCompletionsContentToText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: chatCompletionsContentToResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const assistantContent = translateAssistantContent(message);
      const reasoningItems = translateChatCompletionsReasoningItems<ResponsesInputReasoning>(message.reasoning_items);
      const scalarReasoning = scalarToResponsesReasoningItem<ResponsesInputReasoning>(message.reasoning_text);
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
        content: chatCompletionsContentToResponsesInputContent(message.content),
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

  // Chat's `reasoning_effort: 'none'` disables reasoning without a Responses
  // equivalent (Responses `reasoning.effort` has no 'none' member); drop the
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
    // Responses upstreams disagree on an orphaned `tool_choice` — one sent
    // without tools: OpenAI-backed models ignore it, while xAI-backed ones
    // reject the request with `invalid-argument: A tool_choice was set on the
    // request but no tools were specified`. Other gateways hit the same wall on
    // both the native Responses path and the Responses → Chat Completions path:
    // https://github.com/Wei-Shaw/sub2api/issues/4819
    // https://github.com/jlcodes99/cockpit-tools/issues/1727
    ...(payload.tool_choice != null && payload.tools?.length ? { tool_choice: translateChatToolChoice(payload.tool_choice) } : {}),
    // Same-purpose OpenAI fields are normal Chat/Responses adapter surface;
    // provider-specific policy filtering belongs at the target boundary, not in
    // pairwise translation.
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    stream: true,
    // Preserve Chat's omitted `store` as omitted instead of synthesizing
    // `store: false`. OpenAI's migration guide treats storage as the default
    // behavior for both Responses and new Chat Completions accounts; callers
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
