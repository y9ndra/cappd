import { describe, expect, it } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Cappd } from '../src/cappd.js';
import { protectRoute } from '../src/express.js';
import { UsageMeasurementError } from '../src/types.js';

describe('Express Adapter — protectRoute()', () => {
  it('allows request within budget, measures return value, commits, and sends 200', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:123', limit: 100000, unit: 'tokens' });

    const app = express();
    app.use(express.json());

    app.post(
      '/api/generate',
      protectRoute(
        cappd,
        {
          key: (req) => req.headers['x-tenant-id'] as string,
          estimate: { amount: 20000, unit: 'tokens' },
          usage: (res: { tokensUsed: number }) => ({
            amount: res.tokensUsed,
            unit: 'tokens',
          }),
        },
        async (req) => {
          // Handler executes holding the reservation and returns payload
          return {
            text: `Generated response for ${req.body.prompt}`,
            tokensUsed: 14000,
          };
        }
      )
    );

    const response = await request(app)
      .post('/api/generate')
      .set('x-tenant-id', 'tenant:123')
      .send({ prompt: 'Summarize quarterly sales' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      text: 'Generated response for Summarize quarterly sales',
      tokensUsed: 14000,
    });

    // Verify budget accounting: 14k committed, 6k refunded to available
    const budget = await cappd.getBudget('tenant:123');
    expect(budget?.committed).toBe(14000);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(86000);
  });

  it('rejects request with HTTP 429 when budget is exceeded and never runs handler', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:exhausted', limit: 10000, unit: 'tokens' });

    let handlerInvoked = false;

    const app = express();
    app.use(express.json());

    app.post(
      '/api/generate',
      protectRoute(
        cappd,
        {
          key: 'tenant:exhausted',
          estimate: { amount: 25000, unit: 'tokens' },
          usage: () => ({ amount: 10000, unit: 'tokens' }),
        },
        async () => {
          handlerInvoked = true;
          return { ok: true };
        }
      )
    );

    const response = await request(app).post('/api/generate');

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      error: 'BudgetExceededError',
      key: 'tenant:exhausted',
      requested: 25000,
      available: 10000,
      unit: 'tokens',
    });

    // Handler was never called
    expect(handlerInvoked).toBe(false);

    // Budget state remains untouched
    const budget = await cappd.getBudget('tenant:exhausted');
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(10000);
  });

  it('allows custom onBudgetExceeded callback to customize rejection response', async () => {
    const cappd = new Cappd();
    // Budget ceiling is only 5 credits
    await cappd.setBudget({ key: 'tenant:custom', limit: 5, unit: 'credits' });

    const app = express();
    app.post(
      '/api/action',
      protectRoute(
        cappd,
        {
          key: 'tenant:custom',
          // Requesting 10 credits against 5 ceiling -> triggers budget exceeded
          estimate: { amount: 10, unit: 'credits' },
          usage: () => ({ amount: 10, unit: 'credits' }),
          onBudgetExceeded: (err, _req, res) => {
            res.status(402).json({
              error: 'PaymentRequired',
              message: `Please upgrade your tier. Remaining: ${err.available} ${err.unit}`,
            });
          },
        },
        async () => 'never-reached'
      )
    );

    const response = await request(app).post('/api/action');

    expect(response.status).toBe(402);
    expect(response.body).toEqual({
      error: 'PaymentRequired',
      message: 'Please upgrade your tier. Remaining: 5 credits',
    });
  });

  it('releases reservation hold when route handler throws an application error', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:fail', limit: 50000, unit: 'tokens' });

    const app = express();
    app.post(
      '/api/fail',
      protectRoute(
        cappd,
        {
          key: 'tenant:fail',
          estimate: { amount: 20000, unit: 'tokens' },
          usage: () => ({ amount: 10000, unit: 'tokens' }),
        },
        async () => {
          throw new Error('Database query timed out');
        }
      )
    );

    // Error handling middleware
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const response = await request(app).post('/api/fail');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database query timed out' });

    // Reservation was released immediately, no capacity leaked
    const budget = await cappd.getBudget('tenant:fail');
    expect(budget?.committed).toBe(0);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(50000);
  });

  it('releases reservation hold when usage measurement fails and forwards UsageMeasurementError', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:meas-fail', limit: 50000, unit: 'tokens' });

    const app = express();
    app.post(
      '/api/meas-fail',
      protectRoute(
        cappd,
        {
          key: 'tenant:meas-fail',
          estimate: { amount: 20000, unit: 'tokens' },
          usage: () => {
            throw new Error('Failed to extract token count');
          },
        },
        async () => ({ data: 'ok' })
      )
    );

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      expect(err).toBeInstanceOf(UsageMeasurementError);
      res.status(502).json({ error: 'MeasurementError', detail: err.message });
    });

    const response = await request(app).post('/api/meas-fail');

    expect(response.status).toBe(502);

    // Reservation hold was released
    const budget = await cappd.getBudget('tenant:meas-fail');
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(50000);
  });

  it('supports dynamic estimate extraction from request body', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:dynamic', limit: 50000, unit: 'compute-ms' });

    const app = express();
    app.use(express.json());

    app.post(
      '/api/compute',
      protectRoute(
        cappd,
        {
          key: 'tenant:dynamic',
          estimate: (req) => ({
            amount: req.body.maxDurationMs,
            unit: 'compute-ms',
          }),
          usage: (res: { durationMs: number }) => ({
            amount: res.durationMs,
            unit: 'compute-ms',
          }),
        },
        async (req) => {
          return { completed: true, durationMs: 450 };
        }
      )
    );

    const response = await request(app)
      .post('/api/compute')
      .send({ maxDurationMs: 1500 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ completed: true, durationMs: 450 });

    const budget = await cappd.getBudget('tenant:dynamic');
    expect(budget?.committed).toBe(450);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(49550);
  });

  it('allows sendResponse override for custom HTTP response formatting', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:custom-send', limit: 50000, unit: 'tokens' });

    const app = express();
    app.post(
      '/api/formatted',
      protectRoute(
        cappd,
        {
          key: 'tenant:custom-send',
          estimate: { amount: 10000, unit: 'tokens' },
          usage: () => ({ amount: 7500, unit: 'tokens' }),
          sendResponse: (res, result, usage, resv) => {
            res.setHeader('X-Usage-Committed', usage.amount);
            res.setHeader('X-Reservation-Id', resv.id);
            res.status(201).json({ payload: result });
          },
        },
        async () => 'my-result'
      )
    );

    const response = await request(app).post('/api/formatted');

    expect(response.status).toBe(201);
    expect(response.headers['x-usage-committed']).toBe('7500');
    expect(response.headers['x-reservation-id']).toBeDefined();
    expect(response.body).toEqual({ payload: 'my-result' });
  });
});
