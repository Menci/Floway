import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The logo needs byte HSV conversion on every surface, while Culori parsing and
// WCAG work belongs to badge labels. Keep that route-independent helper out of
// any chunk that carries Culori's general parser and converter graph.
const assetsDir = resolve(import.meta.dirname, '../dist/client/assets');
const BYTE_MODULE = '/src/lib/color-bytes.ts';
const CULORI_MODULE = '/node_modules/culori/';

const maps = (await readdir(assetsDir)).filter(name => name.endsWith('.js.map'));
const byteChunks: string[] = [];
const offenders: string[] = [];
for (const name of maps) {
  const { sources } = JSON.parse(await readFile(resolve(assetsDir, name), 'utf8')) as { sources: string[] };
  if (!sources.some(source => source.endsWith(BYTE_MODULE))) continue;
  byteChunks.push(name.slice(0, -4));
  if (sources.some(source => source.includes(CULORI_MODULE))) offenders.push(name.slice(0, -4));
}

if (byteChunks.length === 0) throw new Error('The production build contains no color byte helper');
if (offenders.length > 0) throw new Error(`Culori reached the color byte helper chunk: ${offenders.join(', ')}`);

console.log(`Color byte helpers stay Culori-free in ${byteChunks.join(', ')}`);
