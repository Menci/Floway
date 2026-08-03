import type { ApiResult } from './client';

export const mapResult = <T, U>(result: ApiResult<T>, select: (data: T) => U): ApiResult<U> =>
  result.error ? result : { data: select(result.data) };

export interface MergedResults<T> {
  values: T;
  errors: { [K in keyof T]: string | null };
  // The first failure in the order the caller listed its requests, for a page
  // that reports one message rather than one per region.
  error: string | null;
}

// A page loads its regions in parallel and each of them can fail on its own, so
// a region that failed keeps whatever is already on screen instead of blanking
// it. `current` is that screen state, and it is what fixes both the set of
// regions and their types.
export const mergeResults = <T extends Record<string, unknown>>(
  current: T,
  results: { [K in keyof T]: ApiResult<T[K]> },
): MergedResults<T> => {
  const values = { ...current };
  const errors = {} as { [K in keyof T]: string | null };
  let error: string | null = null;
  for (const key of Object.keys(current) as (keyof T)[]) {
    const result = results[key];
    if (result.error) {
      errors[key] = result.error.message;
      error ??= result.error.message;
    } else {
      values[key] = result.data;
      errors[key] = null;
    }
  }
  return { values, errors, error };
};
