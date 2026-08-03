import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Monaco is the largest thing the dashboard can load, and it is worth its size
// only to the one route that edits a models YAML document. The property this
// asserts is therefore about the application shell rather than about any
// particular chunk: nothing the shell preloads may be part of Monaco.
//
// Chunk names are rolldown's own derivation from module basenames and are no
// contract -- the payload is `editor.api-*`, `monaco.contribution-*`, the four
// `*Mode-*` workers and ~140 language chunks, none of which a name pattern
// written here would keep matching. Membership is read off the build output
// instead: a chunk's sourcemap names the modules it was built from, and the
// stylesheets carry Monaco's own class prefix.
const clientDir = resolve(import.meta.dirname, '../dist/client');
const assetsDir = resolve(clientDir, 'assets');

const MONACO_MODULE = /\/monaco-(?:editor|yaml)\//;
const MONACO_STYLE = '.monaco-editor';
// Rolldown emits a few helper chunks with no sourcemap; a body scan stands in
// for the module list there.
const MONACO_CODE = 'MonacoEnvironment';

const isMonacoAsset = async (name: string): Promise<boolean> => {
  const body = await readFile(resolve(assetsDir, name), 'utf8');
  if (name.endsWith('.css')) return body.includes(MONACO_STYLE);
  const map = await readFile(resolve(assetsDir, `${name}.map`), 'utf8').catch(() => undefined);
  if (map === undefined) return body.includes(MONACO_CODE);
  return (JSON.parse(map) as { sources: string[] }).sources.some(source => MONACO_MODULE.test(source));
};

const assets = (await readdir(assetsDir)).filter(name => /\.(?:css|js)$/.test(name));

const indexHtml = await readFile(resolve(clientDir, 'index.html'), 'utf8');
const shellAssets = assets.filter(name => indexHtml.includes(name));
if (shellAssets.length === 0) throw new Error('The application shell references no built asset');

const preloaded: string[] = [];
for (const name of shellAssets) if (await isMonacoAsset(name)) preloaded.push(name);
if (preloaded.length > 0) {
  throw new Error(`Monaco is preloaded by the application shell: ${preloaded.join(', ')}`);
}

// Without this the assertion above would also pass on a build that dropped
// Monaco altogether.
const lazyAssets = assets.filter(name => !shellAssets.includes(name));
let monacoAssetCount = 0;
for (const name of lazyAssets) if (await isMonacoAsset(name)) monacoAssetCount += 1;
if (monacoAssetCount === 0) throw new Error('The build contains no Monaco asset at all');

console.log(`Monaco remains lazy across ${monacoAssetCount} assets outside the application shell`);
