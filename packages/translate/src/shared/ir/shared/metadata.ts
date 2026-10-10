import type { IR } from '../ir.ts';
import type { IROutputOptions } from './projection.ts';
import type { IREvent } from '../stream.ts';

export const irOutputMetadata = (event: Extract<IREvent, { type: 'start' }>, options: IROutputOptions) => ({
  id: options.id ?? event.id,
  model: event.model,
  created: event.created ?? options.created ?? Math.floor(Date.now() / 1000),
});

export const irServingModel = (state: IR, model: string): string => {
  const source = state.extensions?.anthropicMessages ?? state.extensions?.openaiResponses ?? state.extensions?.openaiChatCompletions;
  return typeof source?.model === 'string' ? source.model : model;
};
