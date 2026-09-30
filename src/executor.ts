import { ResourceStore } from './store.js';
import {
  CappdError,
  Reservation,
  ResourceUsage,
  UsageMeasurementError,
  UsageResolver,
} from './types.js';
import { resolveUsage } from './usage-provider.js';

export interface ExecuteWithReservationOptions<TResult> {
  /**
   * The storage backend managing budgets and reservations (MemoryStore or RedisStore).
   */
  store: ResourceStore;

  /**
   * The budget ceiling key (e.g. tenant, user, or organization ID).
   */
  key: string;

  /**
   * Estimated capacity to reserve before executing the operation.
   */
  estimate: ResourceUsage;

  /**
   * Optional time-to-live for the reservation in milliseconds.
   */
  ttlMs?: number;

  /**
   * The application operation to execute while holding reserved capacity.
   */
  operation: (reservation: Reservation) => Promise<TResult> | TResult;

  /**
   * UsageProvider or function to determine actual resource usage from the operation result.
   */
  usageProvider: UsageResolver<TResult>;
}

export interface ExecutionResult<TResult> {
  /**
   * The return value of the executed operation.
   */
  result: TResult;

  /**
   * The finalized, committed reservation.
   */
  reservation: Reservation;

  /**
   * The measured actual resource usage committed to the budget.
   */
  actualUsage: ResourceUsage;
}

/**
 * Orchestrates the complete resource reservation lifecycle:
 * 1. Pre-execution: Atomically reserves estimated capacity.
 * 2. Execution: Runs the operation holding the reservation.
 * 3. Failure Handling: If the operation throws, releases the reservation immediately.
 * 4. Measurement: Resolves actual resource usage using the provided UsageProvider.
 * 5. Measurement Failure: If measurement fails, releases reservation and throws UsageMeasurementError.
 * 6. Reconciliation: Commits actual usage, releasing any unused capacity back to the budget.
 *
 * @throws BudgetExceededError if remaining capacity is insufficient before execution.
 * @throws UsageMeasurementError if the operation succeeded but usage measurement failed.
 * @throws CappdError if actual usage exceeds the reserved estimate (overage guard).
 */
export async function withReservation<TResult>(
  options: ExecuteWithReservationOptions<TResult>
): Promise<ExecutionResult<TResult>> {
  const { store, key, estimate, ttlMs, operation, usageProvider } = options;

  // Step 1: Pre-execution capacity reservation
  const reservation = await store.reserve(key, estimate, ttlMs);

  // Step 2: Execute the protected operation
  let result: TResult;
  try {
    result = await operation(reservation);
  } catch (operationError) {
    // If the operation throws, release the hold so capacity is not leaked
    try {
      await store.release(reservation.id);
    } catch {
      // Suppress release error to ensure original operation error surfaces
    }
    throw operationError;
  }

  // Step 3: Measure actual usage from the operation result
  let actualUsage: ResourceUsage;
  try {
    actualUsage = await resolveUsage(usageProvider, result);

    if (
      !actualUsage ||
      typeof actualUsage.amount !== 'number' ||
      typeof actualUsage.unit !== 'string'
    ) {
      throw new CappdError(
        `UsageProvider returned invalid ResourceUsage: ${JSON.stringify(actualUsage)}`
      );
    }
  } catch (measurementError) {
    // If usage measurement fails, release reservation so it doesn't linger in store
    try {
      await store.release(reservation.id);
    } catch {
      // Suppress release error
    }
    throw new UsageMeasurementError(reservation.id, measurementError);
  }

  // Step 4: Reconcile actual usage with reservation
  const committedReservation = await store.commit(reservation.id, actualUsage);

  return {
    result,
    reservation: committedReservation,
    actualUsage,
  };
}
