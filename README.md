# Cappd

> **Resource-Aware Budget & Reservation Middleware for TypeScript & Node.js**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Module](https://img.shields.io/badge/module-ESM%20%7C%20CJS-orange)](https://nodejs.org/api/packages.html#dual-commonjses-module-packages)

---

## Overview

Traditional rate limiters measure **request count** (e.g., *100 requests / minute*). Modern applications, however, are dominated by variable-cost workloads where request volume bears little relation to actual infrastructure expenditure:

```text
Request A (Chat message):        ~200 tokens
Request B (Document Analysis): ~85,000 tokens
```

Treating both as "one request" under traditional rate limiters allows massive quota overspending.

**Cappd** introduces **two-phase resource-aware budget control**:
1. **Pre-Execution Reservation**: Atomically reserves estimated capacity *before* an expensive task begins.
2. **Post-Execution Reconciliation**: Settles the exact measured consumption, permanently committing spent units and releasing unused reservation holds back to the shared pool.

---

## The Core Accounting Invariant

At all times, across every concurrent execution path and distributed process, Cappd strictly guarantees:

$$\sum \text{committed} + \sum \text{reserved} \le \text{limit}$$

No operation is permitted to breach the configured budget ceiling. If concurrent requests compete for scarce capacity, only the reservations that fit within the remaining limit are granted; all others are rejected before execution begins.

---

## Two-Phase Lifecycle

```text
                Incoming Request
                       │
                       ▼
          1. Estimate Expected Usage
            (e.g., 25,000 tokens)
                       │
                       ▼
          2. Atomically RESERVE Hold
           ┌───────────┴───────────┐
           ▼                       ▼
      [Exceeds Limit]        [Within Budget]
         REJECT                   ACCEPT
      (HTTP 429 / Error)           │
                                   ▼
                       3. Execute Operation
                       (LLM / Batch / Compute)
                                   │
                                   ▼
                       4. Measure Actual Usage
                        (e.g., 18,250 tokens)
                                   │
                                   ▼
                       5. RECONCILE Balance
                         /              \
                        ▼                ▼
                 Commit Actual     Release Surplus
                (18,250 tokens)    (6,750 tokens)
```

---

## Installation

```bash
npm install cappd
```

Package includes dual **ESM** and **CommonJS** builds with full TypeScript declarations out of the box.

---

## Quick Start

```typescript
import { MemoryStore, BudgetExceededError } from 'cappd';

// 1. Initialize a resource store (MemoryStore for local/dev, RedisStore for distributed)
const store = new MemoryStore();

// 2. Define a resource ceiling for a tenant or user
await store.setBudget({
  key: 'tenant:acme',
  limit: 100_000,
  unit: 'tokens',
});

async function handleGenerateReport(tenantId: string, prompt: string) {
  const budgetKey = `tenant:${tenantId}`;
  const estimatedTokens = 30_000;

  // 3. Atomically reserve estimated capacity prior to execution
  let reservation;
  try {
    reservation = await store.reserve(budgetKey, {
      amount: estimatedTokens,
      unit: 'tokens',
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.warn(`Budget exceeded: requested ${err.requested}, available ${err.available}`);
      throw new Error('Quota exceeded. Please retry later.');
    }
    throw err;
  }

  try {
    // 4. Perform the expensive operation
    const actualTokensUsed = await runExpensiveLlmTask(prompt);

    // 5. Reconcile: commit actual usage and refund unused tokens
    await store.commit(reservation.id, {
      amount: actualTokensUsed,
      unit: 'tokens',
    });
  } catch (executionError) {
    // 6. Release reservation hold entirely if execution fails
    await store.release(reservation.id);
    throw executionError;
  }
}
```

---

## Inspecting Budget State

You can inspect real-time accounting balances at any point:

```typescript
const state = await store.getBudget('tenant:acme');

console.log(state);
// {
//   key: 'tenant:acme',
//   limit: 100000,
//   unit: 'tokens',
//   committed: 18250,
//   reserved: 0,
//   available: 81750
// }
```

---

## Supported Resource Dimensions

Cappd is built on a **domain-agnostic resource engine**. The accounting layer operates on numeric quantities and dimensional units:

| Resource Dimension | Unit | Typical Use Case |
| :--- | :--- | :--- |
| **LLM Tokens** | `tokens` | OpenAI / Anthropic / Gemini prompt + completion tokens |
| **Compute Time** | `compute-ms` | CPU/GPU execution time in report and image generation |
| **API Credits** | `credits` | Third-party microservice and vendor quotas |
| **Storage / IO** | `bytes`, `queries` | Batch exports and database query quotas |

---

## Architecture & Store Contract

All state persistence implements the `ResourceStore` interface:

```typescript
export interface ResourceStore {
  setBudget(budget: Budget): Promise<void>;
  getBudget(key: string): Promise<BudgetState | null>;
  reserve(key: string, usage: ResourceUsage, ttlMs?: number): Promise<Reservation>;
  commit(reservationId: string, actualUsage: ResourceUsage): Promise<Reservation>;
  release(reservationId: string): Promise<Reservation>;
}
```

### Implementations

- **`MemoryStore`**: Built-in in-memory reference store using synchronous JavaScript `Map` structures. Ideal for unit tests, local development, and single-process applications.
- **`RedisStore`**: Distributed store utilizing atomic Redis Lua scripts to enforce cross-node concurrency safety without distributed locks.

See [Concurrency Specification](docs/CONCURRENCY.md) for deep architectural analysis on race condition prevention.

---

## Error Handling

Cappd exports typed error classes for deterministic error handling:

| Error Class | Trigger | Properties |
| :--- | :--- | :--- |
| `BudgetExceededError` | Requested capacity exceeds current `available` | `key`, `requested`, `available`, `unit` |
| `InvalidReservationStateError` | Operation attempted on expired, committed, or released hold | `reservationId`, `currentStatus`, `attemptedAction` |
| `ReservationNotFoundError` | Reservation ID does not exist | `reservationId` |
| `CappdError` | Base domain error (e.g. invalid arguments, unit mismatch) | `message` |

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run test suite with Vitest
npm test

# Run TypeScript typecheck
npm run typecheck

# Build dual ESM/CJS distribution with type declarations
npm run build
```

---

## License

MIT © [Yugendhra](https://github.com/y9ndra)
