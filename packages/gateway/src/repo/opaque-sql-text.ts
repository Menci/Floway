import { z } from 'zod';

import { decodeStoredJson } from './stored-json.ts';

const opaqueSqlTextSchema = z.string();

// workerd binds and reads SQLite TEXT with explicit byte lengths, so D1 carries
// an embedded NUL across the direct driver boundary. SQLite nevertheless makes
// every expression over such TEXT undefined, which includes the comparisons
// and indexes these repository dimensions require. A JSON string scalar is
// reversible for every JavaScript string and contains no literal NUL.
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/util/sqlite.c%2B%2B#L1591-L1600
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/util/sqlite.c%2B%2B#L1738-L1743
// https://github.com/sqlite/sqlite/blob/a790e273e2a10573e8d4c5267d494b451044fb23/src/sqlite.h.in#L4957-L4972
// https://tc39.es/ecma262/multipage/structured-data.html#sec-quotejsonstring
export const encodeOpaqueSqlText = (value: string): string => JSON.stringify(value);

export const decodeOpaqueSqlText = (raw: string, context: string): string =>
  decodeStoredJson(raw, opaqueSqlTextSchema, {
    malformed: `${context} is malformed`,
    invalid: `${context} is invalid`,
  });
