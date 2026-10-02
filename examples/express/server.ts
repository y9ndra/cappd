/**
 * Cappd Express Integration Example
 *
 * Demonstrates:
 * 1. Protecting Express routes using `protectRoute()`.
 * 2. Pre-response measurement: actual usage is measured and committed BEFORE sending HTTP 200.
 * 3. Automatic HTTP 429 Too Many Requests when tenant budget is exceeded.
 * 4. Automatic HTTP 503 Service Unavailable on infrastructure failures.
 *
 * Run with:
 *   npx tsx examples/express/server.ts
 */

import express from 'express';
import {
  Cappd,
  MemoryStore,
  protectRoute,
} from '../../src/index.js';

const app = express();
app.use(express.json());

// 1. Initialize Cappd engine
const cappd = new Cappd({
  store: new MemoryStore(),
});

const DEFAULT_TENANT = 'tenant:acme';

// 2. Set initial tenant budget
await cappd.setBudget({
  key: DEFAULT_TENANT,
  limit: 50_000,
  unit: 'tokens',
});

// 3. Inspect tenant budget status
app.get('/api/budget', async (req, res) => {
  const tenantId = (req.query.tenant as string) ?? DEFAULT_TENANT;
  const budget = await cappd.getBudget(tenantId);
  res.json({ budget });
});

// 4. Protected expensive endpoint (e.g. AI inference or document processing)
app.post(
  '/api/chat',
  protectRoute(
    cappd,
    {
      // Extract tenant identifier from HTTP headers
      key: (req) => (req.headers['x-tenant-id'] as string) ?? DEFAULT_TENANT,

      // Pre-execution reservation estimate
      estimate: (req) => ({
        amount: Number(req.body.estimatedTokens ?? 15_000),
        unit: 'tokens',
      }),

      // Post-execution usage measurement resolver
      usage: (result: { response: string; tokensUsed: number }) => ({
        amount: result.tokensUsed,
        unit: 'tokens',
      }),
    },
    // Route handler: runs only if pre-reservation succeeds.
    // The returned value is measured and committed before the response is sent.
    async (req) => {
      const prompt = req.body.prompt ?? 'Hello!';

      // Simulate model latency and inference work
      await new Promise((resolve) => setTimeout(resolve, 50));

      const actualTokens = Math.floor(Math.random() * 5_000) + 7_000; // 7,000 - 12,000 tokens

      return {
        response: `Simulated answer to "${prompt}"`,
        tokensUsed: actualTokens,
      };
    }
  )
);

const PORT = process.env.PORT ?? 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Cappd Express example listening on http://localhost:${PORT}`);
    console.log(`Try:`);
    console.log(`  curl -X POST http://localhost:${PORT}/api/chat -H "Content-Type: application/json" -d '{"prompt":"Summarize report","estimatedTokens":20000}'`);
    console.log(`  curl http://localhost:${PORT}/api/budget`);
  });
}

export default app;
