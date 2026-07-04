import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { CursorSessionRow, Repo } from './types.ts';

// cursor_sessions is the durable half of a cross-instance Cursor turn: the
// CAS claim lock (single-flight) and the BLOB leftover round-trip differ
// subtly between the SQL impl (RETURNING + sqlite BLOB binding) and the JS
// mirror, so run both backends.
const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const row = (overrides: Partial<CursorSessionRow> = {}): CursorSessionRow => ({
  sessionKey: 'cursor:up:key:auto:abc',
  requestId: 'req-1',
  appendSeqno: 3,
  leftover: null,
  ...overrides,
});

for (const [backend, makeRepo] of REPO_BACKENDS) {
  describe(`[${backend}] cursor_sessions repo`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('claim on a missing session returns null', async () => {
      const repo = await makeRepo();
      expect(await repo.cursorSessions.claim('missing', 1000)).toBeNull();
    });

    it('put then claim returns the scalars and takes the lock', async () => {
      const repo = await makeRepo();
      await repo.cursorSessions.put(row({ appendSeqno: 7 }));
      const claimed = await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000);
      expect(claimed).toEqual({ sessionKey: 'cursor:up:key:auto:abc', requestId: 'req-1', appendSeqno: 7, leftover: null });
      // Second concurrent claim while locked → null (single-flight).
      expect(await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000)).toBeNull();
    });

    it('claim succeeds again once the lock TTL expires', async () => {
      const repo = await makeRepo();
      await repo.cursorSessions.put(row());
      await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000);
      vi.advanceTimersByTime(1001);
      expect(await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000)).not.toBeNull();
    });

    it('put clears the lock and updates the seqno', async () => {
      const repo = await makeRepo();
      await repo.cursorSessions.put(row({ appendSeqno: 3 }));
      await repo.cursorSessions.claim('cursor:up:key:auto:abc', 60_000); // lock it
      // A suspend persists the advanced seqno and clears the lock.
      await repo.cursorSessions.put(row({ appendSeqno: 9 }));
      const reclaimed = await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000);
      expect(reclaimed?.appendSeqno).toBe(9);
    });

    it('round-trips a non-empty leftover BLOB and a null one', async () => {
      const repo = await makeRepo();
      const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]);
      await repo.cursorSessions.put(row({ leftover: bytes }));
      const claimed = await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000);
      expect(claimed?.leftover ? Array.from(claimed.leftover) : null).toEqual(Array.from(bytes));

      await repo.cursorSessions.put(row({ leftover: null }));
      vi.advanceTimersByTime(2000);
      const claimed2 = await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000);
      expect(claimed2?.leftover).toBeNull();
    });

    it('delete removes the row', async () => {
      const repo = await makeRepo();
      await repo.cursorSessions.put(row());
      await repo.cursorSessions.delete('cursor:up:key:auto:abc');
      expect(await repo.cursorSessions.claim('cursor:up:key:auto:abc', 1000)).toBeNull();
    });

    it('deleteOlderThan sweeps rows refreshed before the cutoff', async () => {
      const repo = await makeRepo();
      await repo.cursorSessions.put(row({ sessionKey: 'old' }));
      vi.advanceTimersByTime(10_000);
      await repo.cursorSessions.put(row({ sessionKey: 'fresh' }));
      await repo.cursorSessions.deleteOlderThan(Date.now() - 5_000);
      expect(await repo.cursorSessions.claim('old', 1000)).toBeNull();
      expect(await repo.cursorSessions.claim('fresh', 1000)).not.toBeNull();
    });
  });
}
