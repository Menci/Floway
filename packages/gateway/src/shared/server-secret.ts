export const parseServerSecret = (value: unknown, field = 'serverSecret'): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
};

export const serverSecretBytes = (value: unknown, field = 'serverSecret'): Uint8Array => {
  const secret = parseServerSecret(value, field);
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16));
};

export const generateServerSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
