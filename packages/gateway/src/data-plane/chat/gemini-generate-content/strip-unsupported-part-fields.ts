import type { Chat } from '../facts.ts';
import { mapKeepingIdentity, withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

// ── Gemini generateContent ────────────────────────────────────────────────────────────────
//
// The three strippers below are unconditional rather than flag-gated, and that is a statement
// about the target graph rather than about any upstream: Gemini generateContent has no wire of its own here,
// so every turn is served through a translation, and what no translation can carry cannot be
// sent whichever candidate answers. Stripping is a rewrite rather than a deletion — the record
// is frozen, so a stage that deleted a key in place would throw rather than strip.

/** Gemini generateContent file and code parts have no equivalent anywhere the translations reach, so they go
 *  at source and every target sees translatable parts. A part left holding nothing goes with
 *  them: it is not a part any more. */
export const stripUnsupportedPartFieldsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'stripUnsupportedPartFields',
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
      const stripped = withUnsupportedPartFieldsStripped(payload);
      return stripped === payload ? facts : { ...facts, 'request.chat.geminiGenerateContent': move(stripped) };
    },
  })),
});

/** `fileData` addresses a Google-hosted file the API will not hand back — "you can use the API
 *  to get metadata about the files, but you can't download the files" — and the two code parts
 *  are the transcript of the server-side `codeExecution` tool that the stage below strips.
 *  None survives a translation, so they go at source.
 *  https://ai.google.dev/gemini-api/docs/files
 *  https://ai.google.dev/gemini-api/docs/code-execution */
const UNSUPPORTED_GEMINI_PART_FIELDS = ['fileData', 'executableCode', 'codeExecutionResult'] as const;

const withUnsupportedPartFieldsStripped = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const contents = payload.contents === undefined
    ? undefined
    : mapKeepingIdentity(payload.contents, stripContentParts);
  const systemInstruction = payload.systemInstruction === undefined
    ? undefined
    : stripContentParts(payload.systemInstruction);
  if (contents === payload.contents && systemInstruction === payload.systemInstruction) return payload;
  return {
    ...payload,
    ...(contents === undefined ? {} : { contents }),
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
  };
};

const stripContentParts = (content: GeminiGenerateContentContent): GeminiGenerateContentContent => {
  let changed = false;
  const parts = content.parts.flatMap(part => {
    const stripped = withoutKeys(part, UNSUPPORTED_GEMINI_PART_FIELDS);
    if (stripped === part) return [part];
    changed = true;
    return Object.keys(stripped).length > 0 ? [stripped] : [];
  });
  return changed ? { ...content, parts } : content;
};
