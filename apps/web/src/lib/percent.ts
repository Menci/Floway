import { NO_READING } from './no-reading';

// A non-finite reading means the upstream reported nothing usable, which is not
// the same reading as zero, so it comes back as null and the caller says
// "unknown".
export const clampPercent = (percent: number): number | null =>
  Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;

export const percentText = (percent: number | null): string => percent === null ? NO_READING : `${percent}%`;
