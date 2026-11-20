import parseHttpDate from 'http-dates';

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
export const retryTime = (retryAfter: string | null): number | null => {
  const value = retryAfter?.trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    return null;
  }
};
