import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isPlural, leafKeys, pluralBase } from './keys';
import en from '../../src/i18n/locales/en';
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

// A key reaches i18next three ways: `t('a.b')`, `<Trans i18nKey="a.b">`, and a
// literal sitting behind a ternary inside either. Anchoring on `t(` alone
// matched only the first, which silently exempted every `<Trans>` in the app --
// that is how three live keys came to be deleted as orphans.
//
// So a key is recognised by its own shape instead of by its call site: a quoted
// string whose first segment is one of the top-level namespaces below is a
// translation key wherever it appears. That reads consts and lookup tables too,
// and cannot match an unrelated string like 'windows' the way a loose scan
// forward from `t(` could.
//
// A template key (`t(`a.b.${x}`)`) resolves from a value this test cannot know
// and stays out of scope; the resources suite still guarantees both locales
// agree on whatever exists.
const NAMESPACES = Object.keys(en.translation);
const LITERAL_KEY = new RegExp(`['"\`]((?:${NAMESPACES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_.]*)['"\`]`, 'g');

// The reverse direction needs a wider net than `t(...)`. A key reaches the
// call site through whatever the source does with it -- held in a const, in a
// table of presets, in a `labelKey` field -- so any string literal spelling a
// key counts as a use. Template keys contribute their literal prefix, and
// everything defined under it is reachable.
//
// A key is also cleared when a key-shaped literal is a proper prefix of it,
// because a call site is free to append: `t(`${prefix}Disable`)` names the key
// in two pieces, and only the first is in the source.
//
// The net is deliberately loose: it under-reports, and that is the safe
// direction for a test whose failure means "delete this". A key it wrongly
// clears stays in the file; a key it wrongly accuses would fail a build over a
// string that is genuinely in use.
const ANY_STRING = /['"`]([a-zA-Z][a-zA-Z0-9_.]*)['"`]/g;

// A template key is recognised by its own shape -- rooted in a namespace, like
// `LITERAL_KEY` -- rather than by sitting at a `t(` or `i18nKey=`. The call
// site is free to build the key first and hand it over later, which is how
// `dashboard.proxy.validation.timeout.${error}`, assigned to a field of a
// validation result, came to be accused of orphaning both strings under it.
const TEMPLATE_KEY_PREFIX = new RegExp(`\`((?:${NAMESPACES.join('|')})\\.(?:[a-zA-Z0-9_.]*\\.)?)\\$\\{`, 'g');

// Both scans are evidence about call sites, so both must read code only. A
// comment is prose: the letter `d` quoted in a sentence is not a use of
// `dashboard.*`. Tokenizing the file rather than regexing it is also what keeps
// a quote inside a comment, or a delimiter inside a string, from being read as
// the other kind of thing.
const STRING_OR_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

const withoutComments = (source: string) =>
  source.replace(STRING_OR_COMMENT, token => (token.startsWith('//') || token.startsWith('/*') ? ' ' : token));

// A literal clears a longer key only when the literal is itself shaped like a
// key -- rooted in a namespace, carrying a separator. Without that test any
// literal at all could clear one, and five one-word literals (`common`, `auth`,
// `provider`, `app`, and a bare `d`) between them cleared 1044 of the 1063
// defined keys: the suite reported no orphans because it had no way to report
// one.
const KEY_STEM = new RegExp(`^(?:${NAMESPACES.join('|')})\\.`);

describe('translation key usage', () => {
  const defined = new Set(leafKeys(en.translation));
  const pluralBases = new Set([...defined].filter(isPlural).map(pluralBase));
  const resolves = (key: string) => defined.has(key) || pluralBases.has(key);

  it('has a string behind every literal key the dashboard asks for', () => {
    const unresolved: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const [, key] of source.matchAll(LITERAL_KEY)) {
        // A literal that names no leaf but prefixes one is a stem the call site
        // completes -- `t(`${prefix}Disable`)` passes the stem and appends.
        if (resolves(key) || [...defined].some(leaf => leaf.startsWith(`${key}.`) || leaf.startsWith(key))) continue;
        unresolved.push(`${key} (${file.slice(SOURCE_ROOT.length + 1)})`);
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
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const [, key] of source.matchAll(ANY_STRING)) used.add(key);
      for (const [, prefix] of source.matchAll(TEMPLATE_KEY_PREFIX)) templatePrefixes.add(prefix);
    }
    const orphaned = [...defined].filter(key => {
      if (used.has(key) || used.has(pluralBase(key))) return false;
      if ([...templatePrefixes].some(prefix => key.startsWith(prefix))) return false;
      return ![...used].some(literal =>
        KEY_STEM.test(literal) && literal.length < key.length && key.startsWith(literal));
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
    // The badge's own union. Reached only as `i18nKey={`…badges.${badge.limit}`}`,
    // so no literal spells these and neither direction of the scan above can see
    // them -- deleting all three once passed every check and shipped three raw
    // keys into the badge row.
    ['dashboard.models.badges', ['context', 'prompt', 'output']],
  ])('covers every member of the enum behind %s.*', (prefix, members) => {
    expect([...members].filter(member => !resolves(`${prefix}.${member}`))).toEqual([]);
  });
});
