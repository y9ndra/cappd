# Contributing to Cappd

Cappd is an infrastructure package for atomic resource budgeting and reservations. Because it manages distributed state, concurrency, and Redis Lua scripts, correctness and test coverage are prioritized above all else.

---

## Development Workflow

### Prerequisites
* Node.js >= 18.0.0
* Docker & Docker Compose (for running local Redis)
* Git

### 1. Local Setup
```bash
git clone https://github.com/y9ndra/cappd.git
cd cappd
npm ci
```

### 2. Start Local Redis
Integration tests and distributed store benchmarks require Redis running on `127.0.0.1:6379`:
```bash
docker compose up -d
```

Verify Redis is reachable:
```bash
docker compose ps
# or
redis-cli ping
```

### 3. Running Tests
Cappd uses [Vitest](https://vitest.dev/) for unit and integration testing.

```bash
# Run the complete test suite (unit + Redis integration)
npm test

# Run tests in watch mode during development
npm run test:watch

# Run a specific test file
npx vitest run tests/redis-store.test.ts
npx vitest run tests/concurrency.test.ts
npx vitest run tests/reliability.test.ts
```

### 4. Typechecking and Building
We enforce strict TypeScript compilation with zero type assertions where possible:
```bash
# Strict typecheck without emitting JS
npm run typecheck

# Build dual ESM/CJS bundles to dist/
npm run build

# Verify npm packaging artifact
npm pack --dry-run
```

---

## Before Opening an Issue or Pull Request

1. **Search Existing Issues**: Search both open and closed issues and pull requests first. The bug or question may already have been addressed or resolved.
2. **Discuss Major Changes First**: For large feature proposals or architectural changes, open an issue to discuss the design and trade-offs before writing code.
3. **Provide a Minimal Reproduction**: Bug reports should include a self-contained, reproducible snippet demonstrating the problem, along with your Node.js and Redis versions.

---

## Architectural Rules for Contributors

When submitting changes, keep the following core rules in mind:

1. **The Invariant Rule**:
   At all times, across every concurrent branch of execution:
   $$\sum \text{committed} + \sum \text{reserved} \le \text{limit}$$
   Any PR touching `reserve()`, `commit()`, `release()`, or Lua scripts must prove this invariant holds under race conditions.

2. **Lua Atomicity**:
   All Redis state transitions live in `src/redis/lua.ts`. We deliberately do NOT use distributed locks (Redlock) or multi-command `GET`/`SET` pipelines in Node. If a state change involves check-then-act logic, it must execute inside a Lua script.

3. **Fail-Closed Semantics**:
   When Redis disconnects, times out, or throws an unhandled error, Cappd must fail closed (`CappdInfrastructureError`). It must never silently bypass budget limits.

4. **Zero Runtime Dependencies**:
   The core engine only depends on `ioredis`. Do not add heavy dependencies, frameworks, or vendor-specific SDKs (e.g. OpenAI, Anthropic, AWS) to `dependencies`.

---

## Pull Request Guidelines

1. **Branch naming**: Use standard prefixes:
   * `fix/description` for bug fixes
   * `feat/description` for new functionality
   * `docs/description` for documentation updates
   * `perf/description` for performance or Lua optimizations
2. **Commit conventions**: Use Conventional Commits (`feat: ...`, `fix: ...`, `refactor: ...`, `test: ...`).
3. **Tests are required**: Every bug fix must include a regression test reproducing the failure. Every new store feature must include concurrent race-condition tests.
4. **CI Compliance**: PRs will only be merged if `npm run typecheck`, `npm test`, and `npm run build` pass in the GitHub Actions pipeline.

---

## Security Vulnerabilities

If you discover a security vulnerability or race condition that allows budget overspending, please do not file a public issue. See [SECURITY.md](SECURITY.md) for private disclosure instructions.
