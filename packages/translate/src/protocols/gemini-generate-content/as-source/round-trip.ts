import type { IRJSONObject } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { collectTextChannels, collectTextChannelViews, type TextChannelProjection, type TextChannelViews } from '../../../round-trip/text-channels.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

const geminiVisibleTextChannel = (part: GeminiGenerateContentPart): TextChannelProjection<'visible'> | undefined =>
  part.thought !== true && part.text !== undefined ? { channel: 'visible', field: 'text', text: part.text } : undefined;

export const GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION = 1;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

export const hasGeminiGenerateContentThoughtSignature = (content: GeminiGenerateContentContent): boolean =>
  content.parts?.some(part => part.thoughtSignature !== undefined) ?? false;

const geminiReplayCheckMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const contents = turn.map(content => {
    const visible = collectTextChannels(content.parts ?? [], geminiVisibleTextChannel).get('visible');
    const inlineData: { mimeType: string; data: string; audioTranscription?: string }[] = [];
    const functionCall: { id?: string; name: string; args?: IRJSONObject }[] = [];
    for (const part of content.parts ?? []) {
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
    return { ...(visible === undefined ? {} : { text: visible.text }), inlineData, functionCall };
  });

  return { contents };
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
  for (const content of turn) {
    const visible = collectTextChannels(content.parts ?? [], geminiVisibleTextChannel).get('visible');
    if (visible !== undefined) candidates.push(visible.text);
    for (const part of content.parts ?? []) {
      if (part.inlineData !== undefined) candidates.push(part.inlineData.data);
      if (part.audioTranscription !== undefined) candidates.push(part.audioTranscription.text);
      const args = part.functionCall?.args;
      if (isPlainJSONObject(args)) candidates.push(args);
    }
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

export const collectGeminiGenerateContentTextViews = (turn: GeminiGenerateContentAssistantTurn): TextChannelViews => {
  const views: TextChannelViews = new Map();
  for (const content of turn) {
    if (content.parts !== undefined) collectTextChannelViews(collectTextChannels(content.parts, geminiVisibleTextChannel), views);
  }
  return views;
};
