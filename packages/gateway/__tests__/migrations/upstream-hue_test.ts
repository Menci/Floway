import { DatabaseSync } from 'node:sqlite';

import { converter, formatHex, modeOklch, modeRgb, useMode as registerMode } from 'culori/fn';
import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

registerMode(modeRgb);
const toRgb = converter('rgb');
registerMode(modeOklch);
const toOklch = converter('oklch');

const HUE_MIGRATION = '0074_upstream_hue.sql';

// The migration runs on Cloudflare D1 and on Node, both of which build SQLite
// with SQLITE_ENABLE_MATH_FUNCTIONS. node:sqlite is therefore the honest place
// to execute it: the sql.js build the rest of the corpus tests run on carries
// SQLite's contrib extension set instead, which spells the same functions
// differently from the two deployment targets.
const migrate = (colors: readonly (string | null)[]): number[] => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === HUE_MIGRATION) {
      const rows = colors
        .map((color, index) => `('up_${index}', 'custom', 'n', '', '', '{}', ${color === null ? 'NULL' : `'${color}'`})`)
        .join(', ');
      db.exec(`INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, color) VALUES ${rows}`);
    }
    db.exec(sql);
  }
  const migrated = db.prepare('SELECT id, hue FROM upstreams').all() as { id: string; hue: number }[];
  db.close();
  // Keyed back to the input order rather than read off a sort: the ids are
  // text, so `up_10` orders before `up_2`.
  const byId = new Map(migrated.map(row => [row.id, row.hue]));
  return colors.map((_, index) => byId.get(`up_${index}`)!);
};

// A hue every 7° so the ring is covered without landing only on multiples of
// the constants involved, crossed with the lightness and chroma extremes a
// stored color could have had. The picker offered a full HSV area, so anything
// in the sRGB cube could be in the column.
const chromaticSamples = (): string[] => {
  const hexes: string[] = [];
  for (let hue = 0; hue < 360; hue += 7) {
    for (const lightness of [0.2, 0.5, 0.85]) {
      for (const chroma of [0.02, 0.08, 0.15]) {
        hexes.push(formatHex(toRgb({ mode: 'oklch', l: lightness, c: chroma, h: hue })));
      }
    }
  }
  return hexes;
};

test('the hue migration converts a stored hex the way culori does', () => {
  const hexes = chromaticSamples();

  migrate(hexes).forEach((hue, index) => {
    const expected = toOklch(hexes[index]!)!.h!;
    // Both sides answer in degrees and the column is an integer, so the only
    // permitted difference is the rounding, plus the wrap at the top.
    const delta = Math.abs(hue - expected);
    assertEquals(
      Math.min(delta, 360 - delta) <= 0.5,
      true,
      `${hexes[index]} migrated to ${hue}°, culori reads ${expected}°`,
    );
  });
});

test('the hue migration draws a random hue for a color that has none', () => {
  // Pure grey carries a chroma of a few parts in 1e8, which is float noise
  // rather than a hue, so an angle read off it would be meaningless.
  const achromatic = ['#000000', '#ffffff', '#808080', '#3a3a3a', '#e5e5e5'];

  for (const hue of migrate(achromatic)) {
    assertEquals(Number.isInteger(hue) && hue >= 0 && hue < 360, true, `drew ${hue}`);
  }
});

test('the hue migration reads a preset key and an inherited kind default', () => {
  // Each preset takes the hue of the hex the picker showed for it, and each
  // kind default takes the hue of the preset it named.
  const presets = { amber: '#ffd740', emerald: '#00e676', cyan: '#00e5ff', violet: '#a78bfa', rose: '#ff5252', orange: '#ff9800' };
  const keys = Object.keys(presets) as (keyof typeof presets)[];

  migrate(keys).forEach((hue, index) => {
    assertEquals(hue, Math.round(toOklch(presets[keys[index]!])!.h!) % 360, `preset ${keys[index]}`);
  });
  // Every `custom` upstream inherited amber.
  assertEquals(migrate([null])[0], Math.round(toOklch(presets.amber)!.h!) % 360);
});
