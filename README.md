# Cappd

> **Generic Resource Budget & Reservation Engine for TypeScript & Node.js**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-98%20passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Module](https://img.shields.io/badge/module-ESM%20%7C%20CJS-orange)](https://nodejs.org/api/packages.html#dual-commonjses-module-packages)

---

## Why Cappd?

### Traditional Rate Limiting vs. Resource Budgeting

Traditional rate limiters count **requests** over time (for example, *100 requests per minute*). This model assumes all requests impose approximately equal cost on backend infrastructure.

Modern workloads break this assumption completely:

```text
Request A (Chat ping):         ~150 tokens
Request B (Document Analysis): ~85,000 tokens
```

Treating both requests as "1 unit" allows high-cost operations to massively exceed upstream quotas and infrastructure budgets.

### The Race Condition in Variable-Cost Workloads

Even if you track cumulative usage, a naive "check-then-act" pattern fails under concurrency:

1. **Request 1** checks remaining quota: 50,000 units available. It proceeds.
2. **Request 2** checks remaining quota concurrently: 50,000 units available. It proceeds.
3. Both operations execute simultaneously and consume 45,000 units each.
4. Total consumed: **90,000 units** on a 50,000 unit budget.

**Cappd solves this with two-phase resource reservation and reconciliation:**
* **Pre-Execution Reservation**: Atomically holds an estimated capacity hold *before* an expensive task begins.
* **Post-Execution Reconciliation**: Measures exact consumption after completion, commits the actual usage permanently, and immediately refunds the unused hold back to the shared pool.

---

## The Core Accounting Invariant

At all times, across every concurrent thread and distributed node, Cappd strictly enforces:

$$\sum \text{committed} + \sum \text{reserved} \le \text{limit}$$

* **$\text{committed}$**: Permanently settled usage from completed operations.
* **$\text{reserved}$**: Temporary capacity holds currently in flight.
* **$\text{limit}$**: Total configured capacity ceiling for the budget key.

If an incoming operation requests a reservation where `committed + reserved + requested > limit`, the reservation is **atomically rejected before the operation begins**. Downstream APIs, LLMs, or compute clusters are never invoked.

---

## Two-Phase Reservation Lifecycle

```text
                  Incoming Request
                         │
                         ▼
             1. Estimate Required Usage
               (e.g., 25,000 tokens)
                         │
                         ▼
            2. Atomically RESERVE Hold
             ┌───────────┴───────────┐
             ▼                       ▼
       [Exceeds Limit]        [Within Budget]
           REJECT                 ACCEPT
    (HTTP 429 / Exception)           │
                                     ▼
                         3. Execute Operation
                         (LLM / Batch / Compute)
                         ┌───────────┴───────────┐
                         ▼                       ▼
                     [Success]               [Failure]
                         │                       │
                         ▼                       ▼
              4. Measure Actual Usage     RELEASE Hold
               (e.g., 18,250 tokens)     (0 units leaked)
                         │
                         ▼
               5. RECONCILE Balance
                /                 \
               ▼                   ▼
         Commit Actual       Release Surplus
        (18,250 tokens)      (6,750 tokens)
```

---

## Architecture Overview

```text
Application Layer
       ↓
Cappd Client (Cappd facade / protectRoute Express adapter)
       ↓
withReservation() Orchestrator
       ↓
ResourceStore Contract
  ├── MemoryStore (in-memory Map, synchronous, local/tests)
  └── RedisStore (distributed, atomic Lua scripts)
            ↓
       Redis Server
```

---

## Installation

```bash
npm install cappd
```

* **Zero additional dependencies required**: `ioredis` is bundled as a runtime dependency.
* **MemoryStore works immediately**: No external services required for local development or automated testing.
* **RedisStore**: Requires a reachable Redis 6+ or 7+ instance.
* **Express Integration**: If using `protectRoute()`, ensure `express` is installed in your application (`npm install express`).

Cappd includes full **TypeScript** declarations and dual **ESM / CommonJS** builds.

---

## Quick Start (In-Memory)

The recommended API for most applications is the `Cappd` class:

```typescript
import { Cappd, MemoryStore, BudgetExceededError } from 'cappd';

// 1. Initialize Cappd (defaults to MemoryStore)
const cappd = new Cappd({
  store: new MemoryStore(),
});

// 2. Define a budget ceiling for a user or tenant
await cappd.setBudget({
  key: 'tenant:acme',
  limit: 100_000,
  unit: 'tokens',
});

// 3. Execute a protected operation
try {
  const { result, actualUsage } = await cappd.execute({
    key: 'tenant:acme',

    // Estimated capacity to reserve before executing
    estimate: {
      amount: 20_000,
      unit: 'tokens',
    },

    // The expensive operation (only runs if reservation is granted)
    operation: async (reservation) => {
      const response = await callBackendLlm({ prompt: 'Analyze this document...' });
      return response;
    },

    // Measures actual usage from the operation's result
    usage: (response) => ({
      amount: response.tokensUsed, // e.g. 14,200
      unit: 'tokens',
    }),
  });

  console.log(`Success! Spent ${actualUsage.amount} tokens.`);
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.warn(`Quota exceeded: requested ${error.requested}, available ${error.available}`);
  }
}
```

---

## Distributed Usage (RedisStore)

For production applications spanning multiple processes or container replicas, use `RedisStore`. State transitions are orchestrated using atomic Lua scripts executed directly on Redis, providing complete isolation without distributed locking overhead:

```typescript
import { Cappd, RedisStore } from 'cappd';

const cappd = new Cappd({
  store: new RedisStore({
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    keyPrefix: 'cappd',
    commandTimeoutMs: 3000, // Timeout before triggering fail-closed safety
  }),
});
```

### Local Redis via Docker Compose

A minimal Docker Compose configuration is provided in the repository:

```bash
# Start Redis
docker compose up -d

# Stop Redis
docker compose down
```

---

## Express Adapter (`protectRoute`)

Cappd provides a first-class route adapter for Express:

```typescript
import express from 'express';
import { Cappd, RedisStore, protectRoute } from 'cappd';

const app = express();
app.use(express.json());

const cappd = new Cappd({
  store: new RedisStore({ url: 'redis://localhost:6379' }),
});

app.post(
  '/api/generate',
  protectRoute(
    cappd,
    {
      // Extract tenant/user budget key from request
      key: (req) => req.headers['x-tenant-id'] as string,

      // Estimate capacity from request parameters
      estimate: (req) => ({
        amount: Number(req.body.estimatedTokens ?? 20_000),
        unit: 'tokens',
      }),

      // Measure actual resource usage from handler's returned value
      usage: (result) => ({
        amount: result.totalTokens,
        unit: 'tokens',
      }),
    },
    // Protected route handler:
    async (req) => {
      const response = await processInference(req.body.prompt);
      return { text: response.text, totalTokens: response.tokensUsed };
    }
  )
);
```

### Pre-Response Measurement Guarantee

`protectRoute()` guarantees that **actual resource usage is measured and committed before the HTTP response is dispatched**.

1. The route handler completes and returns its result object.
2. The `usage` resolver measures the actual consumption.
3. The store commits the actual usage and releases any surplus hold.
4. Only after reconciliation completes is `res.status(200).json(result)` sent to the client.

### Automatic HTTP Status Codes

* **HTTP 429 Too Many Requests**: Returned automatically if `BudgetExceededError` occurs.
* **HTTP 503 Service Unavailable**: Returned automatically if an infrastructure failure occurs (`CappdInfrastructureError`), such as a Redis disconnect or command timeout.

---

## Advanced API: `withReservation`

For workflows that do not use the `Cappd` facade, the lower-level `withReservation` executor can be called directly:

```typescript
import { withReservation, MemoryStore } from 'cappd';

const store = new MemoryStore();

const { result, actualUsage, reservation } = await withReservation({
  store,
  key: 'tenant:123',
  estimate: { amount: 5_000, unit: 'credits' },
  operation: async (res) => {
    return await executeCreditTask();
  },
  usageProvider: (res) => ({ amount: 4_200, unit: 'credits' }),
});
```

---

## Supported Resource Dimensions

Cappd is entirely domain-agnostic. Units are user-defined strings matched during reservation and reconciliation:

| Dimension | Unit Identifier | Example Use Case |
| :--- | :--- | :--- |
| **LLM Tokens** | `'tokens'` | OpenAI, Anthropic, Gemini prompt + completion tokens |
| **Compute Duration** | `'compute-ms'` | Video rendering, report compilation, sandbox execution |
| **API Credits** | `'credits'` | Third-party microservice or vendor quotas |
| **Storage / IO** | `'bytes'`, `'queries'` | Database query quotas, export file sizes |

---

## Failure Semantics & Reliability

Cappd is engineered to fail safely under adverse network and service conditions:

### 1. Fail-Closed on Infrastructure Outage
If Redis becomes unreachable or times out during reservation, Cappd throws `CappdInfrastructureError` and aborts the operation. It **never fails open**, preventing unmetered resource spending during outages.

### 2. Commit Failure Unknown-State Safety
If network connectivity drops during `commit()`, the exact status of the Redis Lua script is uncertain. Cappd **deliberately avoids an automatic release** in this condition to prevent double-refund corruption.

### 3. Automatic Release on Operation Error
If a protected operation throws an exception, Cappd immediately releases the reservation hold, returning all reserved capacity back to the available pool.

### 4. Automatic Release on Measurement Failure
If the operation succeeds but the `usage` resolver throws or returns invalid usage, Cappd releases the reservation and surfaces `UsageMeasurementError`.

---

## API Reference

### Core Classes & Methods

| Class / Function | Purpose |
| :--- | :--- |
| `Cappd` | Main client facade for setting budgets and executing protected operations. |
| `createCappd(options?)` | Factory function returning a `Cappd` instance. |
| `MemoryStore` | In-memory store for development, CLI scripts, and testing. |
| `RedisStore` | Distributed store backed by atomic Lua scripts for Redis. |
| `protectRoute(cappd, options, handler)` | Express route middleware adapter. |
| `withReservation(options)` | Low-level functional orchestrator. |
| `createUsageProvider(fn)` | Helper creating a `UsageProvider` from a function. |
| `StaticUsageProvider` | Provider reporting a constant, fixed usage cost. |
| `FieldUsageProvider` | Provider extracting usage from an object property. |

### Error Types

| Error Class | Condition |
| :--- | :--- |
| `BudgetExceededError` | Available capacity is insufficient for the requested reservation hold. |
| `CappdInfrastructureError` | Underlying store (Redis / network) failed or timed out. |
| `InvalidReservationStateError` | Attempted invalid lifecycle transition (e.g. committing an expired hold). |
| `ReservationNotFoundError` | Reservation ID does not exist in the store. |
| `UsageMeasurementError` | Operation finished, but measuring actual usage failed. |
| `CappdError` | Base class for all Cappd domain errors. |

---

## Development & Testing

```bash
# Install dependencies
npm install

# Start local Redis container
docker compose up -d

# Run complete Vitest test suite (98 tests)
npm test

# Run TypeScript strict typecheck
npm run typecheck

# Run runnable lifecycle demo
npm run demo

# Build ESM & CJS distribution with TypeScript declarations
npm run build
```

---

## License

MIT © [Yugendhra](https://github.com/y9ndra)
