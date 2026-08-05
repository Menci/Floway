import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { init, parse } from 'es-module-lexer';

// The logo needs byte HSV conversion on every surface, while Culori parsing and
// WCAG work belongs to badge labels. Keep that route-independent helper out of
// Culori's general parser and converter graph, including indirect static imports.
const assetsDir = resolve(import.meta.dirname, '../dist/client/assets');
const BYTE_MODULE = '/src/lib/color-bytes.ts';
const CULORI_MODULE = '/node_modules/culori/';

const names = await readdir(assetsDir);
const chunks = new Set(names.filter(name => name.endsWith('.js')));
const sourcesByChunk = new Map<string, string[]>();
for (const name of names.filter(name => name.endsWith('.js.map'))) {
  const { sources } = JSON.parse(await readFile(resolve(assetsDir, name), 'utf8')) as { sources: string[] };
  sourcesByChunk.set(name.slice(0, -4), sources);
}

const byteChunks: string[] = [];
for (const [name, sources] of sourcesByChunk) {
  if (sources.some(source => source.endsWith(BYTE_MODULE))) byteChunks.push(name);
}

if (byteChunks.length === 0) throw new Error('The production build contains no color byte helper');

await init;
const reachable = new Set(byteChunks);
const pending = [...byteChunks];
while (pending.length > 0) {
  const chunk = pending.pop()!;
  const [imports] = parse(await readFile(resolve(assetsDir, chunk), 'utf8'));
  for (const imported of imports) {
    if (imported.d !== -1 || !imported.n?.startsWith('.')) continue;
    const target = relative(assetsDir, resolve(assetsDir, dirname(chunk), imported.n));
    if (!chunks.has(target) || reachable.has(target)) continue;
    reachable.add(target);
    pending.push(target);
  }
}

const offenders = [...reachable].filter(chunk =>
  sourcesByChunk.get(chunk)?.some(source => source.includes(CULORI_MODULE)));
if (offenders.length > 0) throw new Error(`Culori is statically reachable from color byte helpers: ${offenders.join(', ')}`);

console.log(`Color byte helpers stay Culori-free in ${byteChunks.join(', ')}`);
