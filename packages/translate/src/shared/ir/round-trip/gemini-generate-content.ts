
import type { IRJSONObject } from '../ir.ts';
import type { IRPath } from '../stream.ts';
import type { GeminiGenerateContentThinAssistantTurn, IATReference, IRReplayCandidate } from '../thin-types.ts';
import { createIRRoundTripReplayCheck, verifyIRRoundTripReplayCheck } from './replay-check.ts';
import { replaceIRRoundTripReferences } from './thin-builder.ts';
import type { IRRoundTripAssistantTurnInspection, IRRoundTripConversationTurn, IRRoundTripReplayCheck } from './types.ts';
import type {
  GeminiGenerateContentContent,
  GeminiGenerateContentPart,
} from '@floway-dev/protocols/gemini-generate-content';

export const GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION = 1;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentConversationTurn = IRRoundTripConversationTurn<'assistant' | 'bare', GeminiGenerateContentContent>;
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

const partSidecarValues = (part: GeminiGenerateContentPart): string[] => typeof part.thoughtSignature === 'string' ? [part.thoughtSignature] : [];

const withoutThoughtSignature = (part: GeminiGenerateContentPart): Record<string, unknown> => {
  const { thoughtSignature: _thoughtSignature, ...meaningfulPart } = part;
  return meaningfulPart as Record<string, unknown>;
};

const geminiReplayCheckMaterial = (turn: GeminiGenerateContentAssistantTurn): unknown => turn.map(content => ({
  ...(content.role === undefined ? {} : { role: content.role }),
  ...(content.parts === undefined ? {} : {
    parts: content.parts.flatMap(part => {
      if (!Object.hasOwn(part, 'thoughtSignature')) return [part as Record<string, unknown>];
      const meaningfulPart = withoutThoughtSignature(part);
      return Object.keys(meaningfulPart).length === 0 ? [] : [meaningfulPart];
    }),
  }),
}));

const collectPartCandidates = (candidates: IRReplayCandidate[], part: GeminiGenerateContentPart): void => {
  if (typeof part.text === 'string') candidates.push(part.text);
  if (part.inlineData !== undefined) candidates.push(part.inlineData.data);
  if (part.audioTranscription !== undefined) candidates.push(part.audioTranscription.text);
  if (part.functionCall?.args !== undefined) candidates.push(part.functionCall.args as IRJSONObject);
};

export const partitionGeminiGenerateContentTurns = (contents: readonly GeminiGenerateContentContent[]): GeminiGenerateContentConversationTurn[] => {
  const turns: GeminiGenerateContentConversationTurn[] = [];
  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(content);
    else turns.push({ role, items: [content] });
  }
  return turns;
};

export const inspectGeminiGenerateContentAssistantTurn = (turn: GeminiGenerateContentAssistantTurn): IRRoundTripAssistantTurnInspection => {
  const candidates: IRReplayCandidate[] = [];
  const sidecars = turn.flatMap(content => content.parts === undefined ? [] : content.parts.flatMap(partSidecarValues));
  for (const content of turn) if (content.parts !== undefined) for (const part of content.parts) collectPartCandidates(candidates, part);
  return { sidecars, candidates, checkMaterial: geminiReplayCheckMaterial(turn) };
};

export const createGeminiGenerateContentReplayCheck = async (turn: GeminiGenerateContentAssistantTurn): Promise<IRRoundTripReplayCheck | undefined> => {
  const inspection = inspectGeminiGenerateContentAssistantTurn(turn);
  return inspection.sidecars.length === 1
    ? await createIRRoundTripReplayCheck(inspection.checkMaterial, GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION)
    : undefined;
};

export const verifyGeminiGenerateContentReplayCheck = async (turn: GeminiGenerateContentAssistantTurn, replayCheck: IRRoundTripReplayCheck): Promise<boolean> => {
  const inspection = inspectGeminiGenerateContentAssistantTurn(turn);
  return await (inspection.sidecars.length === 1 && verifyIRRoundTripReplayCheck(inspection.checkMaterial, replayCheck, GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION));
};

export const cleanGeminiGenerateContentAssistantTurn = (turn: GeminiGenerateContentAssistantTurn): GeminiGenerateContentAssistantTurn => turn.map(content => ({
  ...content,
  ...(content.parts === undefined ? {} : {
    parts: content.parts.flatMap(part => {
      if (!Object.hasOwn(part, 'thoughtSignature')) return [part];
      const meaningfulPart = withoutThoughtSignature(part);
      return Object.keys(meaningfulPart).length === 0 ? [] : [meaningfulPart as GeminiGenerateContentPart];
    }),
  }),
}));

const geminiThinReferencePaths = (turn: GeminiGenerateContentAssistantTurn): IRPath[] => {
  const paths: IRPath[] = [];
  turn.forEach((content, contentIndex) => content.parts?.forEach((part, partIndex) => {
    if (typeof part.text === 'string') paths.push([contentIndex, 'parts', partIndex, 'text']);
    if (part.inlineData !== undefined) paths.push([contentIndex, 'parts', partIndex, 'inlineData', 'data']);
    if (part.audioTranscription !== undefined) paths.push([contentIndex, 'parts', partIndex, 'audioTranscription', 'text']);
    if (part.functionCall?.args !== undefined) paths.push([contentIndex, 'parts', partIndex, 'functionCall', 'args']);
  }));
  return paths;
};

export const buildGeminiGenerateContentThinAssistantTurn = (
  turn: GeminiGenerateContentAssistantTurn,
  referencesByProtocolPath: ReadonlyMap<string, IATReference>,
): GeminiGenerateContentThinAssistantTurn<IATReference> => {
  const modelTurn = turn.map(content => ({ ...content, role: 'model' as const }));
  return replaceIRRoundTripReferences(modelTurn, referencesByProtocolPath, geminiThinReferencePaths(modelTurn)) as GeminiGenerateContentThinAssistantTurn<IATReference>;
};

// Gemini returns model-side thought signatures as Part metadata.
// https://ai.google.dev/gemini-api/docs/thought-signatures
export const createGeminiGenerateContentSidecarCarrier = (data: string): GeminiGenerateContentSidecarCarrier => ({ thoughtSignature: data });
