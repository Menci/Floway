import { test } from 'vitest';

import { assertD1CompoundSelectLimit } from './test-sqlite.ts';
import { assertThrows } from '@floway-dev/test-utils';

test('D1 compound SELECT verifier accepts five terms and rejects six', () => {
  assertD1CompoundSelectLimit('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5');
  assertThrows(
    () => assertD1CompoundSelectLimit('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6'),
    Error,
    'SQL query exceeds D1 compound SELECT limit of 5 terms',
  );
  assertD1CompoundSelectLimit("SELECT 'UNION UNION UNION UNION UNION' /* UNION */");
});
