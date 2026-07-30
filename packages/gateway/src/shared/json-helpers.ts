export { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';

export const asJsonObject = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null);

export const readJsonNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
