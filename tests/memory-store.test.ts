import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import {
  BudgetExceededError,
  CappdError,
  InvalidReservationStateError,
  ReservationNotFoundError,
} from '../src/types.js';

describe('MemoryStore — Stage 1 Domain Model', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

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

  describe('Reservation & Invariant Protection', () => {
    it('creates a reservation and temporarily holds capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const reservation = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      expect(reservation.id).toBeDefined();
      expect(reservation.key).toBe('tenant:1');
      expect(reservation.reserved).toEqual({ amount: 20000, unit: 'tokens' });
      expect(reservation.status).toBe('reserved');

      // Check invariant: available = limit - committed - reserved
      // 50000 - 0 - 20000 = 30000
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(20000);
      expect(state?.available).toBe(30000);
    });

    it('rejects reservation when requested amount exceeds available capacity', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      // First reservation consumes 40,000
      await store.reserve('tenant:1', { amount: 40000, unit: 'tokens' });

      // Second reservation wants 15,000, but only 10,000 is available
      await expect(
        store.reserve('tenant:1', { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(BudgetExceededError);

      // Verify state was not corrupted
      const state = await store.getBudget('tenant:1');
      expect(state?.reserved).toBe(40000);
      expect(state?.available).toBe(10000);
    });

    it('rejects reservation if resource unit does not match budget unit', async () => {
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
    });
  });

  describe('Reconciliation (Commit)', () => {
    it('commits actual usage and releases unused reserved hold back to available', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      // Hold 20,000
      const res = await store.reserve('tenant:1', { amount: 20000, unit: 'tokens' });

      // Actual usage was only 14,000
      const committed = await store.commit(res.id, { amount: 14000, unit: 'tokens' });

      expect(committed.status).toBe('committed');
      expect(committed.committed).toEqual({ amount: 14000, unit: 'tokens' });

      // Invariant:
      // committed = 14000
      // reserved = 0 (hold removed)
      // available = 50000 - 14000 - 0 = 36000 (6000 returned to available)
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(14000);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(36000);
    });

    it('prevents committing an already committed reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.commit(res.id, { amount: 8000, unit: 'tokens' });

      await expect(
        store.commit(res.id, { amount: 8000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);
    });
  });

  describe('Cancellation (Release)', () => {
    it('releases entire reserved amount back to available on failure', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const res = await store.reserve('tenant:1', { amount: 25000, unit: 'tokens' });
      expect((await store.getBudget('tenant:1'))?.available).toBe(25000);

      // Operation failed, release hold
      const released = await store.release(res.id);
      expect(released.status).toBe('released');

      // Capacity fully returned
      const state = await store.getBudget('tenant:1');
      expect(state?.committed).toBe(0);
      expect(state?.reserved).toBe(0);
      expect(state?.available).toBe(50000);
    });

    it('prevents releasing an already committed reservation', async () => {
      await store.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:1', { amount: 10000, unit: 'tokens' });

      await store.commit(res.id, { amount: 9000, unit: 'tokens' });

      await expect(store.release(res.id)).rejects.toThrow(InvalidReservationStateError);
    });

    it('throws error when operating on unknown reservation ID', async () => {
      await expect(
        store.commit('non-existent-id', { amount: 100, unit: 'tokens' })
      ).rejects.toThrow(ReservationNotFoundError);

      await expect(
        store.release('non-existent-id')
      ).rejects.toThrow(ReservationNotFoundError);
    });
  });
});
