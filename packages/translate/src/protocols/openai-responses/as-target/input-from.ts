import { irInputToolChoiceForTools, irInputToolsForChoice } from '../../../ir/input/select-tools.ts';
import { streamingFlag } from '../../../ir/input/stream.ts';
import type {
  IRInputAddressedAssistantItem,
  IRInputAddressedTurn,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputMedia,
  IRInputToolResultContentPart,
  IRInputAddressedClientItem,
  IRInputClientItem,
  IRInputSystemMessageItem,
} from '../../../ir/input/types.ts';
import { reasoningEffortForBudget } from '../../../shared/reasoning-budget.ts';
import { TranslatorInputError } from '../../../types.ts';
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

// Responses tool output admits text, images, and files, but not refusals, so it
// is projected from the tool-result parts rather than the message-part union.
const toolResultOutput = (output: string | readonly IRInputToolResultContentPart[]): string | OpenAIResponsesToolOutputContent[] => typeof output === 'string'
  ? output
  : [...output].map(part => {
      if (part.type === 'text') return { type: 'input_text' as const, text: part.text };
      if (part.type === 'image') return inputContent(part.image, part.detail) as OpenAIResponsesToolOutputContent;
      return fileContent(part.file, part.filename) as OpenAIResponsesToolOutputContent;
    });

// Responses accepts a bare string or a part array. The array is the general
// spelling, so it is used unconditionally: the IR states each part and the
// target keeps them, without a writer having to know how the source phrased it.
const userContent = (item: Extract<IRInputClientItem, { type: 'message' }>): OpenAIResponsesInputContent[] => item.content.map(part => {
  switch (part.type) {
  case 'text': return { type: 'input_text' as const, text: part.text };
  case 'image': return inputContent(part.image, part.detail);
  case 'file': return fileContent(part.file, part.filename);
  case 'audio': throw new TranslatorInputError(`Cannot translate an audio part of MIME type '${part.audio.media_type}' to OpenAI Responses.`);
  }
});

const assistantItems = (items: readonly IRInputAddressedAssistantItem[]): CanonicalOpenAIResponsesInputItem[] => items.map(item => {
  switch (item.type) {
  case 'message':
    return {
      type: 'message',
      role: 'assistant',
      // Responses spelling of an empty assistant history message.
      content: item.content.length === 0 || item.content.every(part => part.type === 'text' && part.text === '')
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
      // Responses requires `arguments`, and the IR states an absent value for a
      // call that takes no argument object at all; the empty object is that
      // call's argument list written out.
      arguments: item.arguments ?? '{}',
      status: 'completed',
    };
  case 'custom_tool_call':
    return { type: 'custom_tool_call', call_id: item.call_id, name: item.name, input: item.input, status: 'completed' };
  }
});

const userItems = (items: readonly IRInputAddressedClientItem[]): CanonicalOpenAIResponsesInputItem[] => items.map(item => {
  switch (item.type) {
  case 'prompt': {
    // A prompt boundary states its text plainly: one part is that string, and
    // several keep their array so the boundaries between them survive.
    const content = item.content.length === 1
      ? item.content[0].text
      : item.content.map(part => ({ type: 'input_text' as const, text: part.text }));
    return { type: 'message', role: item.role, content };
  }
  case 'message': {
    // One text part is what a plain prompt states, and Responses spells a
    // text message as a bare string; several parts keep their array so the
    // boundaries between them survive.
    if (item.content.length === 1 && item.content[0].type === 'text') {
      return { type: 'message', role: 'user', content: item.content[0].text };
    }
    return { type: 'message', role: 'user', content: item.content.length === 0 ? '' : userContent(item) };
  }
  case 'tool_result': {
    const output = toolResultOutput(item.output);
    return item.tool_kind === 'custom'
      ? { type: 'custom_tool_call_output', call_id: item.call_id, output }
      : { type: 'function_call_output', call_id: item.call_id, output, ...(item.is_error === true ? { status: 'incomplete' as const } : { status: 'completed' as const }) };
  }
  }
});

// A leading system or developer run states the request's prompt, which
// Responses keeps in its own top-level slot. Every later system message stays
// inline as an ordinary input item.
const isHoistablePrompt = (entry: IRInputClientItem): entry is IRInputSystemMessageItem =>
  entry.type === 'prompt';

