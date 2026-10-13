import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
const load = () => import('@/lib/read-state');
it('keys isolate actor, full query and Chicago day and only consume matching seeds', async () => {
  expect(existsSync('src/lib/read-state.ts'), 'read state implementation exists').toBe(true);
  const { readKey, seedFor } = await load();
  const a = readKey('actor-a', 'bids', { pageSize: 10 }, '2026-10-13');
  expect(readKey('actor-b', 'bids', { pageSize: 10 }, '2026-10-13')).not.toBe(a);
  expect(readKey('actor-a', 'bids', { pageSize: 20 }, '2026-10-13')).not.toBe(a);
  expect(readKey('actor-a', 'bids', { pageSize: 10 }, '2026-10-14')).not.toBe(a);
  expect(seedFor(a, { key: a, result: { data: 2 } })).toEqual({data: 2});
  expect(seedFor('different', { key: a, result: { data: 2 } })).toBeUndefined();
});
it('deduplicates ordinary loads but invalidation starts a new generation and rejects old response', async () => {
  expect(existsSync('src/lib/read-state.ts'), 'read state implementation exists').toBe(true);
  const { ReadRequests } = await load();
  const requests = new ReadRequests<number>();
  let oldResolve!: (n:number) => void;
  const oldLoad = vi.fn(() => new Promise<number>(r => oldResolve=r));
  const old = requests.load('same', oldLoad);
  expect(requests.load('same', oldLoad)).toBe(old);
  requests.invalidate();
  const next = requests.load('same', async () => 9);
  expect((await next.promise)).toBe(9);
  oldResolve(2); await old.promise;
  expect(requests.current(old)).toBe(false);
  expect(requests.current(next)).toBe(true);
});
