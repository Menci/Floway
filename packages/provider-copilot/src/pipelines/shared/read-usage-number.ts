import { isRawNumber, type JsonNumber } from '@floway-dev/protocols/common';

export const readUsageNumber = (value: unknown): JsonNumber | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return isRawNumber(value) && Number.isFinite(Number((value as { rawJSON: string }).rawJSON)) ? value as JsonNumber : undefined;
};
