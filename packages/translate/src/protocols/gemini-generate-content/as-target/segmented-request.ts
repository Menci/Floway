import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurn } from './assistant-turn.ts';
import {
  geminiGenerateContentConversationFromIR,
  geminiGenerateContentHeaderFromIR,
  type GeminiGenerateContentCallLookup,
} from './input-from.ts';
import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { TranslateOptions } from '../../../types.ts';
import type {
  GeminiGenerateContentContent,
  GeminiGenerateContentPart,
  GeminiGenerateContentRequest,
} from '@floway-dev/protocols/gemini-generate-content';

const appendSegmentContents = (
  target: GeminiGenerateContentContent[],
  incoming: readonly GeminiGenerateContentContent[],
  separateFirstUser: boolean,
): void => {
  for (const [index, content] of incoming.entries()) {
    const last = target.at(-1);
    if (index === 0 && !separateFirstUser && content.role === 'user' && last?.role === 'user') {
      last.parts ??= [];
      last.parts.push(...(content.parts ?? []));
      continue;
    }
    target.push(content);
  }
};

export const geminiGenerateContentPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  callLookup: GeminiGenerateContentCallLookup,
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'> = {},
): GeminiGenerateContentRequest => {
  const systemParts: GeminiGenerateContentPart[] = [];
  const contents: GeminiGenerateContentContent[] = [];
  let separateNextUser = false;

  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') {
      for (const entry of piece.turn) {
        const { syntheticCallIds: _syntheticCallIds, ...wireContent } = entry;
        contents.push(klona(wireContent));
      }
      separateNextUser = false;
      continue;
    }
    const segment = geminiGenerateContentConversationFromIR(
      piece.turns,
      piece.leading,
      callLookup,
      separateNextUser,
    );
    systemParts.push(...segment.systemParts);
    appendSegmentContents(contents, segment.contents, separateNextUser);
    separateNextUser = segment.trailingDroppedAssistant;
  }

  return {
    ...geminiGenerateContentHeaderFromIR(request, options),
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
    contents,
  };
};
