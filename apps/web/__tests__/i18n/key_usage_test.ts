import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resources } from '../../src/i18n/resources';
import { BILLING_METRICS, MODEL_KINDS } from '@floway-dev/protocols/common';
import { OPTIONAL_FLAG_IDS } from '@floway-dev/provider/flags';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider/model';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const LOCALES_DIR = join(SOURCE_ROOT, 'i18n', 'locales');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === LOCALES_DIR ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

const leafKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null ? leafKeys(child, path) : [path];
  });

// i18next resolves `count` against a CLDR plural category, so the leaf that
// backs `t('x.count')` is `x.count_one` / `x.count_other` rather than `x.count`.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

// Only literal keys are checkable here. A template key (`t(`a.b.${x}`)`) is
// resolved from a value this test cannot know, so it is out of scope; the
// resources suite still guarantees both locales agree on whatever exists.
const LITERAL_KEY = /\bt\(\s*'([a-zA-Z][a-zA-Z0-9_.]*)'/g;

// The reverse direction needs a wider net than `t(...)`. A key reaches the
// call site through whatever the source does with it -- held in a const, in a
// table of presets, in a `labelKey` field -- so any string literal spelling a
// key counts as a use. Template keys contribute their literal prefix, and
// everything defined under it is reachable.
//
// A key is also cleared when some literal is a proper prefix of it, because a
// call site is free to append: `t(`${prefix}Disable`)` names the key in two
// pieces, and only the first is in the source.
//
// The net is deliberately loose: it under-reports, and that is the safe
// direction for a test whose failure means "delete this". A key it wrongly
// clears stays in the file; a key it wrongly accuses would fail a build over a
// string that is genuinely in use.
const ANY_STRING = /['"`]([a-zA-Z][a-zA-Z0-9_.]*)['"`]/g;
const TEMPLATE_KEY_PREFIX = /\bt\(\s*`([a-zA-Z][a-zA-Z0-9_.]*\.)\$\{/g;

describe('translation key usage', () => {
  const defined = new Set(leafKeys(resources.en.translation));
  const pluralBases = new Set([...defined].filter(key => PLURAL_SUFFIX.test(key)).map(key => key.replace(PLURAL_SUFFIX, '')));
  const resolves = (key: string) => defined.has(key) || pluralBases.has(key);

  it('has a string behind every literal key the dashboard asks for', () => {
    const unresolved: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const [, key] of source.matchAll(LITERAL_KEY)) {
        if (!resolves(key)) unresolved.push(`${key} (${file.slice(SOURCE_ROOT.length + 1)})`);
      }
    }
    // An unresolved key renders as the key itself, which reads as a broken
    // label rather than as an error, so nothing else catches this.
    expect(unresolved).toEqual([]);
  });

  it('has a consumer for every string it defines', () => {
    const used = new Set<string>();
    const templatePrefixes = new Set<string>();
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const [, key] of source.matchAll(ANY_STRING)) used.add(key);
      for (const [, prefix] of source.matchAll(TEMPLATE_KEY_PREFIX)) templatePrefixes.add(prefix);
    }
    const orphaned = [...defined].filter(key => {
      if (used.has(key) || used.has(key.replace(PLURAL_SUFFIX, ''))) return false;
      if ([...templatePrefixes].some(prefix => key.startsWith(prefix))) return false;
      return ![...used].some(literal => literal.length < key.length && key.startsWith(literal));
    });
    // A string nothing asks for is invisible: it survives every rename and
    // every deletion of the surface it belonged to, and both locales keep
    // translating it. Freezing a button's label left fourteen of these behind
    // in one afternoon, and the parity suite only caught the one that had
    // drifted between the two files.
    expect(orphaned).toEqual([]);
  });

  it('scans the source tree it claims to', () => {
    const files = sourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(file => file.startsWith(LOCALES_DIR))).toBe(false);
  });

  // A template key (`t(`a.b.${x}`)`) is unresolvable from the source in
  // general, but where `x` ranges over a shared enum the whole family is
  // knowable — and those enums are exactly what grows when a provider kind,
  // model kind, billing metric, or feature flag is added.
  it.each([
    ['dashboard.modelAliases.kind', MODEL_KINDS],
    ['dashboard.upstreamEditor.models.pricingMetrics', BILLING_METRICS],
    ['dashboard.upstreamEditor.flags.entries', OPTIONAL_FLAG_IDS.flatMap(id => [`${id}.label`, `${id}.description`])],
    ['dashboard.upstreams.providers', ALL_PROVIDER_KINDS],
    ['provider', ALL_PROVIDER_KINDS],
  ])('covers every member of the enum behind %s.*', (prefix, members) => {
    expect([...members].filter(member => !resolves(`${prefix}.${member}`))).toEqual([]);
  });
});