export const openaiResponsesConversationFromIR = (
  turns: readonly IRInputAddressedTurn[],
  hoistSystem: boolean,
): Pick<CanonicalOpenAIResponsesPayload, 'instructions' | 'input'> => {
  const instructions: string[] = [];
  // A conversation's own leading prompt is the first turn of the first segment.
  // Later segments continue an exchange that already started, so their leading
  // prompt (if any) stays inline where the caller placed it.
  let hoisting = hoistSystem;

  const input = turns.flatMap(item => {
    if (item.kind === 'assistant') {
      hoisting = false;
      return assistantItems(item.items);
    }
    return item.items.flatMap((entry): CanonicalOpenAIResponsesInputItem[] => {
      if (hoisting && isHoistablePrompt(entry)) {
        // Responses states the slot as one string. A single text part is one
        // string; several parts cannot be merged without losing the boundaries
        // the source drew, so the run stays inline with each part its own
        // `input_text` block.
        const parts = entry.content.filter(part => part.text !== '');
        if (parts.length === 1) {
          instructions.push(parts[0].text);
          return [];
        }
        if (parts.length > 1) {
          hoisting = false;
          return [{ type: 'message', role: entry.role, content: parts.map(part => ({ type: 'input_text' as const, text: part.text })) }];
        }
        return [];
      }
      hoisting = false;
      return userItems([entry]);
    });
  });

  return { instructions: instructions.length === 0 ? undefined : instructions.join('\n\n'), input };
};

const requireSchema = (format: IRInputOutputFormat): Readonly<Record<string, unknown>> => {
  if (format.schema === undefined) throw new TranslatorInputError('Cannot translate json_schema response format without a schema.');
  return format.schema;
};

/**
 * Responses states the ceiling once and nests no schema details: `text.format`
 * is flat. `strict` stays absent when the source did not say, because an
 * omitted Responses tool/format strictness is not the same as `false`.
 */
// OpenAI's strict-mode validators reject an object schema that states no
// `properties`, which is a target-side constraint rather than something the IR
// states.
const normalizeParameters = (schema: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> => {
  const target: Record<string, unknown> = schema === undefined ? { type: 'object' } : { ...schema };
  return target.type === 'object' && target.properties === undefined ? { ...target, properties: {} } : target;
};

const toolFromIR = (tool: IRInputTool): OpenAIResponsesTool => {
  if (tool.type === 'custom') {
    return {
      type: 'custom',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.format === undefined ? {} : {
        format: tool.format.type === 'grammar'
          ? { type: 'grammar', definition: tool.format.definition, syntax: tool.format.syntax }
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
  // Responses states a narrowed declaration set natively, which is how the IR's
  // `allowed_tools` is expressed on this wire.
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
export const openaiResponsesHeaderFromIR = (request: IRInputRequest): Omit<CanonicalOpenAIResponsesPayload, 'input' | 'instructions'> => {
  const { settings } = request;
  const tools = irInputToolsForChoice(request.tools, request.tool_choice);
  const choice = irInputToolChoiceForTools(request.tool_choice, tools);
  return {
    ...openaiResponsesSettingsFromIR(settings),
    model: settings.model,
    // A trip guarantees a streaming request; a request that says otherwise
    // cannot be carried by this side at all.
    stream: streamingFlag(settings),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolFromIR) }),
    ...(choice === undefined ? {} : { tool_choice: toolChoiceFromIR(choice) }),
  };
};

export const openaiResponsesSettingsFromIR = (settings: IRInputSettings): Partial<CanonicalOpenAIResponsesPayload> => {
  const ceiling = settings.max_output_tokens;
  const format = settings.output_format;
  // This wire accepts effort names only, so a token budget is reported at the
  // nearest tier it can express, and a stated budget is the more specific of the
  // two quantities. An empty effort names no tier at all.
  const reasoningEffort = settings.reasoning_budget !== undefined
    ? reasoningEffortForBudget(settings.reasoning_budget)
    : settings.reasoning_effort;

  return {
    ...(ceiling === undefined ? {} : { max_output_tokens: ceiling }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
    ...(settings.metadata === undefined ? {} : { metadata: { ...settings.metadata } }),
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
    ...(settings.safety_identifier === undefined ? {} : { safety_identifier: settings.safety_identifier }),
    ...(format === undefined && settings.verbosity === undefined
      ? {}
      : {
          text: {
            ...(settings.verbosity === undefined ? {} : { verbosity: settings.verbosity }),
            ...(format === undefined ? {} : {
              format: format.type === 'json_schema'
                ? {
                    type: 'json_schema' as const,
                    // Responses requires both a name and a schema; the IR makes them
                    // optional because Chat and Messages spell them differently. A
                    // source without a schema cannot be expressed here at all.
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
