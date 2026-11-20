import type { ChatFacts } from './facts.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export type RequestKey = Extract<keyof ChatFacts, `request.chat.${string}`>;

/** One wire, as the chain that dials it. The keys are erased at this seam for the same
 *  reason they are erased on `Stage`: what a wire reads and hands up is checked by assembly
 *  and by the runner against declarations, and a family's slice type is nobody's business
 *  in between. */
export type ChatWire = Pipeline<Record<string, unknown>, Record<string, unknown>>;
