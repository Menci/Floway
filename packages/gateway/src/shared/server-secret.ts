export const parseServerSecret = (value: unknown, field = 'serverSecret'): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
};

export const generateServerSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
