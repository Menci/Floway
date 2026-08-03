import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Translation data was the larger part of the application shell, both
// languages at once, on a first visit that reads one of them. Splitting it is
// only worth anything while it stays split, and a static import anywhere in
// the shell's graph -- a test helper, a type-only import written without
// `type`, a debug aid -- folds every locale straight back into the entry
// chunk. So the property is asserted against the build output rather than
// trusted to the source: no asset the shell references may carry a locale
// module, and every locale must exist as an asset of its own.
//
// Membership is read off the sourcemaps, as in check-web-monaco-lazy.ts, since
// chunk names are rolldown's own derivation and no contract.
const clientDir = resolve(import.meta.dirname, '../dist/client');
const assetsDir = resolve(clientDir, 'assets');

const LOCALE_MODULE = /\/src\/i18n\/locales\/([^/]+)\.ts$/;

const localesIn = async (name: string): Promise<string[]> => {
  const map = await readFile(resolve(assetsDir, `${name}.map`), 'utf8').catch(() => undefined);
  if (map === undefined) return [];
  return (JSON.parse(map) as { sources: string[] }).sources.flatMap(source => {
    const matched = LOCALE_MODULE.exec(source);
    return matched ? [matched[1]!] : [];
  });
};

const assets = (await readdir(assetsDir)).filter(name => name.endsWith('.js'));

const indexHtml = await readFile(resolve(clientDir, 'index.html'), 'utf8');
const shellAssets = assets.filter(name => indexHtml.includes(name));
if (shellAssets.length === 0) throw new Error('The application shell references no built asset');

const inShell = new Set<string>();
for (const name of shellAssets) for (const locale of await localesIn(name)) inShell.add(locale);
if (inShell.size > 0) {
  throw new Error(`The application shell bundles translations: ${[...inShell].sort().join(', ')}`);
}

// A chunk carrying two locales would be fetched whole for either of them, so
// the count of chunks matters as much as their contents.
const chunkOfLocale = new Map<string, string>();
for (const name of assets) {
  const locales = await localesIn(name);
  if (locales.length > 1) throw new Error(`${name} bundles several locales: ${locales.sort().join(', ')}`);
  for (const locale of locales) chunkOfLocale.set(locale, name);
}
if (chunkOfLocale.size === 0) throw new Error('The build contains no locale asset at all');

console.log(
  `Each locale is fetched on its own: ${[...chunkOfLocale]
    .map(([locale, name]) => `${locale} in ${name}`)
    .sort()
    .join(', ')}`,
);
