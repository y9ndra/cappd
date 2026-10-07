# Cappd

**A generic resource budget and two-phase reservation engine for TypeScript & Node.js.**

Prevent quota overages, handle variable-cost workloads (like LLM tokens, API credits, and compute tasks), and eliminate concurrency race conditions using atomic pre-reservations and post-execution reconciliation.

[![npm version](https://img.shields.io/npm/v/cappd.svg?style=flat&color=3178C6)](https://www.npmjs.com/package/cappd)
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

## API Reference

### Core Engine (`Cappd`)

| Method / Property | Signature | Description |
| :--- | :--- | :--- |
| `new Cappd({ store? })` | `constructor` | Initializes the engine. Defaults to an in-memory `MemoryStore`. |
| `cappd.setBudget(budget)` | `({ key, limit, unit }) => Promise<void>` | Sets or updates a capacity ceiling for a given key. |
| `cappd.getBudget(key)` | `(key: string) => Promise<BudgetState \| null>` | Returns balance state: `limit`, `committed`, `reserved`, `available`. |
| `cappd.execute(options)` | `({ key, estimate, operation, usage }) => Promise<ExecutionResult>` | Atomic lifecycle: pre-reserves hold, executes task, rolls back on error, measures & commits. |
| `cappd.getReservation(id)` | `(id: string) => Promise<Reservation \| null>` | Inspects an individual reservation hold by ID. |
| `cappd.store` | `ResourceStore` | Direct access to underlying store primitives (`reserve`, `commit`, `release`). |

### Storage Backends

| Store | Purpose |
| :--- | :--- |
| `RedisStore` | Clustered production storage powered by atomic Redis Lua scripts. |
| `MemoryStore` | Zero-dependency local storage for development, single-node services, and tests. |

### Express Middleware

| Export | Description |
| :--- | :--- |
| `protectRoute(cappd, options, handler)` | Route wrapper ensuring pre-reservation and pre-response usage commitment. Returns HTTP 429 on budget exhaustion. |

### Domain Errors

| Error | Trigger Condition |
| :--- | :--- |
| `BudgetExceededError` | Thrown when requested capacity exceeds the available budget limit. |
| `CappdInfrastructureError` | Thrown when an underlying store (e.g. Redis) is unreachable or times out (fails closed). |
| `UsageMeasurementError` | Thrown if the operation succeeds but measuring actual resource usage fails. |
| `CappdError` | Base domain error class for all Cappd exceptions. |

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

## Star & Support ⭐

If you find **Cappd** useful for managing variable-cost quotas, LLM token limits, or protecting your APIs from concurrency race conditions, please consider starring the repository on GitHub! It helps other developers discover the library and supports ongoing maintenance.

[![Star on GitHub](https://img.shields.io/github/stars/y9ndra/cappd?style=social)](https://github.com/y9ndra/cappd)

* **Found a bug or have a suggestion?** Open an issue on [GitHub Issues](https://github.com/y9ndra/cappd/issues).
* **Want to contribute?** Check out our [Contributing Guide](CONTRIBUTING.md).
* **Security vulnerability?** See [SECURITY.md](SECURITY.md) for private reporting.

---

## Community & Contributing

* Please adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).
* Pull requests and architectural proposals are welcome! Follow the workflow in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Distributed under the [MIT License](LICENSE). Copyright &copy; 2026 [Yugendhra](https://github.com/y9ndra).
