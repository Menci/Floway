import type { IRInputAssistantItemWithCallIds, IRInputTurnWithCallIds, IRInputClientItemWithCallIds } from '../../../composition/request/call-ids.ts';
import { requireStreaming } from '../../../ir/input/streaming.ts';
import type { IRInputRequestHeader, IRInputSettings, IRInputTool, IRInputToolChoice, IRInputOutputFormat, IRInputCacheControl, IRInputDocument, IRInputMedia, IRInputToolResultContentPart, IRInputClientItem } from '../../../ir/input/types.ts';
import { requireKnownCustomToolFormat } from '../../../shared/custom-tool.ts';
import { DOCUMENT_CLOSE_TAG, documentImage, documentOpening } from '../../../shared/document.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { reasoningEffortForBudget } from '../../../shared/reasoning-budget.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputContent,
  OpenAIResponsesToolOutputContent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const inputContent = (media: IRInputMedia, detail?: string | null): OpenAIResponsesInputContent => {
  switch (media.source_kind) {
  case 'url':
    return { type: 'input_image', image_url: media.url, ...(detail == null ? {} : { detail }) };
  case 'file':
    return { type: 'input_image', file_id: media.file_id, ...(detail == null ? {} : { detail }) };
  case 'data':
    return { type: 'input_image', image_url: media.data.startsWith('data:') ? media.data : `data:application/octet-stream;base64,${media.data}`, ...(detail == null ? {} : { detail }) };
  case 'base64':
    return { type: 'input_image', image_url: `data:${media.media_type ?? 'application/octet-stream'};base64,${media.data}`, ...(detail == null ? {} : { detail }) };
  }
};

const fileContent = (media: IRInputMedia, filename?: string | null): OpenAIResponsesInputContent => {
  const name = filename == null ? {} : { filename };
  switch (media.source_kind) {
  case 'url':
    return { type: 'input_file', file_url: media.url, ...name };
  case 'file':
    return { type: 'input_file', file_id: media.file_id, ...name };
  case 'data':
    return { type: 'input_file', file_data: media.data, ...name };
  case 'base64':
    // Responses accepts the bytes either raw or as a data URL; a MIME type the
    // source stated is carried in the data URL so the target can act on it.
    return {
      type: 'input_file',
      file_data: media.media_type === undefined ? media.data : `data:${media.media_type};base64,${media.data}`,
      ...name,
    };
  }
};

const withDocumentCache = (part: OpenAIResponsesInputContent, cache: IRInputCacheControl | null | undefined): OpenAIResponsesInputContent =>
  cache === undefined ? part : { ...part, prompt_cache_breakpoint: cache === null ? null : { mode: 'explicit' } };

const documentContent = (document: IRInputDocument): OpenAIResponsesInputContent[] => {
  const source = document.source;
  if (source.source_kind === 'media' && document.title == null && document.context == null) {
    return [withDocumentCache(fileContent(source.media), document.cache_control)];
  }
  const content: OpenAIResponsesInputContent[] = source.source_kind === 'media'
    ? [fileContent(source.media)]
    : source.source_kind === 'text'
      ? [{ type: 'input_text', text: source.text }]
      : source.content.map(part => withDocumentCache(part.type === 'text'
          ? { type: 'input_text', text: part.text }
          : inputContent(documentImage(part), part.detail), part.cache_control));
  return [
    { type: 'input_text', text: documentOpening(document) },
    ...content,
    withDocumentCache({ type: 'input_text', text: DOCUMENT_CLOSE_TAG }, document.cache_control),
  ];
};

// Responses tool output admits text, images, and files, but not refusals, so it
// is projected from the tool-result parts rather than the message-part union.
const toolResultOutput = (output: string | readonly IRInputToolResultContentPart[]): string | OpenAIResponsesToolOutputContent[] => typeof output === 'string'
  ? output
  : output.flatMap(part => {
      if (part.type === 'text') return { type: 'input_text' as const, text: part.text };
      if (part.type === 'image') return inputContent(part.image, part.detail);
      if (part.type === 'file') return fileContent(part.file, part.filename);
      return documentContent(part.document);
    });

const userContent = (item: Extract<IRInputClientItem, { type: 'message' }>): OpenAIResponsesInputContent[] => item.content.flatMap(part => {
  switch (part.type) {
  case 'text': return { type: 'input_text' as const, text: part.text };
  case 'image': return inputContent(part.image, part.detail);
  case 'file': return fileContent(part.file, part.filename);
  case 'document': return documentContent(part.document);
  case 'audio': throw new TranslateInputException(`Cannot translate an audio part of MIME type '${part.audio.media_type}' to OpenAI Responses.`);
  }
});

