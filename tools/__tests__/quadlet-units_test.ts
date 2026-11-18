import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { findMissingQuadletUnits, readQuadletUnits, type QuadletUnit } from './quadlet-units.ts';

const unit = (filename: string, ...lines: string[]): QuadletUnit => ({ filename, lines });

test('volume mounts, networks, and image units resolve by their suffix', () => {
  expect(findMissingQuadletUnits([
    unit(
      'floway.container',
      'Mount=type=volume,source=floway-data.volume,destination=/data',
      'Network=floway.network:alias=floway',
      'Image=floway.image',
    ),
  ])).toEqual([
    { unit: 'floway.container', line: 'Mount=type=volume,source=floway-data.volume,destination=/data', target: 'floway-data.volume' },
    { unit: 'floway.container', line: 'Network=floway.network:alias=floway', target: 'floway.network' },
    { unit: 'floway.container', line: 'Image=floway.image', target: 'floway.image' },
  ]);
});

test('the shipped Quadlet files reference only units that exist', () => {
  const units = readQuadletUnits(fileURLToPath(new URL('../../docker/systemd/', import.meta.url)));
  expect(units.map(entry => entry.filename)).toEqual(['floway-data.volume', 'floway.container']);
  expect(findMissingQuadletUnits(units)).toEqual([]);
});
