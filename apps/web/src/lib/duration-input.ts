// Zero is rejected here so callers don't re-check positivity.
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

// Emits the shortest spelling `parseDuration` reads back unchanged.
export const formatDurationInput = (seconds: number): string => {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};
