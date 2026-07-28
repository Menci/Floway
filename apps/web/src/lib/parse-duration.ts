// Parse a human-typed retention window. Accepts a plain integer (seconds), or
// an integer followed by `s`/`m`/`h`/`d`. Returns the equivalent number of
// seconds, or null when the input does not parse or resolves to zero — the
// parser is the boundary, so callers don't need to re-check positivity.
export const parseDuration = (input: string): number | null => {
  const trimmed = input.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const m = /^(\d+)\s*([smhd])$/i.exec(trimmed);
    if (!m) return null;
    const unit = m[2].toLowerCase() as 's' | 'm' | 'h' | 'd';
    seconds = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  }
  return seconds > 0 ? seconds : null;
};
