## Description
<!-- Provide a clear, concise summary of the changes and the rationale. -->

## Related Issues
<!-- Link relevant issues: Fixes #123, Closes #456, or Relates to #789 -->
Closes #

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] Feature (non-breaking change adding functionality)
- [ ] Performance (optimizations or Redis Lua script tuning)
- [ ] Refactor (code structure improvement without behavioral changes)
- [ ] Documentation (updates to README, API references, or examples)
- [ ] Breaking change (modifies existing public API contracts or behaviors)

## Subsystems Affected
- [ ] Public API (`src/index.ts`, exported types and contracts)
- [ ] Core Engine (`src/engine/`)
- [ ] Storage Drivers (`MemoryStore`, `RedisStore`)
- [ ] Redis Lua Scripts (`src/redis/lua.ts`)
- [ ] Framework Adapters (`src/adapters/`)

## Verification and Testing
<!-- Detail how this change was validated. Include commands run or reproduction steps. -->
- [ ] Unit tests (`npm test`)
- [ ] Redis integration tests with live Redis instance
- [ ] Concurrency and race condition tests (`tests/concurrency.test.ts`)
- [ ] Edge cases and failure recovery verified

## Checklist
- [ ] Code adheres to the architectural rules in CONTRIBUTING.md
- [ ] Reservation invariant preserved: committed + reserved <= limit
- [ ] Strict type checking passes (`npm run typecheck`)
- [ ] Full test suite passes (`npm test`)
- [ ] Build succeeds with clean dual ESM/CJS bundles (`npm run build`)
- [ ] Tests added or updated covering the changes
- [ ] Documentation updated where relevant
- [ ] Commits follow Conventional Commits standard
