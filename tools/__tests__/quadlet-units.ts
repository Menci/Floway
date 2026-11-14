import { readdirSync, readFileSync } from 'node:fs';

export interface QuadletUnit {
  filename: string;
  lines: readonly string[];
}

export interface QuadletReference {
  line: string;
  target: string;
}

export interface MissingQuadletUnit extends QuadletReference {
  unit: string;
}

// Quadlet resolves these keys into peer Quadlet units while generating the
// systemd unit, and aborts generation when the peer is absent:
//
//   - `Pod=` names a `.pod` unit.
//   - `Network=` names a `.network` or `.container` unit before the options.
//   - `Mount=` treats a relative `source=` ending in `.volume`, `.image`, or
//     `.artifact` as a unit.
//   - `Image=` names a `.image` or `.build` unit when it ends in that suffix.
//
// https://github.com/containers/podman/blob/85f068d88f8c7d40f009cf7e0d56b6273696c922/pkg/systemd/quadlet/quadlet.go#L2254-L2270
// https://github.com/containers/podman/blob/85f068d88f8c7d40f009cf7e0d56b6273696c922/pkg/systemd/quadlet/quadlet.go#L1861-L1870
// https://github.com/containers/podman/blob/85f068d88f8c7d40f009cf7e0d56b6273696c922/pkg/systemd/quadlet/quadlet.go#L1978-L1982
// https://github.com/containers/podman/blob/85f068d88f8c7d40f009cf7e0d56b6273696c922/pkg/systemd/quadlet/quadlet.go#L2152-L2160
const REFERENCE_SUFFIXES: Record<string, readonly string[]> = {
  Pod: ['.pod'],
  Network: ['.network', '.container'],
  Mount: ['.volume', '.image', '.artifact'],
  Image: ['.image', '.build'],
};

const endsWithAny = (value: string, suffixes: readonly string[]): boolean =>
  suffixes.some(suffix => value.endsWith(suffix));

const parseAssignment = (line: string): { key: string; value: string } | null => {
  const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
  if (match === null) return null;
  return { key: match[1], value: match[2].trim().replace(/^"(.*)"$/, '$1') };
};

const referencesOf = (unit: QuadletUnit): QuadletReference[] =>
  unit.lines.flatMap(line => {
    const assignment = parseAssignment(line);
    if (assignment === null) return [];
    const { key, value } = assignment;
    const suffixes = REFERENCE_SUFFIXES[key];
    if (suffixes === undefined) return [];
    // `Network=` takes `unit.network:options`; only the head names a unit.
    const head = key === 'Network' ? value.split(':')[0] : value;
    // `Mount=` takes `key=value` pairs.
    const candidate = key === 'Mount'
      ? value.split(',').find(part => part.startsWith('source='))?.slice('source='.length)
      : head;
    return candidate !== undefined && endsWithAny(candidate, suffixes)
      ? [{ line, target: candidate }]
      : [];
  });

export const findMissingQuadletUnits = (units: readonly QuadletUnit[]): MissingQuadletUnit[] => {
  const present = new Set(units.map(unit => unit.filename));
  const missing: MissingQuadletUnit[] = [];
  for (const unit of units) {
    for (const reference of referencesOf(unit)) {
      if (!present.has(reference.target)) missing.push({ unit: unit.filename, ...reference });
    }
  }
  return missing;
};

// Shipped Quadlet files carry a `.example` suffix so a checkout never feeds them
// to systemd; the unit they describe is the name without it.
const unitFilename = (filename: string): string => filename.replace(/\.example$/, '');

export const readQuadletUnits = (directory: string): QuadletUnit[] => {
  const units: QuadletUnit[] = [];
  for (const filename of readdirSync(directory)) {
    const unit = unitFilename(filename);
    if (!endsWithAny(unit, Object.values(REFERENCE_SUFFIXES).flat())) continue;
    units.push({ filename: unit, lines: readFileSync(`${directory}/${filename}`, 'utf8').split('\n') });
  }
  return units.sort((left, right) => left.filename.localeCompare(right.filename));
};
