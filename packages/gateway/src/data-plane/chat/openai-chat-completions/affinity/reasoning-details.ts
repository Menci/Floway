interface EncryptedReasoningDetail extends Record<string, unknown> { type: 'reasoning.encrypted'; data: string }

export const isEncryptedReasoningDetail = (value: unknown): value is EncryptedReasoningDetail => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return 'type' in value && value.type === 'reasoning.encrypted' && 'data' in value && typeof value.data === 'string';
};
