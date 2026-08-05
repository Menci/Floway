import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';

export { isJsonObject, type JsonObject };

export const asJsonObject = (value: unknown): JsonObject | null => (isJsonObject(value) ? value : null);

export const readJsonNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
