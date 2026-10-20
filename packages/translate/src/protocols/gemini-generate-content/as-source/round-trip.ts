import type { IRJSONObject } from '../../../ir/types.ts';
import type { ReplayContent } from '../../../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { collectTextGroups, collectTextPlacementIndex, type TextContribution, type TextPlacementIndex } from '../../../round-trip/text-groups.ts';
import { computeRoundTripTurnDigest, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

const geminiVisibleTextGroup = (part: GeminiGenerateContentPart): TextContribution<'visible'> | undefined =>
  part.thought !== true && part.text !== undefined ? { channel: 'visible', field: 'text', text: part.text } : undefined;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

export const hasGeminiGenerateContentThoughtSignature = (content: GeminiGenerateContentContent): boolean =>
  content.parts?.some(part => part.thoughtSignature !== undefined) ?? false;

const geminiTurnDigestMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const contents = turn.map(content => {
    const visible = collectTextGroups(content.parts ?? [], geminiVisibleTextGroup).get('visible');
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

export const findGeminiGenerateContentSidecarCarriers = (turn: GeminiGenerateContentAssistantTurn): EncodedRoundTripSidecar<GeminiGenerateContentAssistantTurn>[] =>
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

export const computeGeminiGenerateContentTurnDigest = (turn: GeminiGenerateContentAssistantTurn): Promise<RoundTripTurnDigest> =>
  computeRoundTripTurnDigest(geminiTurnDigestMaterialV1(turn));

export const collectGeminiGenerateContentReplayContents = (turn: GeminiGenerateContentAssistantTurn): ReplayContent[] => {
  const candidates: ReplayContent[] = [];
  for (const content of turn) {
    const visible = collectTextGroups(content.parts ?? [], geminiVisibleTextGroup).get('visible');
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

export const verifyGeminiGenerateContentTurnDigest = (
  turn: GeminiGenerateContentAssistantTurn,
  sourceTurnDigest: RoundTripTurnDigest,
  version: number,
): Promise<boolean> => {
  switch (version) {
  case 1: return verifyRoundTripTurnDigest(geminiTurnDigestMaterialV1(turn), sourceTurnDigest);
  default: return Promise.resolve(false);
  }
};

// Gemini returns model-side thought signatures as Part metadata.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export const createGeminiGenerateContentSidecarCarrier = (data: string): GeminiGenerateContentSidecarCarrier => ({ thoughtSignature: data });

export const collectGeminiGenerateContentTextViews = (turn: GeminiGenerateContentAssistantTurn): TextPlacementIndex => {
  const views: TextPlacementIndex = new Map();
  for (const content of turn) {
    if (content.parts !== undefined) collectTextPlacementIndex(collectTextGroups(content.parts, geminiVisibleTextGroup), views);
  }
  return views;
};
