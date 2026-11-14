import type { TranslateInputError } from '../src/types.ts';

export const expectTrip = <Trip extends { readonly type: 'trip' }>(result: Trip | TranslateInputError): Trip => {
  if (result.type === 'input-error') throw new Error(`Expected a translation trip: ${result.message}`);
  return result;
};
