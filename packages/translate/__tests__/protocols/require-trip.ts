import type { TranslateInputError } from '@floway-dev/translate';

export const requireTrip = async <T extends { readonly type: 'trip' }>(result: Promise<T | TranslateInputError>): Promise<T> => {
  const trip = await result;
  if (trip.type === 'input-error') throw new Error(trip.message);
  return trip;
};
