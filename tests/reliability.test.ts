import { describe, expect, it, beforeEach, afterAll, beforeAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Cappd } from '../src/cappd.js';
import { RedisStore } from '../src/redis-store.js';
import { protectRoute } from '../src/express.js';
import {
  CappdInfrastructureError,
  InvalidReservationStateError,
  ReservationNotFoundError,
} from '../src/types.js';

describe('Stage 7 — Reliability & Production Hardening', () => {
  let realStore: RedisStore;
  const testPrefix = 'cappd:reliability';

  beforeAll(() => {
    realStore = new RedisStore({
      keyPrefix: testPrefix,
      url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    });
  });

  afterAll(async () => {
    const client = realStore.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await realStore.close();
  });

  beforeEach(async () => {
    const client = realStore.client;
    const keys = await client.keys(`${testPrefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  // ============================================================
  // 1. REDIS UNAVAILABLE (FAIL-CLOSED POLICY)
  // ============================================================

  describe('Redis Unavailable & Fail-Closed Behavior', () => {
    it('fails closed when Redis is unreachable during reserve and never invokes operation', async () => {
      // Connect to non-existent port to simulate complete Redis outage
      const deadStore = new RedisStore({
        url: 'redis://127.0.0.1:19999',
        commandTimeoutMs: 500,
      });

      const cappd = new Cappd({ store: deadStore });
      let operationInvoked = false;

      await expect(
        cappd.execute({
          key: 'tenant:unreachable',
          estimate: { amount: 5000, unit: 'tokens' },
          operation: async () => {
            operationInvoked = true;
          },
          usage: () => ({ amount: 5000, unit: 'tokens' }),
        })
      ).rejects.toThrow(CappdInfrastructureError);

      // CRITICAL INVARIANT: Fail-closed policy ensures the protected operation NEVER runs
      expect(operationInvoked).toBe(false);

      await deadStore.close();
    });

    it('Express adapter translates CappdInfrastructureError into HTTP 503 Service Unavailable', async () => {
      const deadStore = new RedisStore({
        url: 'redis://127.0.0.1:19999',
        commandTimeoutMs: 500,
      });

      const cappd = new Cappd({ store: deadStore });
      const app = express();

      app.post(
        '/api/ai',
        protectRoute(
          cappd,
          {
            key: 'tenant:fail-closed',
            estimate: { amount: 5000, unit: 'tokens' },
            usage: () => ({ amount: 5000, unit: 'tokens' }),
          },
          async () => ({ ok: true })
        )
      );

      const res = await request(app).post('/api/ai');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'CappdInfrastructureError',
        operation: 'reserve',
      });

      await deadStore.close();
    });

    it('allows custom onInfrastructureError callback in Express adapter', async () => {
      const deadStore = new RedisStore({
        url: 'redis://127.0.0.1:19999',
        commandTimeoutMs: 500,
      });

      const cappd = new Cappd({ store: deadStore });
      const app = express();

      app.post(
        '/api/custom-infra',
        protectRoute(
          cappd,
          {
            key: 'tenant:custom-infra',
            estimate: { amount: 5000, unit: 'tokens' },
            usage: () => ({ amount: 5000, unit: 'tokens' }),
            onInfrastructureError: (err, _req, res) => {
              res.status(503).json({
                customError: 'DatabaseUnderMaintenance',
                details: err.message,
              });
            },
          },
          async () => 'never-run'
        )
      );

      const res = await request(app).post('/api/custom-infra');

      expect(res.status).toBe(503);
      expect(res.body.customError).toBe('DatabaseUnderMaintenance');

      await deadStore.close();
    });
  });

  // ============================================================
  // 2. IDEMPOTENCY & TERMINAL STATE PROTECTION UNDER RETRIES
  // ============================================================

  describe('Idempotency & Retries', () => {
    it('rejects retried commit calls on already committed reservation without double accounting', async () => {
      await realStore.setBudget({ key: 'tenant:retry-commit', limit: 50000, unit: 'tokens' });
      const resv = await realStore.reserve('tenant:retry-commit', {
        amount: 20000,
        unit: 'tokens',
      });

      // 1st Commit (succeeds)
      const firstCommit = await realStore.commit(resv.id, {
        amount: 15000,
        unit: 'tokens',
      });
      expect(firstCommit.status).toBe('committed');

      // 2nd Commit (client retry because network response dropped)
      await expect(
        realStore.commit(resv.id, { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      // Verify ZERO double accounting: committed must be 15,000, not 30,000
      const budget = await realStore.getBudget('tenant:retry-commit');
      expect(budget?.committed).toBe(15000);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(35000);
    });

    it('rejects retried release calls on already released reservation without underflowing balance', async () => {
      await realStore.setBudget({ key: 'tenant:retry-release', limit: 50000, unit: 'tokens' });
      const resv = await realStore.reserve('tenant:retry-release', {
        amount: 20000,
        unit: 'tokens',
      });

      // 1st Release (succeeds)
      await realStore.release(resv.id);

      // 2nd Release (client retry)
      await expect(realStore.release(resv.id)).rejects.toThrow(
        InvalidReservationStateError
      );

      // Verify ZERO double decrement / underflow: reserved must stay 0, available 50,000
      const budget = await realStore.getBudget('tenant:retry-release');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('rejects commit after reservation has already been released', async () => {
      await realStore.setBudget({ key: 'tenant:commit-after-release', limit: 50000, unit: 'tokens' });
      const resv = await realStore.reserve('tenant:commit-after-release', {
        amount: 20000,
        unit: 'tokens',
      });

      await realStore.release(resv.id);

      await expect(
        realStore.commit(resv.id, { amount: 10000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      const budget = await realStore.getBudget('tenant:commit-after-release');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(50000);
    });

    it('rejects release after reservation has already been committed', async () => {
      await realStore.setBudget({ key: 'tenant:release-after-commit', limit: 50000, unit: 'tokens' });
      const resv = await realStore.reserve('tenant:release-after-commit', {
        amount: 20000,
        unit: 'tokens',
      });

      await realStore.commit(resv.id, { amount: 18000, unit: 'tokens' });

      await expect(realStore.release(resv.id)).rejects.toThrow(
        InvalidReservationStateError
      );

      const budget = await realStore.getBudget('tenant:release-after-commit');
      expect(budget?.committed).toBe(18000);
      expect(budget?.reserved).toBe(0);
      expect(budget?.available).toBe(32000);
    });
  });

  // ============================================================
  // 3. EXPIRATION & RECLAMATION SEMANTICS
  // ============================================================

  describe('Reservation Expiration Semantics', () => {
    it('marks expired reservation as expired on commit attempt and restores held capacity', async () => {
      await realStore.setBudget({ key: 'tenant:expiry', limit: 50000, unit: 'tokens' });

      // 10ms short TTL
      const resv = await realStore.reserve(
        'tenant:expiry',
        { amount: 20000, unit: 'tokens' },
        10
      );

      // State immediately after reserve: 20k reserved, 30k available
      let budget = await realStore.getBudget('tenant:expiry');
      expect(budget?.reserved).toBe(20000);
      expect(budget?.available).toBe(30000);

      // Wait 30ms for expiration
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Attempt to commit expired reservation
      await expect(
        realStore.commit(resv.id, { amount: 15000, unit: 'tokens' })
      ).rejects.toThrow(InvalidReservationStateError);

      // Capacity must be reclaimed: reserved drops back to 0, available back to 50k
      budget = await realStore.getBudget('tenant:expiry');
      expect(budget?.reserved).toBe(0);
      expect(budget?.committed).toBe(0);
      expect(budget?.available).toBe(50000);

      // Reservation record in Redis is marked expired
      const record = await realStore.getReservation(resv.id);
      expect(record?.status).toBe('expired');
    });
  });

  // ============================================================
  // 4. UNKNOWN-STATE COMMIT FAILURE SEMANTICS
  // ============================================================

  describe('Commit Failure Semantics', () => {
    it('does not attempt naive release when commit is rejected for overage', async () => {
      const cappd = new Cappd({ store: realStore });
      await cappd.setBudget({ key: 'tenant:overage-guard', limit: 50000, unit: 'tokens' });

      // Estimate 20k, but actual is 25k -> overage rejection
      await expect(
        cappd.execute({
          key: 'tenant:overage-guard',
          estimate: { amount: 20000, unit: 'tokens' },
          operation: async () => ({ output: 'done' }),
          usage: () => ({ amount: 25000, unit: 'tokens' }),
        })
      ).rejects.toThrow('exceeds reservation');

      // Zero unauthorized capacity committed
      const budget = await realStore.getBudget('tenant:overage-guard');
      expect(budget?.committed).toBe(0);
      expect(budget?.reserved).toBe(20000);
      expect(budget?.available).toBe(30000);
    });
  });
});
