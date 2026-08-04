/**
 * Restores a minified `error.stack` to the positions its source map names.
 *
 * The stack string is not standardized and the engines disagree about the
 * shape of a frame, but every engine that reports a position at all ends the
 * frame with `<url>:<line>:<column>`: V8 writes `    at fn (url:l:c)` or
 * `    at url:l:c`, SpiderMonkey and JavaScriptCore write `fn@url:l:c`.
 * Matching only that tail carries whatever the engine prefixed -- `at async`,
 * `at new`, `at Object.<anonymous>` -- across untouched, and a frame naming no
 * position at all (V8's `at async Promise.all (index 0)`, JavaScriptCore's
 * `[native code]`) never matches and so survives verbatim.
 */

import { useEffect, useState } from 'react';

// The line is 1-based in every engine's stack and in `originalPositionFor`, so
// it passes through. The column is 1-based in the stack and 0-based in a source
// map (https://tc39.es/ecma426/#sec-source-map-format), so the query subtracts
// one and the restored column adds it back.
const COLUMN_ORIGIN_SHIFT = 1;

const FRAME =
  /^(?<head>.*?)(?<url>[a-z][a-z\d+.-]*:\/\/\S+?):(?<line>\d+):(?<column>\d+)(?<tail>\)?)$/i;

const MAP_COMMENT = /\/\/# sourceMappingURL=(\S+)$/;

// Only this origin's scripts are restored: the maps that ship are this app's,
// and a frame from an extension or another origin is one whose map we could
// not fetch even if it had one.
const ownScript = (url: string) => URL.parse(url)?.origin === window.location.origin;

const scriptsIn = (stack: string): string[] => [
  ...new Set(
    stack
      .split('\n')
      .map(line => FRAME.exec(line)?.groups?.url)
      .filter(url => url !== undefined)
      .filter(ownScript),
  ),
];

/** Null when the script carries no map, which is not a failure to restore. */
const loadMap = async (scriptUrl: string): Promise<unknown> => {
  const script = await fetch(scriptUrl);
  if (!script.ok) throw new Error(`${scriptUrl} responded ${script.status}`);
  const comment = MAP_COMMENT.exec((await script.text()).trimEnd());
  if (!comment) return null;

  const mapUrl = new URL(comment[1]!, scriptUrl);
  const map = await fetch(mapUrl);
  if (!map.ok) throw new Error(`${mapUrl.href} responded ${map.status}`);
  return await map.json();
};

/** Rejects when a map this app ships cannot be read. */
export const restoreStack = async (stack: string): Promise<string> => {
  const scripts = scriptsIn(stack);
  if (scripts.length === 0) return stack;

  const [{ TraceMap, originalPositionFor }, maps] = await Promise.all([
    import('@jridgewell/trace-mapping'),
    Promise.all(scripts.map(async url => [url, await loadMap(url)] as const)),
  ]);

  const traced = new Map(
    maps
      .filter(([, map]) => map !== null)
      .map(([url, map]) => [url, new TraceMap(map as ConstructorParameters<typeof TraceMap>[0])] as const),
  );

  return stack
    .split('\n')
    .map(line => {
      const groups = FRAME.exec(line)?.groups;
      const map = groups && traced.get(groups.url!);
      if (!groups || !map) return line;

      const original = originalPositionFor(map, {
        column: Number(groups.column) - COLUMN_ORIGIN_SHIFT,
        line: Number(groups.line),
      });
      if (original.source === null || original.line === null) return line;

      const column = original.column + COLUMN_ORIGIN_SHIFT;
      return `${groups.head}${original.source}:${original.line}:${column}${groups.tail}`;
    })
    .join('\n');
};

export type StackRestoration =
  /** Nothing more is coming: the trace is already as good as it gets. */
  | { status: 'settled'; stack: string | undefined }
  | { status: 'loading'; stack: string }
  | { status: 'failed'; stack: string };

/**
 * A development build serves modules the browser already reports by their own
 * paths, so there is nothing to restore and nothing to say about it.
 */
export const useSourceMappedStack = (stack: string | undefined): StackRestoration => {
  const [restored, setRestored] = useState<string>();
  const [failure, setFailure] = useState<unknown>();

  useEffect(() => {
    if (stack === undefined || import.meta.env.DEV) return;
    let active = true;
    setRestored(undefined);
    setFailure(undefined);
    restoreStack(stack).then(
      next => { if (active) setRestored(next); },
      error => {
        if (!active) return;
        // The line under the trace says a map is missing; only the console can
        // say which one and why.
        console.error('Restoring the stack from its source maps failed', error);
        setFailure(error);
      },
    );
    return () => { active = false; };
  }, [stack]);

  if (stack === undefined || import.meta.env.DEV) return { status: 'settled', stack };
  if (restored !== undefined) return { status: 'settled', stack: restored };
  if (failure !== undefined) return { status: 'failed', stack };
  return { status: 'loading', stack };
};