const assistantItems = (items: readonly IRInputAssistantItemWithCallIds[]): CanonicalOpenAIResponsesInputItem[] => items.map(item => {
  switch (item.type) {
  case 'message':
    return {
      type: 'message',
      role: 'assistant',
      content: item.content.every(part => part.type === 'text' && part.text === '')
        ? ''
        : item.content.map(part => part.type === 'text'
            ? { type: 'output_text' as const, text: part.text }
            : { type: 'refusal' as const, refusal: part.refusal }),
    };
  case 'reasoning':
    return {
      type: 'reasoning',
      ...(item.id === undefined ? {} : { id: item.id }),
      summary: (item.summary ?? []).map(text => ({ type: 'summary_text' as const, text })),
      ...(item.content === undefined ? {} : { content: item.content.map(text => ({ type: 'reasoning_text' as const, text })) }),
    };
  case 'function_call':
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      // Responses requires argument text; omitted source arguments use an empty JSON object.
      arguments: item.arguments ?? '{}',
      status: 'completed',
    };
  case 'custom_tool_call':
    return { type: 'custom_tool_call', call_id: item.call_id, name: item.name, input: item.input, status: 'completed' };
  }
});

const clientItem = (item: IRInputClientItemWithCallIds): CanonicalOpenAIResponsesInputItem => {
  switch (item.type) {
  case 'instruction':
    return { type: 'message', role: 'system', content: item.content.length === 1 ? item.content[0].text : item.content.map(part => ({ type: 'input_text' as const, text: part.text })) };
  case 'message': {
    if (item.role !== 'user') {
      const content = item.content.length === 1
        ? item.content[0].text
        : item.content.map(part => ({ type: 'input_text' as const, text: part.text }));
      return { type: 'message', role: item.role, content };
    }
    if (item.content.length === 1 && item.content[0].type === 'text') {
      return { type: 'message', role: 'user', content: item.content[0].text };
    }
    return { type: 'message', role: 'user', content: item.content.length === 0 ? '' : userContent(item) };
  }
  case 'tool_result': {
    const output = toolResultOutput(item.output);
    return item.tool_kind === 'custom'
      ? { type: 'custom_tool_call_output', call_id: item.call_id, output, ...(item.is_error === undefined ? {} : { status: item.is_error ? 'incomplete' as const : 'completed' as const }) }
      : { type: 'function_call_output', call_id: item.call_id, output, ...(item.is_error === true ? { status: 'incomplete' as const } : { status: 'completed' as const }) };
  }
  }
};

export const openaiResponsesConversationFromIR = (
  turns: readonly IRInputTurnWithCallIds[],
  leading: boolean,
): Pick<CanonicalOpenAIResponsesPayload, 'instructions' | 'input'> => {
  let instructions: string | undefined;
  // Only the first segment can contain the request's top-level instruction.
  // A later segment continues conversation history, so every item stays inline.
  let hoisting = leading;

  const input = turns.flatMap(item => {
    if (item.kind === 'assistant') {
      hoisting = false;
      return assistantItems(item.items);
    }
    return item.items.flatMap((entry): CanonicalOpenAIResponsesInputItem[] => {
      // Only a top-level instruction is hoisted; historical system and developer messages stay in place.
      if (hoisting && entry.type === 'instruction') {
        instructions = entry.content.map(part => part.text).join('');
        hoisting = false;
        return [];
      }
      hoisting = false;
      return [clientItem(entry)];
    });
  });

  return { instructions, input };
};

const requireSchema = (format: IRInputOutputFormat): Readonly<Record<string, unknown>> => {
  if (format.schema === undefined) throw new TranslateInputException('Cannot translate json_schema response format without a schema.');
  return format.schema;
};

// OpenAI's strict-mode validators reject an object schema that states no
// `properties`, which is a target-side constraint rather than something the IR
// states.
const normalizeParameters = (schema: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> => {
  if (schema === undefined) return { type: 'object', properties: {} };
  return schema.type === 'object' && schema.properties === undefined ? { ...schema, properties: {} } : schema;
};

const toolFromIR = (tool: IRInputTool): OpenAIResponsesTool => {
  if (tool.type === 'custom') {
    const format = requireKnownCustomToolFormat(tool.format);
    return {
      type: 'custom',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(format === undefined ? {} : {
        format: format.type === 'grammar'
          ? { type: 'grammar', definition: format.definition, syntax: format.syntax }
          : { type: 'text' },
      }),
    };
  }
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: normalizeParameters(tool.parameters),
    // A Responses function tool requires `strict`; an omitted value states the
    // schema is not enforced rather than letting the field go missing.
    strict: tool.strict ?? false,
  };
};

