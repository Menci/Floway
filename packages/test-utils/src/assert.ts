import { expect } from 'vitest';

type ErrorConstructor = new (...args: never[]) => Error;

export function assert(value: unknown, message?: string): asserts value {
  expect(Boolean(value), message).toBe(true);
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  expect(actual, message).toEqual(expected);
}

export function assertFalse(value: unknown, message?: string): void {
  expect(Boolean(value), message).toBe(false);
}

export function assertExists<T>(value: T, message?: string): asserts value is NonNullable<T> {
  expect(value, message).not.toBeNull();
  expect(value, message).not.toBeUndefined();
}

export function assertStringIncludes(actual: string, expected: string, message?: string): void {
  expect(actual, message).toContain(expected);
}

export function assertThrows(fn: () => unknown, errorClass?: ErrorConstructor, messageIncludes?: string, message?: string): Error {
  try {
    fn();
  } catch (error) {
    assertExpectedError(error, errorClass, messageIncludes, message);
    return error as Error;
  }

  throw new Error(message ?? 'Expected function to throw');
}

export async function assertRejects(fn: () => Promise<unknown> | unknown, errorClass?: ErrorConstructor, messageIncludes?: string, message?: string): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assertExpectedError(error, errorClass, messageIncludes, message);
    return error as Error;
  }

  throw new Error(message ?? 'Expected promise to reject');
}

const assertExpectedError = (error: unknown, errorClass?: ErrorConstructor, messageIncludes?: string, message?: string): void => {
  if (errorClass !== undefined) {
    expect(error, message).toBeInstanceOf(errorClass);
  }

  if (messageIncludes !== undefined) {
    expect(error instanceof Error ? error.message : String(error), message).toContain(messageIncludes);
  }
};
