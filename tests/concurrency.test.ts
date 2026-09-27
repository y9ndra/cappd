import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import {
  BudgetExceededError,
  InvalidReservationStateError,
  Reservation,
  ResourceUsage,
} from '../src/types.js';

describe('Stage 3 — Concurrency & Atomicity Requirements', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ============================================================
  // 1. CONCEPTUAL CONCURRENCY SCENARIO (Part 5)
  // ============================================================

  describe('Core Concurrency Scenario: limit = 50,000, two 30,000 reservations', () => {
    it('allows exactly one reservation and rejects the other, preserving the invariant', async () => {
      await store.setBudget({ key: 'tenant:concurrency', limit: 50000, unit: 'tokens' });

      // Two concurrent reserve requests competing for the same capacity
      const [resultA, resultB] = await Promise.allSettled([
        store.reserve('tenant:concurrency', { amount: 30000, unit: 'tokens' }),
        store.reserve('tenant:concurrency', { amount: 30000, unit: 'tokens' }),
      ]);

      const fulfilled = [resultA, resultB].filter(
        (r): r is PromiseFulfilledResult<Reservation> => r.status === 'fulfilled'
      );
      const rejected = [resultA, resultB].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      // Exactly one must succeed
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const firstRejected = rejected[0]!;
      // The rejected one must be BudgetExceededError
      expect(firstRejected.reason).toBeInstanceOf(BudgetExceededError);
      expect((firstRejected.reason as BudgetExceededError).requested).toBe(30000);

      // Accounting state must strictly preserve the invariant: committed + reserved <= limit
      const budget = await store.getBudget('tenant:concurrency');
      expect(budget).not.toBeNull();
      expect(budget!.committed).toBe(0);
      expect(budget!.reserved).toBe(30000);
      expect(budget!.available).toBe(20000);

      // Invariant check: committed + reserved <= limit
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });

    it('handles multiple concurrent requests without exceeding the budget ceiling', async () => {
      await store.setBudget({ key: 'tenant:batch', limit: 50000, unit: 'tokens' });

      // 5 concurrent requests of 15,000 tokens each = 75,000 requested against 50,000 limit
      const requests = Array.from({ length: 5 }, () =>
        store.reserve('tenant:batch', { amount: 15000, unit: 'tokens' })
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

      const budget = await store.getBudget('tenant:batch');
      expect(budget!.reserved).toBe(45000);
      expect(budget!.available).toBe(5000);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });
  });

  // ============================================================
  // 2. DETERMINISTIC DEMONSTRATION OF CHECK-THEN-ACT RACE CONDITION
  // ============================================================

  describe('Race Condition Demonstration: Unsafe Check-Then-Act Simulation', () => {
    /**
     * NonAtomicStoreSimulator:
     * Demonstrates what happens when check-then-act is NOT executed as an atomic unit.
     * In any distributed or asynchronous system (e.g. naive SQL/NoSQL without atomic transactions or Lua),
     * an I/O pause between reading available capacity and writing the reservation allows
     * concurrent requests to observe stale capacity and both proceed.
     */
    class NonAtomicStoreSimulator {
      private limit = 50000;
      private committed = 0;
      public reserved = 0;

      async nonAtomicReserve(amount: number): Promise<boolean> {
        // Step 1: Read budget and calculate available capacity (CHECK)
        const available = this.limit - this.committed - this.reserved;

        // Step 2: Simulate network / I/O latency yielding control back to the event loop
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Step 3: Act on stale state read in Step 1
        if (amount > available) {
          return false; // Rejected
        }

        // Step 4: Mutate reservation state (ACT)
        this.reserved += amount;
        return true; // Granted
      }
    }

    it('demonstrates that non-atomic check-then-act violates the core invariant', async () => {
      const racyStore = new NonAtomicStoreSimulator();

      // Two concurrent requests of 30,000 tokens against a 50,000 limit
      const [resA, resB] = await Promise.all([
        racyStore.nonAtomicReserve(30000),
        racyStore.nonAtomicReserve(30000),
      ]);

      // Both requests observed available = 50,000 during their read step!
      expect(resA).toBe(true);
      expect(resB).toBe(true);

      // FATAL INVARIANT VIOLATION:
      // reserved (60,000) > limit (50,000)!
      expect(racyStore.reserved).toBe(60000);
      expect(racyStore.reserved).toBeGreaterThan(50000);
    });

    /**
     * AtomicStoreSimulator:
     * Shows that executing capacity check and mutation as an indivisible atomic unit
     * (the pattern required in Stage 4 via Redis + Lua) guarantees invariant safety.
     */
    class AtomicStoreSimulator {
      private limit = 50000;
      private committed = 0;
      public reserved = 0;

      // Atomic execution: no asynchronous interleaving between check and mutation
      atomicReserve(amount: number): boolean {
        const available = this.limit - this.committed - this.reserved;
        if (amount > available) {
          return false;
        }
        this.reserved += amount;
        return true;
      }
    }

    it('demonstrates that atomic check-and-act guarantees invariant preservation', () => {
      const atomicStore = new AtomicStoreSimulator();

      const resA = atomicStore.atomicReserve(30000);
      const resB = atomicStore.atomicReserve(30000);

      // Exactly one succeeds, one fails
      expect(resA).toBe(true);
      expect(resB).toBe(false);

      // Invariant strictly preserved: 30,000 <= 50,000
      expect(atomicStore.reserved).toBe(30000);
      expect(atomicStore.reserved).toBeLessThanOrEqual(50000);
    });
  });

  // ============================================================
  // 3. CONCURRENT COMMIT AND RELEASE RACES (Double-Accounting Prevention)
  // ============================================================

  describe('State Transition Races: Atomicity on Commit and Release', () => {
    it('prevents double-commit accounting when commit() is called concurrently', async () => {
      await store.setBudget({ key: 'tenant:double-commit', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:double-commit', { amount: 20000, unit: 'tokens' });

      // Two concurrent calls attempting to commit the same reservation
      const [commit1, commit2] = await Promise.allSettled([
        store.commit(res.id, { amount: 18000, unit: 'tokens' }),
        store.commit(res.id, { amount: 18000, unit: 'tokens' }),
      ]);

      const fulfilled = [commit1, commit2].filter((r) => r.status === 'fulfilled');
      const rejected = [commit1, commit2].filter((r) => r.status === 'rejected');

      // Exactly one commit succeeds; second fails because state is no longer 'reserved'
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

    it('prevents double-release accounting when release() is called concurrently', async () => {
      await store.setBudget({ key: 'tenant:double-release', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:double-release', { amount: 20000, unit: 'tokens' });

      // Two concurrent calls attempting to release the same reservation
      const [rel1, rel2] = await Promise.allSettled([
        store.release(res.id),
        store.release(res.id),
      ]);

      const fulfilled = [rel1, rel2].filter((r) => r.status === 'fulfilled');
      const rejected = [rel1, rel2].filter((r) => r.status === 'rejected');

      // Exactly one release succeeds; second fails because state is no longer 'reserved'
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(InvalidReservationStateError);

      // Reserved balance must return to 0 (not negative / underflowed)
      const budget = await store.getBudget('tenant:double-release');
      expect(budget!.reserved).toBe(0);
      expect(budget!.committed).toBe(0);
      expect(budget!.available).toBe(50000);
    });

    it('prevents racing commit and release on the same reservation from corrupting balance', async () => {
      await store.setBudget({ key: 'tenant:race-commit-release', limit: 50000, unit: 'tokens' });
      const res = await store.reserve('tenant:race-commit-release', {
        amount: 20000,
        unit: 'tokens',
      });

      // Racing commit and release on the same reservation
      const [commitRes, releaseRes] = await Promise.allSettled([
        store.commit(res.id, { amount: 15000, unit: 'tokens' }),
        store.release(res.id),
      ]);

      const fulfilled = [commitRes, releaseRes].filter((r) => r.status === 'fulfilled');
      const rejected = [commitRes, releaseRes].filter((r) => r.status === 'rejected');

      // Exactly one succeeds; other rejected due to terminal state
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(InvalidReservationStateError);

      // Invariant preserved under all outcomes
      const budget = await store.getBudget('tenant:race-commit-release');
      expect(budget!.reserved).toBe(0);
      expect(budget!.committed + budget!.reserved).toBeLessThanOrEqual(budget!.limit);
    });
  });
});
