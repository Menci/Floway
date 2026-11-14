import type { IRInputSettings } from './types.ts';

export const requireStreaming = (settings: IRInputSettings): true => {
  if (settings.stream !== true) throw new Error('A translation target requires a streaming request, but the IR states a non-streaming one.');
  return true;
};
