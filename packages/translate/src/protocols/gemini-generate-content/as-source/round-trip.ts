import type { IRJSONObject } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { canonicalTextParts, collectCanonicalTextViews, isPureTextPart, type CanonicalTextView, type PureTextPart } from '../../../round-trip/text-parts.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

const isGeminiGenerateContentPureTextPart = <Part extends GeminiGenerateContentPart>(part: Part): part is Part & PureTextPart =>
  isPureTextPart(part);

export const GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION = 1;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

export const hasGeminiGenerateContentThoughtSignature = (content: GeminiGenerateContentContent): boolean =>
  content.parts?.some(part => part.thoughtSignature !== undefined) ?? false;

const geminiReplayCheckMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const text: string[] = [];
  const inlineData: { mimeType: string; data: string; audioTranscription?: string }[] = [];
  const functionCall: { id?: string; name: string; args?: IRJSONObject }[] = [];

  for (const content of turn) for (const part of canonicalTextParts(content.parts ?? [], isGeminiGenerateContentPureTextPart)) {
    if (part.thought !== true && part.text !== undefined) text.push(part.text);
    if (part.inlineData !== undefined) inlineData.push({
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data,
      ...(part.audioTranscription === undefined ? {} : { audioTranscription: part.audioTranscription.text }),
    });
    if (part.functionCall !== undefined) functionCall.push({
      ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
      name: part.functionCall.name,
      ...(part.functionCall.args === undefined ? {} : { args: requireJSONObject(part.functionCall.args) }),
    });
  }

  return { text, inlineData, functionCall };
};

export const inspectGeminiGenerateContentAssistantTurn = (turn: GeminiGenerateContentAssistantTurn): RoundTripSidecarCandidate<GeminiGenerateContentAssistantTurn>[] =>
  turn.flatMap((content, contentIndex) => {
    const nativeParts = content.parts;
    return nativeParts?.flatMap((part, partIndex) => typeof part.thoughtSignature !== 'string' ? [] : [{
      data: part.thoughtSignature,
      withoutSidecar: () => {
        const { thoughtSignature: _signature, ...body } = part;
        const parts = nativeParts.flatMap((item, index) => index !== partIndex ? [item] : Object.keys(body).length === 0 ? [] : [body]);
        return turn.flatMap((item, index) => index !== contentIndex ? [item] : parts.length === 0 ? [] : [{ ...content, parts }]);
      },
    }]) ?? [];
  });

export const computeGeminiGenerateContentReplayCheck = (turn: GeminiGenerateContentAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION, geminiReplayCheckMaterialV1(turn));

export const collectGeminiGenerateContentReplayCandidates = (turn: GeminiGenerateContentAssistantTurn): ReplayCandidate[] => {
  const candidates: ReplayCandidate[] = [];
  for (const content of turn) for (const part of canonicalTextParts(content.parts ?? [], isGeminiGenerateContentPureTextPart)) {
    if (part.thought !== true && typeof part.text === 'string') candidates.push(part.text);
    if (part.inlineData !== undefined) candidates.push(part.inlineData.data);
    if (part.audioTranscription !== undefined) candidates.push(part.audioTranscription.text);
    const args = part.functionCall?.args;
    if (isPlainJSONObject(args)) candidates.push(args);
  }
  return candidates;
};

export const verifyGeminiGenerateContentReplayCheck = (
  turn: GeminiGenerateContentAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(geminiReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

// Gemini returns model-side thought signatures as Part metadata.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export const createGeminiGenerateContentSidecarCarrier = (data: string): GeminiGenerateContentSidecarCarrier => ({ thoughtSignature: data });

export const collectGeminiGenerateContentTextViews = (turn: GeminiGenerateContentAssistantTurn): Map<object, CanonicalTextView> => {
  const views = new Map<object, CanonicalTextView>();
  for (const content of turn) if (content.parts !== undefined) collectCanonicalTextViews(content.parts, isGeminiGenerateContentPureTextPart, views);
  return views;
};
