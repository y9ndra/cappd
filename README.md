# Cappd

> **Resource budget and reservation engine for TypeScript & Node.js**

[![CI](https://github.com/y9ndra/cappd/actions/workflows/ci.yml/badge.svg)](https://github.com/y9ndra/cappd/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-98%20passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

---

## The Problem

Traditional rate limiters count **requests per minute**. That works when every request costs the same, but breaks completely on variable-cost workloads:

```text
Request A (Chat ping):         ~150 tokens
Request B (Document Analysis): ~85,000 tokens
```

Treating both as "1 request" allows high-cost operations to blow past quota ceilings. Furthermore, naive "check-then-act" database queries suffer from race conditions under load.

**Cappd solves this with two-phase capacity reservation & reconciliation:**
1. **Pre-Execution Reservation**: Atomically holds estimated capacity *before* work starts.
2. **Post-Execution Reconciliation**: Settles exact measured consumption, permanently committing spent units and refunding unused holds back to the shared pool.

$$\sum \text{committed} + \sum \text{reserved} \le \text{limit}$$

---

## How It Works

```text
Incoming Request ──► 1. Estimate Usage
                            │
                            ▼
                     2. Atomically RESERVE Hold (Redis Lua)
                            ┌───────────────┴───────────────┐
                            ▼                               ▼
                      [Exceeds Limit]                 [Within Budget]
                          REJECT                          ACCEPT
                     (HTTP 429 Error)                        │
                                                             ▼
                                                    3. Run Operation
                                                    ┌───────┴───────┐
                                                    ▼               ▼
                                                [Success]       [Failure]
                                                    │               │
                                                    ▼               ▼
                                         4. Measure Actual     RELEASE Hold
                                                    │         (0 leaked)
                                                    ▼
                                         5. RECONCILE Balance
                                           ├── Commit Actual
                                           └── Refund Surplus
```

---

## Installation

```bash
npm install cappd
```

* **Zero extra dependencies required**: `ioredis` is bundled for distributed setups.
* **Dual module**: Full native ESM & CommonJS support with TypeScript `.d.ts` declarations.

---

## Quick Start

```typescript
import { Cappd, MemoryStore, BudgetExceededError } from 'cappd';

const cappd = new Cappd({
  store: new MemoryStore(), // Use RedisStore in production
});

// 1. Set a budget ceiling for a tenant or user
await cappd.setBudget({
  key: 'tenant:acme',
  limit: 100_000,
  unit: 'tokens',
});

// 2. Execute an operation under protected reservation
try {
  const { result, actualUsage } = await cappd.execute({
    key: 'tenant:acme',
    estimate: { amount: 20_000, unit: 'tokens' },

    // The protected task (only executes if reservation is granted)
    operation: async (reservation) => {
      return await callLlmService({ prompt: 'Summarize quarterly report' });
    },

    // Measures actual consumption from the return value
    usage: (res) => ({ amount: res.tokensUsed, unit: 'tokens' }),
  });

  console.log(`Success! Actually used: ${actualUsage.amount} tokens.`);
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.warn(`Budget exceeded: ${err.requested} requested, ${err.available} available.`);
  }
}
```

---

## Express Integration (`protectRoute`)

Cappd includes a pre-response measuring route adapter for Express:

```typescript
import express from 'express';
import { Cappd, RedisStore, protectRoute } from 'cappd';

const app = express();
const cappd = new Cappd({
  store: new RedisStore({ url: process.env.REDIS_URL }),
});

app.post(
  '/api/generate',
  protectRoute(
    cappd,
    {
      key: (req) => req.headers['x-tenant-id'] as string,
      estimate: (req) => ({ amount: req.body.estimatedTokens ?? 15_000, unit: 'tokens' }),
      usage: (res) => ({ amount: res.tokensUsed, unit: 'tokens' }),
    },
    async (req) => {
      // Returns result payload to be measured and committed BEFORE res.json() is sent
      const answer = await processLlm(req.body.prompt);
      return { text: answer.text, tokensUsed: answer.tokens };
    }
  )
);
```

* **Pre-Response Guarantee**: Usage is measured and committed to the store *before* the HTTP response is dispatched, preventing clients from chaining unmetered requests.
* **HTTP 429**: Returned automatically if budget is exceeded (route handler never executes).
* **HTTP 503**: Returned automatically if Redis times out or drops (fail-closed safety).

---

## Distributed Concurrency (RedisStore)

In multi-container or clustered deployments, `RedisStore` enforces atomicity across processes using embedded Lua scripts:

```typescript
import { RedisStore } from 'cappd';

const store = new RedisStore({
  url: 'redis://localhost:6379',
  keyPrefix: 'cappd',
  commandTimeoutMs: 3000, // Timeout before failing closed
});
```

* **Zero distributed locks**: Serialized atomically inside Redis's single-threaded event loop.
* **TTL Expiration**: Stale holds from crashed workers automatically expire and release.
* **Fail-Closed**: Redis connection drops or command timeouts abort operations rather than allowing unmetered consumption.

---

## Generic Resource Dimensions

Cappd is dimension-agnostic. The unit string is arbitrary and matched during reconciliation:

| Dimension | Unit | Typical Use Case |
| :--- | :--- | :--- |
| **LLM Tokens** | `'tokens'` | OpenAI, Anthropic, Gemini generation quotas |
| **Compute Time** | `'compute-ms'` | Report generation, video transcoding, sandbox tasks |
| **API Credits** | `'credits'` | Microservice credit systems, SaaS tier limits |
| **Data Volume** | `'bytes'` | Export files, batch database query quotas |

---

## Non-Goals (What Cappd Does NOT Do)

To remain fast, lightweight, and focused, Cappd intentionally avoids:
* **Token counting**: Cappd does not parse prompts. You provide estimated and actual token counts (e.g. from OpenAI's `response.usage`).
* **Billing / Invoicing**: Cappd tracks raw resource quantities, not dollars, credit cards, or Stripe webhooks.
* **Job queues**: Cappd is a capacity gatekeeper, not a queue or worker framework like BullMQ.

---

## Development

```bash
# Start local Redis container
docker compose up -d

# Run Vitest test suite (98 tests across unit, concurrency, and Redis integration)
npm test

# Run strict TypeScript typecheck
npm run typecheck

# Run interactive CLI lifecycle walkthrough
npm run demo

# Build production ESM & CJS distribution
npm run build
```

---

## Contributing & License

* Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.
* For security disclosures, see [SECURITY.md](SECURITY.md).
* Licensed under the [MIT License](LICENSE).
