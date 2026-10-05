import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OPENAI_CHAT_COMPLETIONS_ASSISTANT_FIELDS, OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS, OPENAI_CHAT_COMPLETIONS_TOOL_CALL_FIELDS, OpenAIChatCompletionsAssistantMessagePrivate, accumulateOpenAIChatCompletionsExtension, createOpenAIChatCompletionsExtensionAccumulator, finalizeOpenAIChatCompletionsExtensions, openaiChatCompletionsErrorPayloadMessage, setOpenAIChatCompletionsField, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsAssistantMessageSidecar, type OpenAIChatCompletionsExtensionAccumulator, type OpenAIChatCompletionsReasoningTextField, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type ChatSidecar = Extract<OpenAIChatCompletionsAssistantMessageSidecar, { upstreamProtocol: 'openaiChatCompletions' }>;
interface ToolState { id?: string; extensions: OpenAIChatCompletionsExtensionAccumulator }
interface ChoiceState {
  textField?: OpenAIChatCompletionsReasoningTextField;
  readonly extensions: OpenAIChatCompletionsExtensionAccumulator;
  readonly tools: Map<number, ToolState>;
}

export const extractOpenAIChatCompletionsPrivate = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  capture?: (frame: ProtocolFrame<unknown>) => void,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const states = new Map<number, ChoiceState>();
  let basis: OpenAIChatCompletionsStreamEvent | undefined;
  let done: ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined;
  let failed = false;
  for await (const frame of frames) {
    capture?.(frame);
    if (frame.type === 'done') { done = frame; break; }
    if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) { failed = true; yield frame; continue; }
    basis = frame.event;
    const choices = frame.event.choices.map(choice => {
      const state = states.get(choice.index) ?? { extensions: createOpenAIChatCompletionsExtensionAccumulator('assistant'), tools: new Map<number, ToolState>() };
      states.set(choice.index, state);
      const source = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
      let delta = source;
      const writable = () => delta === source ? delta = { ...source } : delta;
      if (state.textField === undefined) {
        state.textField = OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS.find(field => typeof source[field] === 'string');
        if (state.textField !== undefined) delete state.extensions.fields[state.textField];
      }
      for (const [field, value] of Object.entries(source)) {
        if (OPENAI_CHAT_COMPLETIONS_ASSISTANT_FIELDS.has(field)) continue;
        if (field === state.textField) {
          if (typeof value === 'string') writable()[OpenAIChatCompletionsAssistantMessagePrivate] = { reasoningText: value };
        } else accumulateOpenAIChatCompletionsExtension(state.extensions, field, value);
        delete writable()[field];
      }
      if (source.tool_calls !== undefined) {
        const tools = source.tool_calls.flatMap(tool => {
          const metadata = state.tools.get(tool.index) ?? { extensions: createOpenAIChatCompletionsExtensionAccumulator('tool') };
          state.tools.set(tool.index, metadata);
          if (tool.id !== undefined) metadata.id = tool.id;
          let visible = tool;
          for (const [field, value] of Object.entries(tool)) {
            if (OPENAI_CHAT_COMPLETIONS_TOOL_CALL_FIELDS.has(field)) continue;
            accumulateOpenAIChatCompletionsExtension(metadata.extensions, field, value);
            if (visible === tool) visible = { ...tool };
            delete visible[field];
          }
          return Object.keys(visible).some(field => field !== 'index') ? [visible] : [];
        });
        if (tools.length !== source.tool_calls.length || tools.some((tool, index) => tool !== source.tool_calls?.[index])) {
          if (tools.length > 0) writable().tool_calls = tools;
          else delete writable().tool_calls;
        }
      }
      return delta === source ? choice : { ...choice, delta };
    });
    yield choices.every((choice, index) => choice === frame.event.choices[index]) ? frame : eventFrame({ ...frame.event, choices });
  }
  if (basis !== undefined && !failed) {
    const choices: OpenAIChatCompletionsStreamEvent['choices'] = [];
    for (const [index, state] of states) {
      const extraFields = finalizeOpenAIChatCompletionsExtensions(state.extensions);
      const toolCallExtraFields: NonNullable<ChatSidecar['toolCallExtraFields']> = {};
      for (const tool of state.tools.values()) {
        const fields = finalizeOpenAIChatCompletionsExtensions(tool.extensions);
        if (tool.id !== undefined && Object.keys(fields).length > 0) setOpenAIChatCompletionsField(toolCallExtraFields, tool.id, fields);
      }
      if (state.textField === undefined && Object.keys(extraFields).length === 0 && Object.keys(toolCallExtraFields).length === 0) continue;
      const sidecar: ChatSidecar = {
        upstreamProtocol: 'openaiChatCompletions',
        ...(state.textField === undefined ? {} : { textFieldOriginalName: state.textField }),
        ...(Object.keys(extraFields).length === 0 ? {} : { extraFields }),
        ...(Object.keys(toolCallExtraFields).length === 0 ? {} : { toolCallExtraFields }),
      };
      choices.push({ index, delta: { [OpenAIChatCompletionsAssistantMessagePrivate]: { sidecar } }, finish_reason: null });
    }
    if (choices.length > 0) {
      const { id, object, model, created } = basis;
      yield eventFrame({ id, object, model, created, choices });
    }
  }
  if (done !== undefined) yield done;
};
