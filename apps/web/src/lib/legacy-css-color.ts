const alphaHexToRgba = (hex: string): string => {
  const digits = hex.slice(1);
  const expanded = digits.length === 4
    ? [...digits].map(digit => digit.repeat(2)).join('')
    : digits;
  const channels = expanded.match(/../g)?.map(channel => Number.parseInt(channel, 16));
  if (channels?.length !== 4) throw new TypeError(`Invalid alpha hex color: ${hex}`);
  const [red, green, blue, alpha] = channels;
  return `rgba(${red}, ${green}, ${blue}, ${Number((alpha! / 255).toFixed(6))})`;
};

const legacyFunction = (source: string, name: string, channels: string, alpha?: string): string => {
  const components = channels.trim().split(/\s+/u);
  if (components.length !== 3) return source;
  const legacyName = alpha === undefined ? name.slice(0, 3) : `${name.slice(0, 3)}a`;
  const legacyAlpha = alpha?.trim().endsWith('%')
    ? String(Number.parseFloat(alpha) / 100)
    : alpha?.trim();
  return `${legacyName}(${[...components, ...(legacyAlpha === undefined ? [] : [legacyAlpha])].join(', ')})`;
};

export const toLegacyCssColor = (source: string): string => source
  .replace(/(?<![\da-f])#(?:[\da-f]{8}|[\da-f]{4})(?![\da-f])/giu, alphaHexToRgba)
  .replace(/\b(rgb|rgba|hsl|hsla)\(\s*([^,()]+?)(?:\s*\/\s*([^()]+?))?\s*\)/giu, legacyFunction);
