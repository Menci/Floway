import type { ChatOutcomeFacts } from '../../shared/route-body.ts';
import { isTransportFailure } from '@floway-dev/http';
import { type Deferred, defineStage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { createGeminiGenerateContentCandidateCompletion, type GeminiGenerateContentStreamEvent, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProtocolOutcome } from '@floway-dev/provider';

type Outcome = ProtocolOutcome<GeminiGenerateContentStreamEvent>;
export interface GeminiCompletionFacts {
  readonly 'response.geminiGenerateContent':
    | (Extract<Outcome, { kind: 'stream' }> & { readonly contentCompletion: Deferred<boolean> })
    | Exclude<Outcome, { kind: 'stream' }>;
}

export const geminiTerminal = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): 'completed' | 'protocol-error' | undefined => {
  if (frame.type === 'done') return 'completed';
  if (isGeminiGenerateContentErrorEvent(frame.event)) return 'protocol-error';
  if (isGeminiGenerateContentTerminalEvent(frame.event)) return 'completed';
};

type Response = ChatOutcomeFacts<'geminiGenerateContent'>;
const outcomeKey = 'response.geminiGenerateContent';

// Track frames before affinity buffers them, so an observed final frame still counts on release.
export const observeGeminiCompletion = defineStage<object, object, Response, GeminiCompletionFacts>({
  name: 'observeCompletion',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: [outcomeKey], consumes: [], provides: [outcomeKey] },
  },
  execute: async (facts, scope) => {
    const response = await scope.next(facts);
    const outcome = response[outcomeKey];
    if (outcome.kind !== 'stream') return { ...response, [outcomeKey]: outcome };
    const candidates = createGeminiGenerateContentCandidateCompletion();
    let terminal: ReturnType<typeof geminiTerminal>;
    const events = scope.wrapStream(outcome.events, {
      label: 'Gemini completion observation',
      async *transform(source) {
        for await (const frame of source) {
          if (isTransportFailure(frame)) {
            terminal = 'protocol-error';
          } else if (terminal === undefined) {
            terminal = geminiTerminal(frame);
            if (terminal === undefined && frame.type === 'event') candidates.observe(frame.event);
          }
          yield frame;
        }
      },
      onClose(): void {
        completion.resolve(terminal === 'completed' || (terminal === undefined && candidates.isComplete()));
      },
    });
    const completion = scope.deferred<boolean>('protocol completion', events);
    return { ...response, [outcomeKey]: { ...outcome, events, contentCompletion: completion.deferred } };
  },
});
