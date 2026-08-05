import { encodeTime, monotonicFactory, TIME_LEN } from 'ulid';

const generateUlid = monotonicFactory();
let lastTimestamp = -1;

export const ulid = (now: number = Date.now()): string => {
  const timestamp = Math.max(now, lastTimestamp);
  lastTimestamp = timestamp;

  // monotonicFactory treats zero as an omitted seed. Seed its state at one
  // while retaining the explicit Unix-epoch timestamp supported by this API.
  // https://github.com/ulid/javascript/blob/11c2067821ee19e4dc787ca4e0125a025485edc6/source/ulid.ts#L154-L165
  const generated = generateUlid(timestamp === 0 ? 1 : timestamp);
  return timestamp === 0
    ? encodeTime(0) + generated.slice(TIME_LEN)
    : generated;
};
