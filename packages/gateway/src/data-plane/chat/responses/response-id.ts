// One client response can span several upstream calls behind hosted tools,
// so the source boundary owns one envelope id independently of output items.
export const createResponsesResponseId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `resp_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
};
