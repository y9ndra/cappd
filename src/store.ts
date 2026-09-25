import { Budget, BudgetState, Reservation, ResourceUsage } from './types.js';

/**
 * Storage contract for managing resource budgets and reservation lifecycles.
 * Decouples the domain logic from the underlying storage mechanism
 * (e.g. MemoryStore in Stage 1, RedisStore in Stage 4).
 */
export interface ResourceStore {
  /**
   * Initializes or updates a budget for a given key.
   */
  setBudget(budget: Budget): Promise<void>;

  /**
   * Retrieves the current balance and accounting state of a budget.
   * Returns null if no budget has been configured for the key.
   */
  getBudget(key: string): Promise<BudgetState | null>;

  /**
   * Atomically checks available capacity and reserves the requested usage.
   * Throws BudgetExceededError if available < requested.amount.
   *
   * @param key The budget identifier (e.g. tenant or user)
   * @param usage The estimated resource usage to hold
   * @param ttlMs Time-to-live in milliseconds before reservation expires (default: 30000ms)
   */
  reserve(key: string, usage: ResourceUsage, ttlMs?: number): Promise<Reservation>;

  /**
   * Reconciles an active reservation with actual measured usage:
   * - Adds actual usage to budget.committed
   * - Subtracts the original hold from budget.reserved
   * - Transitions reservation status to 'committed'
   *
   * Throws ReservationNotFoundError if ID does not exist.
   * Throws InvalidReservationStateError if status is not 'reserved'.
   */
  commit(reservationId: string, actualUsage: ResourceUsage): Promise<Reservation>;

  /**
   * Cancels an active reservation and releases the entire held amount
   * back to the budget's available capacity.
   * Transitions reservation status to 'released'.
   *
   * Throws ReservationNotFoundError if ID does not exist.
   * Throws InvalidReservationStateError if status is not 'reserved'.
   */
  release(reservationId: string): Promise<Reservation>;

  /**
   * Retrieves a reservation by its unique ID.
   * Returns null if not found.
   */
  getReservation(reservationId: string): Promise<Reservation | null>;
}
