import { ExecutionResult, withReservation } from './executor.js';
import { MemoryStore } from './memory-store.js';
import { ResourceStore } from './store.js';
import {
  Budget,
  BudgetState,
  Reservation,
  ResourceUsage,
  UsageResolver,
} from './types.js';

export interface CappdOptions {
  /**
   * The storage backend managing budgets and reservations.
   * Defaults to an in-memory MemoryStore.
   */
  store?: ResourceStore;
}

export interface ExecuteOptions<TResult> {
  /**
   * The budget ceiling key (e.g. tenant, user, or organization ID).
   */
  key: string;

  /**
   * Estimated capacity to hold before executing the operation.
   */
  estimate: ResourceUsage;

  /**
   * Optional reservation time-to-live in milliseconds (default: 30000ms).
   */
  ttlMs?: number;

  /**
   * The protected operation to execute while holding reserved capacity.
   */
  operation: (reservation: Reservation) => Promise<TResult> | TResult;

  /**
   * UsageProvider or function to determine actual resource usage from the operation's return value.
   */
  usage: UsageResolver<TResult>;
}

/**
 * Main developer-facing client for Cappd.
 *
 * Provides a unified, ergonomic API for configuring resource budgets
 * and executing protected operations with automatic pre-reservation,
 * execution protection, usage measurement, and reconciliation.
 */
export class Cappd {
  private readonly _store: ResourceStore;

  constructor(options: CappdOptions = {}) {
    this._store = options.store ?? new MemoryStore();
  }

  /**
   * Access the underlying ResourceStore implementation.
   */
  get store(): ResourceStore {
    return this._store;
  }

  /**
   * Configures or updates a resource budget ceiling for a specific key.
   */
  async setBudget(budget: Budget): Promise<void> {
    return this._store.setBudget(budget);
  }

  /**
   * Retrieves the current balance and accounting state of a budget.
   * Returns null if unconfigured.
   */
  async getBudget(key: string): Promise<BudgetState | null> {
    return this._store.getBudget(key);
  }

  /**
   * Retrieves a reservation by unique ID.
   * Returns null if not found.
   */
  async getReservation(reservationId: string): Promise<Reservation | null> {
    return this._store.getReservation(reservationId);
  }

  /**
   * Executes a protected operation under the configured resource budget:
   * 1. Atomically reserves estimated capacity.
   * 2. Executes the protected operation.
   * 3. On operation failure: automatically releases the reservation.
   * 4. On operation success: measures actual usage from the result.
   * 5. On measurement failure: automatically releases the reservation.
   * 6. Reconciles: commits actual usage and refunds any unused capacity.
   *
   * @throws BudgetExceededError if available capacity is insufficient.
   * @throws UsageMeasurementError if the operation succeeded but usage measurement failed.
   * @throws CappdError if actual usage exceeds the estimate (overage guard).
   */
  async execute<TResult>(options: ExecuteOptions<TResult>): Promise<ExecutionResult<TResult>> {
    return withReservation({
      store: this._store,
      key: options.key,
      estimate: options.estimate,
      ttlMs: options.ttlMs,
      operation: options.operation,
      usageProvider: options.usage,
    });
  }
}

/**
 * Convenience factory to create a Cappd instance.
 */
export function createCappd(options?: CappdOptions): Cappd {
  return new Cappd(options);
}
