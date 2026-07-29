import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const clientDir = resolve(import.meta.dirname, '../apps/web/dist/client');
const assetsDir = resolve(clientDir, 'assets');
const assets = await readdir(assetsDir);
const editorChunks = assets.filter(name => /^models-yaml-editor-.*\.js$/.test(name));
if (editorChunks.length !== 1) {
  throw new Error(`Expected one lazy models YAML editor chunk, found: ${editorChunks.join(', ') || 'none'}`);
}

const indexHtml = await readFile(resolve(clientDir, 'index.html'), 'utf8');
const lazyEditorAssets = assets.filter(name => /^(?:models-yaml-editor|monaco-editor)-.*\.(?:css|js)$/.test(name));
const preloadedEditorAssets = lazyEditorAssets.filter(name => indexHtml.includes(name));
if (preloadedEditorAssets.length > 0) {
  throw new Error(`Editor assets are preloaded by the application shell: ${preloadedEditorAssets.join(', ')}`);
}

const entryName = assets.find(name => /^entry\.client-.*\.js$/.test(name));
if (!entryName) throw new Error('Client entry chunk is missing');
const entry = await readFile(resolve(assetsDir, entryName), 'utf8');
if (entry.includes('MonacoEnvironment') || entry.includes('configureMonacoYaml')) {
  throw new Error('Monaco implementation was merged back into the client entry chunk');
}
const editor = await readFile(resolve(assetsDir, editorChunks[0]!), 'utf8');
if (!editor.includes('MonacoEnvironment')) {
  throw new Error('The lazy models YAML editor chunk does not contain the Monaco implementation');
}

console.log(`Monaco remains lazy in ${editorChunks[0]}`);
