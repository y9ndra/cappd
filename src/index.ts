// Primary Client Facade
export { Cappd, createCappd } from './cappd.js';
export type { CappdOptions, ExecuteOptions } from './cappd.js';

// Low-Level Functional Executor (Advanced API)
export { withReservation } from './executor.js';
export type { ExecuteWithReservationOptions, ExecutionResult } from './executor.js';

// Storage Contract & Implementations
export type { ResourceStore } from './store.js';
export { MemoryStore } from './memory-store.js';
export { RedisStore } from './redis-store.js';
export type { RedisStoreOptions } from './redis-store.js';

// Usage Measurement & Providers
export {
  createUsageProvider,
  StaticUsageProvider,
  FieldUsageProvider,
} from './usage-provider.js';
export type {
  UsageProvider,
  UsageProviderFn,
  UsageResolver,
} from './types.js';

// Express Middleware Adapter
export { protectRoute } from './express.js';
export type { ExpressProtectionOptions, ProtectedHandler } from './express.js';

// Domain Models & Accounting Records
export type {
  ResourceUsage,
  ReservationStatus,
  Reservation,
  Budget,
  BudgetState,
} from './types.js';

// Error Hierarchy
export {
  CappdError,
  BudgetExceededError,
  ReservationNotFoundError,
  InvalidReservationStateError,
  UsageMeasurementError,
  CappdInfrastructureError,
} from './types.js';
