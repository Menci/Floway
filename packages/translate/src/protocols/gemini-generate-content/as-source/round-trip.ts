import type { IRJSONObject } from '../../../ir/types.ts';
import { verifyRoundTripReplayCheck, type RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];

const geminiReplayCheckMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const text: string[] = [];
  const inlineData: { mimeType: string; data: string; audioTranscription?: string }[] = [];
  const functionCall: { id?: string; name: string; args?: IRJSONObject }[] = [];

  for (const content of turn) for (const part of content.parts ?? []) {
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

export const inspectGeminiGenerateContentAssistantTurn = (turn: GeminiGenerateContentAssistantTurn): RoundTripAssistantTurnInspection<GeminiGenerateContentAssistantTurn> => {
  const sidecars: string[] = [];
  const assistantTurn = turn.flatMap(content => {
    if (content.parts === undefined) return [content];
    const parts = content.parts.flatMap(part => {
      if (typeof part.thoughtSignature !== 'string') return [part];
      const { thoughtSignature, ...body } = part;
      sidecars.push(thoughtSignature);
      return Object.keys(body).length === 0 ? [] : [body];
    });
    return parts.length === 0 && content.parts.length > 0 ? [] : [{ ...content, parts }];
  });
  return {
    sidecars,
    turn: assistantTurn,
  };
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
