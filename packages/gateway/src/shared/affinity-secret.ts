const AFFINITY_SECRET_PATTERN = /^[0-9a-f]{64}$/;

export const parseAffinitySecret = (value: unknown, field = 'affinitySecret'): string => {
  if (typeof value !== 'string' || !AFFINITY_SECRET_PATTERN.test(value)) {
    throw new Error(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
};

export const generateAffinitySecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
