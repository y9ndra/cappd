import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import {
  BudgetExceededError,
  CappdError,
  InvalidReservationStateError,
  ReservationNotFoundError,
} from '../src/types.js';

describe('MemoryStore — Reservation & Reconciliation Lifecycle', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ============================================================
  // BUDGET MANAGEMENT
  // ============================================================

  describe('Budget Management', () => {
    it('initializes budget with available equal to limit', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const state = await store.getBudget('tenant:1');
      expect(state).toEqual({
        key: 'tenant:1',
        limit: 50000,
        unit: 'tokens',
        committed: 0,
        reserved: 0,
        available: 50000,
      });
    });

    it('returns null for an unconfigured budget', async () => {
      const state = await store.getBudget('unknown');
      expect(state).toBeNull();
    });

    it('disallows negative budget limits', async () => {
      await expect(
        store.setBudget({ key: 'tenant:1', limit: -100, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });
  });

  // ============================================================
  // RESERVE
  // ============================================================

  describe('reserve()', () => {
    it('creates a reservation and holds capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      expect(res.id).toBeDefined();
      expect(res.key).toBe('tenant:1');
      expect(res.reserved).toEqual({ amount: 20000, unit: 'tokens' });
      expect(res.status).toBe('reserved');
      expect(res.createdAt).toBeGreaterThan(0);
      expect(res.expiresAt).toBeGreaterThan(res.createdAt);
    });

    it('reduces available capacity after reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // available = 50000 - 0 - 20000 = 30000
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(20000);
      expect(state?.available).toBe(30000);
    });

    it('allows multiple reservations that fit within the budget', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await store.reserve('tenant:1', { amount: 15000, unit: 'tokens' });
      await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });
      await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // 15000 + 10000 + 20000 = 45000 reserved
      // available = 50000 - 0 - 45000 = 5000
      const state = await store.getBudget('tenant:1');
      expect(state?.reserved).toBe(45000);
      expect(state?.available).toBe(5000);
    });

    it('rejects reservation when requested exceeds available capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await store.reserve('tenant:1', { amount: 40000, unit: 'tokens' });

      // Only 10000 available, requesting 15000
      await expect(
        store.reserve('tenant:1', { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(BudgetExceededError);

      // Verify accounting was not corrupted by the failed reservation
      const state = await store.getBudget('tenant:1');
      expect(state?.reserved).toBe(40000);
      expect(state?.available).toBe(10000);
    });

    it('rejects reservation with mismatched resource unit', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        store.reserve('tenant:1', { amount: 5000, unit: 'compute-ms' })
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

    it('rejects reservation when no budget is configured', async () => {
      await expect(
        store.reserve('unknown-key', { amount: 1000, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });

    it('generates unique IDs for each reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 100000, unit: 'tokens' });

      const res1 = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });
      const res2 = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      expect(res1.id).not.toBe(res2.id);
    });
  });

  // ============================================================
  // COMMIT
  // ============================================================

  describe('commit()', () => {
    it('commits when actual usage equals reserved amount', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      const committed = await store.commit(res.id, { amount: 20000, unit: 'tokens' });

      expect(committed.status).toBe('committed');
      expect(committed.committed).toEqual({ amount: 20000, unit: 'tokens' });

      // committed = 20000, reserved = 0, available = 30000
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(20000);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(30000);
    });

    it('commits when actual usage is less than reserved (releases difference)', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Actual usage was only 15000 — the 5000 difference returns to available
      const committed = await store.commit(res.id, { amount: 15000, unit: 'tokens' });

      expect(committed.status).toBe('committed');
      expect(committed.committed).toEqual({ amount: 15000, unit: 'tokens' });

      // committed = 15000, reserved = 0
      // available = 50000 - 15000 - 0 = 35000  (5000 returned)
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(15000);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(35000);
    });

    it('commits with zero actual usage (full reservation released)', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Operation produced zero usage (e.g. cached result)
      const committed = await store.commit(res.id, { amount: 0, unit: 'tokens' });

      expect(committed.status).toBe('committed');

      // committed = 0, reserved = 0, available = 50000
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(50000);
    });

    it('rejects commit when actual usage exceeds reservation (overage)', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Actual = 25000, reserved = 20000 → rejected
      await expect(
        store.commit(res.id, { amount: 25000, unit: 'tokens' })
      ).rejects.toThrow(CappdError);

      // Verify accounting is completely untouched
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(20000);
      expect(state?.available).toBe(30000);

      // Reservation is still in RESERVED state (can be retried or released)
      const reservation = await store.getReservation(res.id);
      expect(reservation?.status).toBe('reserved');
    });

    it('prevents committing the same reservation twice', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.commit(res.id, { amount: 8000, unit: 'tokens' });

      await expect(
        store.commit(res.id, { amount: 8000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      // Accounting should reflect only the first commit
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(8000);
      expect(state?.reserved).toBe(0);
    });

    it('rejects commit on a released reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.release(res.id);

      await expect(
        store.commit(res.id, { amount: 5000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);
    });

    it('throws ReservationNotFoundError for unknown reservation ID', async () => {
      await expect(
        store.commit('non-existent-id', { amount: 100, unit: 'tokens' })
      ).rejects.toThrow(ReservationNotFoundError);
    });

    it('rejects negative actual usage', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await expect(
        store.commit(res.id, { amount: -500, unit: 'tokens' })
      ).rejects.toThrow(CappdError);
    });
  });

  // ============================================================
  // RELEASE
  // ============================================================

  describe('release()', () => {
    it('releases entire reserved amount back to available', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const res = await store.reserve('tenant:1', { amount: 25000, unit: 'tokens' });
      expect((await store.getBudget('tenant:1'))?.available).toBe(25000);

      const released = await store.release(res.id);
      expect(released.status).toBe('released');

      // Full capacity returned
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(50000);
    });

    it('prevents releasing the same reservation twice', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.release(res.id);

      await expect(store.release(res.id)).rejects.toThrow(InvalidReservationStateError);

      // Accounting unchanged from first release
      const state = await store.getBudget('tenant:1');
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(50000);
    });

    it('prevents releasing an already committed reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.commit(res.id, { amount: 9000, unit: 'tokens' });

      await expect(store.release(res.id)).rejects.toThrow(InvalidReservationStateError);
    });

    it('throws ReservationNotFoundError for unknown reservation ID', async () => {
      await expect(
        store.release('non-existent-id')
      ).rejects.toThrow(ReservationNotFoundError);
    });
  });

  // ============================================================
  // OPERATION FAILURE → RELEASE SCENARIO
  // ============================================================

  describe('Operation failure followed by release', () => {
    it('simulates a failed operation: reserve → fail → release → capacity restored', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      // Step 1: Reserve capacity before operation
      const res = await store.reserve('tenant:1', { amount: 30000, unit: 'tokens' });
      expect((await store.getBudget('tenant:1'))?.available).toBe(20000);

      // Step 2: Operation fails (simulated)
      const operationFailed = true;

      // Step 3: Release the hold because operation failed
      if (operationFailed) {
        await store.release(res.id);
      }

      // Step 4: Verify full capacity is restored
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(50000);
    });
  });

  // ============================================================
  // INVARIANT VERIFICATION
  // ============================================================

  describe('Invariant: committed + reserved <= limit', () => {
    it('invariant holds after reserve', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      const state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
    });

    it('invariant holds after commit', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });
      await store.commit(res.id, { amount: 14000, unit: 'tokens' });

      const state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
    });

    it('invariant holds after release', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });
      await store.release(res.id);

      const state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
    });

    it('invariant holds through a full mixed lifecycle', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 100000, unit: 'tokens' });

      // Reserve 3 operations
      const res1 = await store.reserve('tenant:1', { amount: 30000, unit: 'tokens' });
      const res2 = await store.reserve('tenant:1', { amount: 25000, unit: 'tokens' });
      const res3 = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Check: 30k + 25k + 20k = 75k reserved, 0 committed
      let state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
      expect(state!.reserved).toBe(75000);
      expect(state!.available).toBe(25000);

      // Commit res1 with actual 22000 (8000 returned)
      await store.commit(res1.id, { amount: 22000, unit: 'tokens' });
      state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
      expect(state!.committed).toBe(22000);
      expect(state!.reserved).toBe(45000); // 25k + 20k

      // Release res2 (operation failed, 25000 returned)
      await store.release(res2.id);
      state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
      expect(state!.committed).toBe(22000);
      expect(state!.reserved).toBe(20000);
      expect(state!.available).toBe(58000);

      // Commit res3 with actual 20000 (exact match)
      await store.commit(res3.id, { amount: 20000, unit: 'tokens' });
      state = await store.getBudget('tenant:1');
      expect(state!.committed + state!.reserved).toBeLessThanOrEqual(state!.limit);
      expect(state!.committed).toBe(42000);
      expect(state!.reserved).toBe(0);
      expect(state!.available).toBe(58000);
    });
  });

  // ============================================================
  // getReservation()
  // ============================================================

  describe('getReservation()', () => {
    it('returns null for unknown reservation', async () => {
      const res = await store.getReservation('non-existent');
      expect(res).toBeNull();
    });

    it('returns reservation with current status after commit', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });
      await store.commit(res.id, { amount: 8000, unit: 'tokens' });

      const fetched = await store.getReservation(res.id);
      expect(fetched?.status).toBe('committed');
      expect(fetched?.committed).toEqual({ amount: 8000, unit: 'tokens' });
    });

    it('returns reservation with current status after release', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });
      await store.release(res.id);

      const fetched = await store.getReservation(res.id);
      expect(fetched?.status).toBe('released');
    });
  });
});
