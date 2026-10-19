import type { IRJSONObject } from '../../../ir/types.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { computeRoundTripTurnDigest, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

export const hasGeminiGenerateContentThoughtSignature = (content: GeminiGenerateContentContent): boolean =>
  content.parts?.some(part => part.thoughtSignature !== undefined) ?? false;

const geminiTurnDigestMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const contents = turn.map(content => {
    let contentText = '';
    let hasText = false;
    const inlineData: { mimeType: string; data: string; audioTranscription?: string }[] = [];
    const functionCall: { id?: string; name: string; args?: IRJSONObject }[] = [];
    for (const part of content.parts ?? []) {
      if (part.thought !== true && part.text !== undefined) {
        hasText = true;
        contentText += part.text;
      }
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
    return { ...(hasText ? { text: contentText } : {}), inlineData, functionCall };
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
