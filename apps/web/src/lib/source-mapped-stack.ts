/**
 * Restores a minified `error.stack` to the positions its source maps name.
 *
 * The stack string is not standardized and no engine exposes its frames as
 * data: TC39's error-stacks proposal was blocked at the 2024-12-03 plenary for
 * defining a string format, and its successor deliberately returns "an
 * implementation-defined string"
 * (https://github.com/tc39/proposal-error-stack-accessor). ECMA-426 declines
 * the whole subject: "Stack tracing mapping without knowledge of the source
 * language is not covered by this document" (Annex B.1).
 *
 * So the frames are parsed, and parsed conservatively. Every engine that
 * reports a position at all ends the frame with `<url>:<line>:<column>`: V8
 * writes `    at fn (url:l:c)` or `    at url:l:c`, SpiderMonkey and
 * JavaScriptCore write `fn@url:l:c`. Matching only that tail carries whatever
 * the engine prefixed -- `at async`, `at new`, `at Object.<anonymous>` --
 * across untouched, and a frame naming no position at all (V8's
 * `at async Promise.all (index 0)`, which returns before appending any
 * location, or JavaScriptCore's `[native code]`) never matches and survives
 * verbatim.
 */

import { useEffect, useState } from 'react';

// The line is 1-based in every engine's stack and in `originalPositionFor`, so
// it passes through. The column is 1-based in the stack and 0-based in a source
// map, so the query subtracts one and the restored column adds it back.
//
// V8 adds the 1 at the boundary that formats the stack --
// `int column_number = position_info.column + 1`
// (https://github.com/v8/v8/blob/0218677be4a45d5394faa541b6ec74b05def1261/src/objects/call-site-info.cc#L146-L181);
// SpiderMonkey states "column numbers are represented as 1-origin"
// (https://github.com/mozilla/gecko-dev/blob/5836a062726f715fda621338a17b51aff30d0a8c/js/public/ColumnNumber.h#L6-L25).
// Every source map field is 0-based, per the decoding algorithm in ECMA-426
// (https://github.com/tc39/ecma426/blob/62f8e694b62f5e6708523dc97563580bbf17591c/spec.emu#L798-L802).
// Both browser-side libraries in the wild -- `sourcemapped-stacktrace` and
// `stacktrace-gps` -- omit this shift, which their nearest-preceding-segment
// search hides until the position lands on a segment boundary.
const COLUMN_ORIGIN_SHIFT = 1;

// A stack is attacker-influenced through the message an engine prints above the
// frames, and this pattern is two lazy quantifiers deep. Sentry caps a frame at
// the same 1024 characters after a report of quadratic backtracking
// (https://github.com/getsentry/sentry-javascript/issues/2286).
const LONGEST_FRAME = 1024;

const FRAME =
  /^(?<head>.*?)(?<url>[a-z][a-z\d+.-]*:\/\/\S+?):(?<line>\d+):(?<column>\d+)(?<tail>\)?)$/i;

