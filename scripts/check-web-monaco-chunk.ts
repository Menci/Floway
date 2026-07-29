import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const clientDir = resolve(import.meta.dirname, '../apps/web/dist/client');
const assetsDir = resolve(clientDir, 'assets');
const assets = await readdir(assetsDir);
const monacoChunks = assets.filter(name => /^monaco-editor-.*\.js$/.test(name));
if (monacoChunks.length !== 1) {
  throw new Error(`Expected one lazy Monaco chunk, found: ${monacoChunks.join(', ') || 'none'}`);
}

const indexHtml = await readFile(resolve(clientDir, 'index.html'), 'utf8');
if (indexHtml.includes(monacoChunks[0]!)) {
  throw new Error(`Monaco chunk is preloaded by the application shell: ${monacoChunks[0]}`);
}

const entryName = assets.find(name => /^entry\.client-.*\.js$/.test(name));
if (!entryName) throw new Error('Client entry chunk is missing');
const entry = await readFile(resolve(assetsDir, entryName), 'utf8');
if (entry.includes('MonacoEnvironment') || entry.includes('configureMonacoYaml')) {
  throw new Error('Monaco implementation was merged back into the client entry chunk');
}

console.log(`Monaco remains lazy in ${monacoChunks[0]}`);
