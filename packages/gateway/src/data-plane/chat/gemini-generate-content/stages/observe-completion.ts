import type { DeliveryFacts } from '../../shared/encode.ts';
import type { ChatFrameFacts } from '../../shared/route-body.ts';
import { type Deferred, defineStage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { createGeminiGenerateContentCandidateCompletion, type GeminiGenerateContentStreamEvent, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';

export const geminiCompletionKey = 'response.geminiGenerateContent.complete';

export interface GeminiCompletionFacts {
  readonly [geminiCompletionKey]: Deferred<boolean> | undefined;
}

export const geminiTerminal = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): 'completed' | 'protocol-error' | undefined => {
  if (frame.type === 'done') return 'completed';
  if (isGeminiGenerateContentErrorEvent(frame.event)) return 'protocol-error';
  if (isGeminiGenerateContentTerminalEvent(frame.event)) return 'completed';
};

type Response = ChatFrameFacts<'geminiGenerateContent'>;
const framesKey = 'response.geminiGenerateContent';

// Track frames before affinity buffers them, so an observed final frame still counts on release.
export const observeGeminiCompletion = defineStage<DeliveryFacts, DeliveryFacts, Response, Response & GeminiCompletionFacts>({
  name: 'observeCompletion',
  through: {
    request: { needs: ['request.delivery'], consumes: [], provides: [] },
    response: { needs: [framesKey], consumes: [], provides: [framesKey, geminiCompletionKey] },
  },
  execute: async (facts, next, env) => {
    const response = await next(facts);
    const events = response[framesKey];
    if (events === undefined || !facts['request.delivery'].stream) return { ...response, [geminiCompletionKey]: undefined };
    const candidates = createGeminiGenerateContentCandidateCompletion();
    let terminal: ReturnType<typeof geminiTerminal>;
    const observed = env.wrapStream(events, {
      label: 'Gemini completion observation',
      async *transform(source) {
        for await (const frame of source) {
          if (terminal === undefined) {
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
    const completion = env.deferred<boolean>('protocol completion', observed);
    return { ...response, [framesKey]: observed, [geminiCompletionKey]: completion.deferred };
  },
});
