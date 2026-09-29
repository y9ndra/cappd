import { describe, expect, it, beforeEach, afterAll, beforeAll } from 'vitest';
import { RedisStore } from '../src/redis-store.js';
import {
  BudgetExceededError,
  CappdError,
  InvalidReservationStateError,
  Reservation,
  ReservationNotFoundError,
} from '../src/types.js';

describe('RedisStore — Stage 4 Redis Integration & Concurrency Tests', () => {
  let store: RedisStore;
  const testPrefix = 'cappd:test';

  beforeAll(() => {
    store = new RedisStore({
      keyPrefix: testPrefix,
      url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    });
  });

  afterAll(async () => {
    // Clean up test keys from Redis
    const client = store.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await store.close();
  });

  beforeEach(async () => {
    const client = store.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  // ============================================================
  // 1. BUDGET MANAGEMENT
  // ============================================================

  describe('Budget Management', () => {
    it('creates and reads a budget with correct initial values in Redis', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const budget = await store.getBudget('tenant:1');
      expect(budget).toEqual({
        key: 'tenant:1',
        limit: 50000,
        unit: 'tokens',
        committed: 0,
        reserved: 0,
        available: 50000,
      });
    });

    it('returns null for an unconfigured budget', async () => {
      const budget = await store.getBudget('non-existent');
      expect(budget).toBeNull();
    });

    it('rejects negative budget limits', async () => {
      await expect(
        store.setBudget({ key: 'tenant:1', limit: -1000, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });

    it('updates limit on an existing budget without resetting balances', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Increase ceiling
      await store.setBudget({ key: 'tenant:1', limit: 80000, unit: 'tokens' });

      const budget = await store.getBudget('tenant:1');
      expect(budget?.limit).toBe(80000);
      expect(budget?.reserved).toBe(20000);
      expect(budget?.available).toBe(60000);
    });
  });

  // ============================================================
  // 2. RESERVE
  // ============================================================

  describe('reserve()', () => {
    it('creates a reservation and holds capacity atomically in Redis', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      expect(res.id).toBeDefined();
      expect(res.key).toBe('tenant:1');
      expect(res.reserved).toEqual({ amount: 20000, unit: 'tokens' });
      expect(res.status).toBe('reserved');
      expect(res.createdAt).toBeGreaterThan(0);
      expect(res.expiresAt).toBeGreaterThan(res.createdAt);

      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(20000);
      expect(budget?.available).toBe(30000);
    });

    it('persists reservation in Redis and allows retrieval via getReservation()', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const created = await store.reserve('tenant:1', { amount: 15000, unit: 'tokens' });
      const fetched = await store.getReservation(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.key).toBe('tenant:1');
      expect(fetched?.reserved).toEqual({ amount: 15000, unit: 'tokens' });
      expect(fetched?.status).toBe('reserved');
      expect(fetched?.createdAt).toBe(created.createdAt);
      expect(fetched?.expiresAt).toBe(created.expiresAt);
    });

    it('allows reserving exact available capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await store.reserve('tenant:1', { amount: 50000, unit: 'tokens' });

      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(50000);
      expect(budget?.available).toBe(0);
    });

    it('rejects reservation when requested exceeds available capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      await store.reserve('tenant:1', { amount: 40000, unit: 'tokens' });

      // Only 10,000 available
      await expect(
        store.reserve('tenant:1', { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(BudgetExceededError);

      // Verify no partial mutation occurred
      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(40000);
      expect(budget?.available).toBe(10000);
    });

    it('rejects reservation for unconfigured budget', async () => {
      await expect(
        store.reserve('unconfigured', { amount: 1000, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });

    it('rejects non-positive reservation amounts', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        store.reserve('tenant:1', { amount: 0, unit: 'tokens' })
      ).rejects.toThrow(CappdError);

      await expect(
        store.reserve('tenant:1', { amount: -500, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });

    it('rejects reservation with mismatched resource unit', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        store.reserve('tenant:1', { amount: 1000, unit: 'credits' })
      ).rejects.toThrow(CappdError);
    });
  });

  // ============================================================
  // 3. COMMIT
  // ============================================================

  describe('commit()', () => {
    it('commits equal actual usage and reconciles balance in Redis', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      const committed = await store.commit(res.id, { amount: 20000, unit: 'tokens' });

      expect(committed.status).toBe('committed');
      expect(committed.committed).toEqual({ amount: 20000, unit: 'tokens' });

      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(20000);
      expect(budget?.available).toBe(30000);
    });

    it('commits lower actual usage and releases unused reservation capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 30000, unit: 'tokens' });

      // Actual was only 18,000 (12,000 returned to available)
      const committed = await store.commit(res.id, { amount: 18000, unit: 'tokens' });

      expect(committed.status).toBe('committed');
      expect(committed.committed).toEqual({ amount: 18000, unit: 'tokens' });

      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(18000);
      expect(budget?.available).toBe(32000);
    });

    it('rejects commit when actual usage exceeds reservation (overage protection)', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Attempting to commit 25,000 for a 20,000 hold
      await expect(
        store.commit(res.id, { amount: 25000, unit: 'tokens' })
      ).rejects.toThrow(CappdError);

      // Verify NO partial mutation occurred
      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(20000);
      expect(budget?.committed).toBe(0);
      expect(budget?.available).toBe(30000);

      const reservation = await store.getReservation(res.id);
      expect(reservation?.status).toBe('reserved');
    });

    it('rejects double commit on already committed reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      await store.commit(res.id, { amount: 15000, unit: 'tokens' });

      await expect(
        store.commit(res.id, { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      // Verify committed usage wasn't double-counted
      const budget = await store.getBudget('tenant:1');
      expect(budget?.committed).toBe(15000);
    });

    it('throws ReservationNotFoundError for non-existent reservation ID', async () => {
      await expect(
        store.commit('non-existent-id', { amount: 1000, unit: 'tokens' })
      ).rejects.toThrow(ReservationNotFoundError);
    });

    it('handles expired reservation during commit and frees held capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      // 10ms TTL
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' }, 10);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 30));

      await expect(
        store.commit(res.id, { amount: 10000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      // Capacity should be reclaimed
      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(0);
      expect(budget?.available).toBe(50000);
    });
  });

  // ============================================================
  // 4. RELEASE
  // ============================================================

  describe('release()', () => {
    it('releases entire reserved amount back to available budget in Redis', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 25000, unit: 'tokens' });

      const released = await store.release(res.id);

      expect(released.status).toBe('released');

      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('rejects double release on already released reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 25000, unit: 'tokens' });

      await store.release(res.id);

      await expect(store.release(res.id)).rejects.toThrow(InvalidReservationStateError);

      // Reserved must not underflow into negative
      const budget = await store.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('throws ReservationNotFoundError when releasing non-existent reservation', async () => {
      await expect(store.release('non-existent-id')).rejects.toThrow(
        ReservationNotFoundError
      );
    });
  });

  // ============================================================
  // 5. TRUE DISTRIBUTED CONCURRENCY & ATOMICITY (LUA)
  // ============================================================

  describe('Distributed Concurrency & Lua Atomicity', () => {
    it('handles the core 30k + 30k against 50k limit: exactly 1 succeeds, 1 rejected', async () => {
      await store.setBudget({ key: 'tenant:concurrency', limit: 50000, unit: 'tokens' });

      // Two concurrent reserve requests competing for the exact same budget in Redis
      const [resA, resB] = await Promise.allSettled([
        store.reserve('tenant:concurrency', { amount: 30000, unit: 'tokens' }),
        store.reserve('tenant:concurrency', { amount: 30000, unit: 'tokens' }),
      ]);

      const fulfilled = [resA, resB].filter(
        (r): r is PromiseFulfilledResult<Reservation> => r.status === 'fulfilled'
      );
      const rejected = [resA, resB].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      // Exactly 1 must succeed, 1 must fail
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const firstRejected = rejected[0]!;
      expect(firstRejected.reason).toBeInstanceOf(BudgetExceededError);
      expect((firstRejected.reason as BudgetExceededError).requested).toBe(30000);

      // Redis state MUST strictly satisfy the invariant: committed + reserved <= limit
      const budget = await store.getBudget('tenant:concurrency');
      expect(budget).not.toBeNull();
      expect(budget!.committed).toBe(0);
      expect(budget!.reserved).toBe(30000);
      expect(budget!.available).toBe(20000);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });

    it('handles 5 concurrent 15k requests against 50k limit: exactly 3 succeed, 2 fail', async () => {
      await store.setBudget({ key: 'tenant:saturation', limit: 50000, unit: 'tokens' });

      // 5 concurrent requests of 15,000 = 75,000 requested against 50,000 ceiling
      const requests = Array.from({ length: 5 }, () =>
        store.reserve('tenant:saturation', { amount: 15000, unit: 'tokens' })
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // 3 * 15,000 = 45,000 <= 50,000 -> exactly 3 succeed, 2 rejected
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(2);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
      }

      // Check Redis authoritative state
      const budget = await store.getBudget('tenant:saturation');
      expect(budget!.reserved).toBe(45000);
      expect(budget!.available).toBe(5000);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });

    it('prevents double-commit accounting when commit() is called concurrently in Redis', async () => {
      await store.setBudget({ key: 'tenant:double-commit', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:double-commit', { amount: 20000, unit: 'tokens' });

      // Two concurrent calls attempting to commit the same reservation
      const [commit1, commit2] = await Promise.allSettled([
        store.commit(res.id, { amount: 18000, unit: 'tokens' }),
        store.commit(res.id, { amount: 18000, unit: 'tokens' }),
      ]);

      const fulfilled = [commit1, commit2].filter((r) => r.status === 'fulfilled');
      const rejected = [commit1, commit2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(InvalidReservationStateError);

      // Committed usage must be exactly 18,000 (not 36,000 double-counted!)
      const budget = await store.getBudget('tenant:double-commit');
      expect(budget!.committed).toBe(18000);
      expect(budget!.reserved).toBe(0);
      expect(budget!.available).toBe(32000);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });

    it('prevents double-release from corrupting budget in Redis', async () => {
      await store.setBudget({ key: 'tenant:double-release', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:double-release', { amount: 20000, unit: 'tokens' });

      // Two concurrent calls attempting to release the same reservation
      const [rel1, rel2] = await Promise.allSettled([
        store.release(res.id),
        store.release(res.id),
      ]);

      const fulfilled = [rel1, rel2].filter((r) => r.status === 'fulfilled');
      const rejected = [rel1, rel2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(InvalidReservationStateError);

      const budget = await store.getBudget('tenant:double-release');
      expect(budget!.reserved).toBe(0);
      expect(budget!.committed).toBe(0);
      expect(budget!.available).toBe(50000);
    });

    it('handles racing commit and release on the same reservation atomically', async () => {
      await store.setBudget({ key: 'tenant:race-commit-release', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:race-commit-release', {
        amount: 20000,
        unit: 'tokens',
      });

      const [commitRes, releaseRes] = await Promise.allSettled([
        store.commit(res.id, { amount: 15000, unit: 'tokens' }),
        store.release(res.id),
      ]);

      const fulfilled = [commitRes, releaseRes].filter((r) => r.status === 'fulfilled');
      const rejected = [commitRes, releaseRes].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(InvalidReservationStateError);

      const budget = await store.getBudget('tenant:race-commit-release');
      expect(budget!.reserved).toBe(0);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });
  });
});
