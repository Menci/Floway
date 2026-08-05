export const parseNodeStoragePath = (name: string, raw: string): string => {
  const path = raw.trim();
  if (path.length === 0) throw new Error(`${name} must not be empty`);
  return path;
};

export const parseNodeListenPort = (raw: string): number => {
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('PORT must be a decimal integer between 1 and 65535');
  }
  const port = Number(normalized);
  if (port < 1 || port > 65_535) {
    throw new Error('PORT must be a decimal integer between 1 and 65535');
  }
  return port;
};
