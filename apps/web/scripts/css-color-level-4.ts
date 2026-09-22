const LEVEL_4_FUNCTIONS = new Set(['color', 'hwb', 'lab', 'lch', 'oklab', 'oklch']);
const LEGACY_COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

export interface ColorLevel4Violation {
  index: number;
  syntax: string;
}

export const findCssColorLevel4 = (source: string): ColorLevel4Violation[] => {
  const violations: ColorLevel4Violation[] = [];
  const alphaHex = /(?<![\da-f])#(?:[\da-f]{8}|[\da-f]{4})(?![\da-f])/giu;
  for (const match of source.matchAll(alphaHex)) {
    violations.push({ index: match.index, syntax: match[0] });
  }

  const colorFunction = /\b([a-z-]+)\s*\(([^()]*)\)/giu;
  for (const match of source.matchAll(colorFunction)) {
    const name = match[1]!.toLowerCase();
    const parameters = match[2]!;
    if (
      LEVEL_4_FUNCTIONS.has(name)
      || (LEGACY_COLOR_FUNCTIONS.has(name) && (
        !parameters.includes(',')
        || parameters.includes('/')
        || /\b(?:from|none)\b/iu.test(parameters)
      ))
    ) {
      violations.push({ index: match.index, syntax: match[0] });
    }
  }

  return violations.toSorted((left, right) => left.index - right.index);
};
