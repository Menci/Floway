import type { IRInputSettings } from './types.ts';

/**
 * The `stream` a target writer states, after checking the IR agrees with it.
 *
 * A trip's answer arrives as a stream, so the whole request describes one: the
 * IR has no field for a single-body answer and no reader that could fill one.
 * A target that wrote `stream: false` would ask the upstream for an answer this
 * side cannot consume, so the conversion fails rather than silently changing
 * what the caller asked for. The boundary that accepts requests requires
 * streaming before a trip is composed, so reaching here with `false` means the
 * IR was built outside that boundary.
 */
export const requireStreaming = (settings: IRInputSettings): true => {
  if (settings.stream !== true) throw new Error('A translation target requires a streaming request, but the IR states a non-streaming one.');
  return true;
};