const toolChoiceFromIR = (choice: IRInputToolChoice): NonNullable<CanonicalOpenAIResponsesPayload['tool_choice']> => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'allowed_tools') {
    return {
      type: 'allowed_tools',
      mode: choice.mode,
      tools: choice.tools.map(selection => selection.type === 'custom'
        ? { type: 'custom' as const, name: selection.name }
        : { type: 'function' as const, name: selection.name }),
    };
  }
  return { type: choice.type, name: choice.name };
};

/**
 * Everything a Responses request states except its conversation.
 *
 * The conversation is written separately because a trip interleaves it with the
 * assistant turns a sidecar already resolved, so only this half is computed once
 * per payload.
 */
export const openaiResponsesHeaderFromIR = (request: IRInputRequestHeader): Omit<CanonicalOpenAIResponsesPayload, 'input' | 'instructions'> => {
  const { settings } = request;
  // This wire states a permitted subset natively, so the declarations stay
  // whole: narrowing them as well would also narrow what the model may see.
  const tools = request.tools;
  const choice = tools === undefined || tools.length === 0 ? undefined : request.tool_choice;
  return {
    ...openaiResponsesSettingsFromIR(settings),
    model: settings.model,
    // A trip guarantees a streaming request; a request that says otherwise
    // cannot be carried by this side at all.
    stream: requireStreaming(settings),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolFromIR) }),
    ...(choice === undefined ? {} : { tool_choice: toolChoiceFromIR(choice) }),
  };
};

export const openaiResponsesSettingsFromIR = (settings: IRInputSettings): Partial<CanonicalOpenAIResponsesPayload> => {
  const ceiling = settings.max_output_tokens !== undefined ? settings.max_output_tokens : settings.max_visible_output_tokens;
  const format = settings.output_format;
  const reasoningEffort = settings.reasoning_effort ?? (settings.reasoning_budget === undefined ? undefined : reasoningEffortForBudget(settings.reasoning_budget));

  return {
    ...(ceiling === undefined ? {} : { max_output_tokens: ceiling }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
    ...(settings.presence_penalty === undefined ? {} : { presence_penalty: settings.presence_penalty }),
    ...(settings.frequency_penalty === undefined ? {} : { frequency_penalty: settings.frequency_penalty }),
    ...(settings.metadata === undefined ? {} : { metadata: settings.metadata }),
    ...(settings.store === undefined ? {} : { store: settings.store }),
    ...(settings.service_tier === undefined ? {} : { service_tier: settings.service_tier }),
    ...(settings.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: settings.parallel_tool_calls }),
    ...(reasoningEffort === undefined && settings.reasoning_summary === undefined ? {} : {
      reasoning: {
        ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
        ...(settings.reasoning_summary === undefined ? {} : { summary: settings.reasoning_summary }),
      },
    }),
    ...(settings.prompt_cache_key === undefined ? {} : { prompt_cache_key: settings.prompt_cache_key }),
    ...(settings.prompt_cache_retention === undefined ? {} : { prompt_cache_retention: settings.prompt_cache_retention }),
    ...(settings.prompt_cache_options == null ? {} : { prompt_cache_options: settings.prompt_cache_options }),
    ...(settings.safety_identifier === undefined ? {} : { safety_identifier: settings.safety_identifier }),
    ...(settings.user == null ? {} : { user: settings.user }),
    // Responses requests token probabilities through its includable output data.
    // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts
    ...(settings.logprobs === undefined ? {} : { include: settings.logprobs === null ? null : settings.logprobs ? ['message.output_text.logprobs'] : [] }),
    ...(settings.top_logprobs === undefined ? {} : { top_logprobs: settings.top_logprobs }),
    ...(format === undefined && settings.verbosity === undefined
      ? {}
      : {
          text: {
            ...(settings.verbosity === undefined ? {} : { verbosity: settings.verbosity }),
            ...(format === undefined ? {} : {
              format: format.type === 'json_schema'
                ? {
                    type: 'json_schema' as const,
                    // Responses JSON Schema output requires a schema and a name; an omitted source name uses a stable fallback.
                    name: format.name ?? 'response',
                    schema: requireSchema(format),
                    ...(format.description === undefined ? {} : { description: format.description }),
                    ...(format.strict === undefined ? {} : { strict: format.strict }),
                  }
                : { type: format.type },
            }),
          },
        }),
  };
};
