// The global log sink. A stage's logger writes to the stage's dump record when one is open
// and to this sink always — so a run nobody is recording still reports what went wrong.
//
// The gateway writes to the console and has no level configuration, so the threshold is
// fixed here rather than read from one. Warnings and errors are what a run produces that an
// operator has to see; `debug` and `info` describe one request's progress, and at a line per
// stage per request they would bury the request log this sits alongside. They are still
// recorded in full whenever a dump is open, which is when anyone is reading them.

import type { Logger } from '@floway-dev/pipeline';

export const consoleLogSink: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message, fields) => { console.warn(message, fields ?? {}); },
  error: (message, fields) => { console.error(message, fields ?? {}); },
};
