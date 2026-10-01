import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

/** Only function declarations translate out of a Gemini generateContent tool group, so the rest of a group's
 *  capabilities go — and a group left declaring no function goes with them, because a target
 *  emitter offered an empty group would be offered a tool that does nothing. `tools` itself
 *  goes when no group survived: an empty tool list is a different request from no tools. */
export const stripUnsupportedToolsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripUnsupportedTools',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: ['request.chat.geminiGenerateContent'] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.geminiGenerateContent'];
      const stripped = withUnsupportedToolsStripped(payload);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});

/** Every field a Gemini generateContent tool group can carry other than `functionDeclarations` — the
 *  capabilities Google executes inside its own generation loop, which no target wire can be
 *  asked to run. `functionDeclarations` is the one that survives because the model "does not
 *  execute the function"; it asks the caller to. Re-derive against the `Tool` schema whenever
 *  it gains a field, which it still does.
 *  https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
 *  https://ai.google.dev/api/generate-content */
const UNSUPPORTED_GEMINI_TOOL_CAPABILITIES = [
  'googleSearch',
  'googleSearchRetrieval',
  'codeExecution',
  'computerUse',
  'urlContext',
  'fileSearch',
  'mcpServers',
  'googleMaps',
] as const;

const withUnsupportedToolsStripped = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const { tools } = payload;
  if (tools === undefined) return payload;
  let changed = false;
  const kept: GeminiGenerateContentToolGroup[] = [];
  for (const tool of tools) {
    const stripped = withoutKeys(tool, UNSUPPORTED_GEMINI_TOOL_CAPABILITIES);
    if (stripped !== tool) changed = true;
    if (stripped.functionDeclarations !== undefined && stripped.functionDeclarations.length > 0) kept.push(stripped);
    else changed = true;
  }
  if (kept.length === 0) return withoutKeys(payload, ['tools']);
  return changed ? { ...payload, tools: kept } : payload;
};