// Generators emit only `//#`, consumers accept both, per ECMA-426 §11.1.2.1.1.
// Last match wins: the annotation is defined as the last one in the resource,
// and a chunk carries a second comment after it.
const MAP_COMMENT = /\/\/[#@] ?sourceMappingURL=([^\s'"]+)\s*$/gm;

// Rolldown writes the same id into the chunk and into its map, which is the
// only way to tell a map apart from one built for a different revision of a
// chunk whose content hash did not change.
// https://github.com/rolldown/rolldown/blob/83ee59a3965937ff17e34f4bda708bc581937ea3/crates/rolldown/src/utils/process_code_and_sourcemap.rs#L122-L135
const DEBUG_ID_COMMENT = /^\/\/# debugId=(\S+)\s*$/m;

// `URL.parse` says exactly this and says it without a throw, but it arrived in
// Chrome 126, Firefox 126 and Safari 18
// (https://developer.mozilla.org/en-US/docs/Web/API/URL/parse_static#browser_compatibility),
// well above the floor `build.target` declares for this app. Reaching for it
// would make the whole restore throw on a browser the app otherwise supports,
// and report it as a missing map.
const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const frameIn = (line: string) =>
  line.length <= LONGEST_FRAME ? FRAME.exec(line)?.groups : undefined;

// Only this origin's scripts are restored: the maps that ship are this app's,
// and a frame from an extension or another origin is one whose map could not
// be fetched even if it had one. Extensions do interleave frames with the
// page's own -- an MV3 content script in the main world, or Safari's
// `webkit-masked-url://hidden/`.
const ownScript = (url: string) => parseUrl(url)?.origin === window.location.origin;

const scriptsIn = (stack: string): string[] => [
  ...new Set(
    stack
      .split('\n')
      .map(line => frameIn(line)?.url)
      .filter(url => url !== undefined)
      .filter(ownScript),
  ),
];

interface LoadedMap {
  json: object;
  url: string;
}

/** Null when the script carries no map, which is not a failure to restore. */
const loadMap = async (scriptUrl: string): Promise<LoadedMap | null> => {
  // The chunk is in the HTTP cache already -- it was fetched to be run -- and
  // Workers Static Assets serves it `must-revalidate`, so anything short of
  // `force-cache` spends a round trip per chunk to be told nothing changed.
  const script = await fetch(scriptUrl, { cache: 'force-cache' });
  if (!script.ok) throw new Error(`${scriptUrl} responded ${script.status}`);
  const text = (await script.text()).trimEnd();

  const comment = [...text.matchAll(MAP_COMMENT)].at(-1);
  if (!comment) return null;

  const url = new URL(comment[1]!, scriptUrl).href;
  const response = await fetch(url);
  // An asset this app does not have is answered with the SPA shell rather than
  // a 404, so a map that was not deployed arrives as HTML with a 200.
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  if (!response.headers.get('content-type')?.includes('json')) {
    throw new Error(`${url} is not a source map`);
  }
  const json: object = await response.json();

  if ('sections' in json) throw new Error(`${url} is an index map`);

  const scriptDebugId = DEBUG_ID_COMMENT.exec(text)?.[1];
  if (scriptDebugId !== undefined && 'debugId' in json && json.debugId !== scriptDebugId) {
    throw new Error(`${url} was built for another revision of ${scriptUrl}`);
  }

  return { json, url };
};

// `sources` are URLs relative to the map, and TraceMap resolves them against
// the map's own URL, which puts every one of this app's sources back under this
// origin. The path alone is what a reader wants; anything else keeps its URL.
const displaySource = (source: string) => {
  const url = parseUrl(source);
  return url?.origin === window.location.origin ? url.pathname : source;
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
      .filter((entry): entry is [string, LoadedMap] => entry[1] !== null)
      .map(([script, map]) => [
        script,
        new TraceMap(map.json as ConstructorParameters<typeof TraceMap>[0], map.url),
      ] as const),
  );

  return stack
    .split('\n')
    .map(line => {
      const frame = frameIn(line);
      const map = frame && traced.get(frame.url!);
      if (!frame || !map) return line;

      // An engine writes 0 where it has no information, and `originalPositionFor`
      // throws on a line below 1 or a column below 0.
      const position = { column: Number(frame.column) - COLUMN_ORIGIN_SHIFT, line: Number(frame.line) };
      if (position.line < 1 || position.column < 0) return line;

      const original = originalPositionFor(map, position);
      if (original.source === null) return line;

      const column = original.column + COLUMN_ORIGIN_SHIFT;
      return `${frame.head}${displaySource(original.source)}:${original.line}:${column}${frame.tail}`;
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
  // The outcome carries the trace it belongs to, so a new trace is pending
  // again without the effect having to clear anything.
  const [outcome, setOutcome] = useState<{ of: string; restored?: string }>();

  useEffect(() => {
    if (stack === undefined || import.meta.env.DEV) return;
    let active = true;
    restoreStack(stack).then(
      restored => { if (active) setOutcome({ of: stack, restored }); },
      (error: unknown) => {
        if (!active) return;
        // The line under the trace says a map is missing; only the console can
        // say which one and why.
        console.error('Restoring the stack from its source maps failed', error);
        setOutcome({ of: stack });
      },
    );
    return () => { active = false; };
  }, [stack]);

  if (stack === undefined || import.meta.env.DEV) return { status: 'settled', stack };
  if (outcome?.of !== stack) return { status: 'loading', stack };
  return outcome.restored === undefined
    ? { status: 'failed', stack }
    : { status: 'settled', stack: outcome.restored };
};
