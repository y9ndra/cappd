import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { RedisStore } from '../src/redis-store.js';
import {
  BudgetExceededError,
  CappdError,
  UsageMeasurementError,
} from '../src/types.js';
import {
  createUsageProvider,
  FieldUsageProvider,
  StaticUsageProvider,
} from '../src/usage-provider.js';
import { withReservation } from '../src/executor.js';

describe('Stage 5 — Usage Measurement & Reconciliation', () => {
  let memoryStore: MemoryStore;
  let redisStore: RedisStore;
  const testPrefix = 'cappd:stage5';

  beforeEach(async () => {
    memoryStore = new MemoryStore();
    redisStore = new RedisStore({
      keyPrefix: testPrefix,
      url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    });

    const client = redisStore.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  afterAll(async () => {
    const client = redisStore.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await redisStore.close();
  });

  // ============================================================
  // 1. RECONCILIATION CASES (MemoryStore & RedisStore)
  // ============================================================

  describe('Reconciliation Lifecycle', () => {
    it('reconciles when actual usage < reserved usage (refunds unused capacity)', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 100000, unit: 'tokens' });

      const { result, reservation, actualUsage } = await withReservation({
        store: memoryStore,
        key: 'tenant:1',
        estimate: { amount: 20000, unit: 'tokens' },
        operation: async () => 'op-result',
        usageProvider: () => ({ amount: 14000, unit: 'tokens' }),
      });

      expect(result).toBe('op-result');
      expect(reservation.status).toBe('committed');
      expect(actualUsage).toEqual({ amount: 14000, unit: 'tokens' });
      expect(reservation.committed).toEqual({ amount: 14000, unit: 'tokens' });

      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.committed).toBe(14000);
      expect(budget?.reserved).toBe(0);
      // Available = 100,000 - 14,000 = 86,000 (unused 6,000 is restored)
      expect(budget?.available).toBe(86000);
    });

    it('reconciles when actual usage == reserved usage', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const { reservation } = await withReservation({
        store: memoryStore,
        key: 'tenant:1',
        estimate: { amount: 20000, unit: 'tokens' },
        operation: async () => 42,
        usageProvider: () => ({ amount: 20000, unit: 'tokens' }),
      });

      expect(reservation.status).toBe('committed');

      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.committed).toBe(20000);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(30000);
    });

    it('rejects commit when actual usage > reserved usage without modifying accounting', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        withReservation({
          store: memoryStore,
          key: 'tenant:1',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => 'done',
          usageProvider: () => ({ amount: 25000, unit: 'tokens' }),
        })
      ).rejects.toThrow(CappdError);

      // Verify no partial or unauthorized mutation occurred
      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(20000);
      expect(budget?.available).toBe(30000);
    });
  });

  // ============================================================
  // 2. FAILURE MODES
  // ============================================================

  describe('Failure Handling', () => {
    it('releases reservation when the underlying operation throws an error', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const operationError = new Error('Database connection failed');

      await expect(
        withReservation({
          store: memoryStore,
          key: 'tenant:1',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => {
            throw operationError;
          },
          usageProvider: () => ({ amount: 10000, unit: 'tokens' }),
        })
      ).rejects.toThrow('Database connection failed');

      // Budget capacity must be completely restored
      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('releases reservation and throws UsageMeasurementError when usage measurement fails', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        withReservation({
          store: memoryStore,
          key: 'tenant:1',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => ({ status: 'success' }),
          usageProvider: () => {
            throw new Error('Failed to parse response tokens');
          },
        })
      ).rejects.toThrow(UsageMeasurementError);

      // Verify reservation was released so capacity does not linger or leak
      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('releases reservation when usageProvider returns malformed usage object', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      await expect(
        withReservation({
          store: memoryStore,
          key: 'tenant:1',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => ({ status: 'success' }),
          // @ts-expect-error Intentionally returning invalid usage object
          usageProvider: () => ({ invalid: true }),
        })
      ).rejects.toThrow(UsageMeasurementError);

      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('never invokes operation if capacity check fails before execution', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 10000, unit: 'tokens' });

      let operationInvoked = false;

      await expect(
        withReservation({
          store: memoryStore,
          key: 'tenant:1',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => {
            operationInvoked = true;
          },
          usageProvider: () => ({ amount: 10000, unit: 'tokens' }),
        })
      ).rejects.toThrow(BudgetExceededError);

      expect(operationInvoked).toBe(false);

      const budget = await memoryStore.getBudget('tenant:1');
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(10000);
    });
  });

  // ============================================================
  // 3. GENERIC USAGE PROVIDERS
  // ============================================================

  describe('Generic Usage Providers', () => {
    it('StaticUsageProvider reports deterministic static costs (e.g. API credits)', async () => {
      await memoryStore.setBudget({ key: 'user:1', limit: 100, unit: 'credits' });
      const staticProvider = new StaticUsageProvider({ amount: 5, unit: 'credits' });

      const { actualUsage, reservation } = await withReservation({
        store: memoryStore,
        key: 'user:1',
        estimate: { amount: 5, unit: 'credits' },
        operation: async () => 'completed',
        usageProvider: staticProvider,
      });

      expect(actualUsage).toEqual({ amount: 5, unit: 'credits' });
      expect(reservation.status).toBe('committed');

      const budget = await memoryStore.getBudget('user:1');
      expect(budget?.committed).toBe(5);
      expect(budget?.available).toBe(95);
    });

    it('FieldUsageProvider extracts usage from operation response payload', async () => {
      await memoryStore.setBudget({ key: 'tenant:compute', limit: 10000, unit: 'compute-ms' });
      const fieldProvider = new FieldUsageProvider<{
        data: string;
        usage: { amount: number; unit: string };
      }>('usage');

      const { actualUsage } = await withReservation({
        store: memoryStore,
        key: 'tenant:compute',
        estimate: { amount: 1000, unit: 'compute-ms' },
        operation: async () => ({
          data: 'heavy-calc',
          usage: { amount: 480, unit: 'compute-ms' },
        }),
        usageProvider: fieldProvider,
      });

      expect(actualUsage).toEqual({ amount: 480, unit: 'compute-ms' });

      const budget = await memoryStore.getBudget('tenant:compute');
      expect(budget?.committed).toBe(480);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(9520);
    });

    it('createUsageProvider wraps custom functional logic', async () => {
      await memoryStore.setBudget({ key: 'tenant:1', limit: 50000, unit: 'tokens' });

      const provider = createUsageProvider<{ promptTokens: number; completionTokens: number }>(
        (res) => ({
          amount: res.promptTokens + res.completionTokens,
          unit: 'tokens',
        })
      );

      const { actualUsage } = await withReservation({
        store: memoryStore,
        key: 'tenant:1',
        estimate: { amount: 2000, unit: 'tokens' },
        operation: async () => ({ promptTokens: 350, completionTokens: 420 }),
        usageProvider: provider,
      });

      expect(actualUsage).toEqual({ amount: 770, unit: 'tokens' });
    });
  });

  // ============================================================
  // 4. INTEGRATION WITH REAL REDISSTORE
  // ============================================================

  describe('Integration with RedisStore', () => {
    it('executes full reserve -> execute -> measure -> commit lifecycle on RedisStore', async () => {
      await redisStore.setBudget({ key: 'tenant:redis', limit: 100000, unit: 'tokens' });

      const { result, reservation, actualUsage } = await withReservation({
        store: redisStore,
        key: 'tenant:redis',
        estimate: { amount: 25000, unit: 'tokens' },
        operation: async (res) => {
          expect(res.id).toBeDefined();
          return { data: 'redis-processed' };
        },
        usageProvider: () => ({ amount: 17500, unit: 'tokens' }),
      });

      expect(result).toEqual({ data: 'redis-processed' });
      expect(reservation.status).toBe('committed');
      expect(actualUsage.amount).toBe(17500);

      // Verify authoritative state inside Redis
      const budget = await redisStore.getBudget('tenant:redis');
      expect(budget?.committed).toBe(17500);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(82500);
    });

    it('releases Redis hold when operation throws', async () => {
      await redisStore.setBudget({ key: 'tenant:redis-fail', limit: 50000, unit: 'tokens' });

      await expect(
        withReservation({
          store: redisStore,
          key: 'tenant:redis-fail',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => {
            throw new Error('Redis operation failure');
          },
          usageProvider: () => ({ amount: 10000, unit: 'tokens' }),
        })
      ).rejects.toThrow('Redis operation failure');

      // Reserved hold must be released in Redis
      const budget = await redisStore.getBudget('tenant:redis-fail');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });
  });
});
