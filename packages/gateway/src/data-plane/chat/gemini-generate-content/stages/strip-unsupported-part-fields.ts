import type { ChatPipelineServices, GeminiGenerateContentAttemptInput } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPart, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { ChatTargetApi } from '@floway-dev/provider';

type Facts = GeminiGenerateContentAttemptInput;

const stripPartFields = (parts: GeminiGenerateContentPart[]): GeminiGenerateContentPart[] =>
  parts.filter(part => {
    delete part.fileData;
    delete part.executableCode;
    delete part.codeExecutionResult;
    return Object.keys(part).length > 0;
  });

const stripUnsupportedPartFieldsFromPayload = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const contents = payload.contents.map(content => content.parts === undefined
    ? content
    : { ...content, parts: stripPartFields(content.parts.map(part => ({ ...part }))) });
  const systemInstruction = payload.systemInstruction?.parts === undefined
    ? payload.systemInstruction
    : {
        ...payload.systemInstruction,
        parts: stripPartFields(payload.systemInstruction.parts.map(part => ({ ...part }))),
      };
  return {
    ...payload,
    contents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
  };
};

// Each translated target lacks Gemini's file and code execution parts. Remove
// them at the source boundary while preserving a native Gemini payload exactly.
export const createStripUnsupportedPartFieldsStage = (targetPicker: { readonly pick: (endpoints: GeminiGenerateContentAttemptInput['route.candidate']['endpoints']) => ChatTargetApi }) => defineRequestStage<
  Facts,
  { readonly 'route.targetApi': ChatTargetApi; readonly 'request.payload': Facts['request.payload'] },
  never,
  ChatPipelineServices
>({
  name: 'stripUnsupportedPartFields',
  provides: ['request.payload', 'route.targetApi'],
  execute: async (facts, next) => {
    const targetApi = targetPicker.pick(facts['route.candidate'].endpoints);
    return await next({
      'route.targetApi': targetApi,
      'request.payload': targetApi === 'geminiGenerateContent'
        ? facts['request.payload']
        : stripUnsupportedPartFieldsFromPayload(facts['request.payload']),
    });
  },
});
