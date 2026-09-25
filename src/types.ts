/**
 * Represents a quantity and dimension of a resource.
 * Cappd is generic and does not care what the unit represents
 * (e.g. "tokens", "compute-ms", "credits", "queries").
 */
export interface ResourceUsage {
  amount: number;
  unit: string;
}

/**
 * The lifecycle states of a reservation.
 */
export type ReservationStatus = 'reserved' | 'committed' | 'released' | 'expired';

/**
 * Represents a temporary capacity hold against a budget.
 */
export interface Reservation {
  id: string;
  key: string;
  reserved: ResourceUsage;
  status: ReservationStatus;
  createdAt: number;
  expiresAt: number;
  committed?: ResourceUsage;
}

/**
 * Defines a resource budget ceiling for a specific key (e.g. tenant, user, or operation).
 */
export interface Budget {
  key: string;
  limit: number;
  unit: string;
}

/**
 * Represents the current real-time accounting balance of a budget.
 */
export interface BudgetState {
  key: string;
  limit: number;
  unit: string;
  committed: number;
  reserved: number;
  available: number;
}

/**
 * Base error class for all Cappd domain errors.
 */
export class CappdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CappdError';
  }
}

/**
 * Thrown when a reservation cannot be granted because the requested
 * capacity exceeds the available budget.
 */
export class BudgetExceededError extends CappdError {
  constructor(
    public readonly key: string,
    public readonly requested: number,
    public readonly available: number,
    public readonly unit: string
  ) {
    super(
      `Budget exceeded for key "${key}". Requested: ${requested} ${unit}, Available: ${available} ${unit}`
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Thrown when operating on a reservation ID that does not exist in the store.
 */
export class ReservationNotFoundError extends CappdError {
  constructor(public readonly reservationId: string) {
    super(`Reservation with ID "${reservationId}" was not found`);
    this.name = 'ReservationNotFoundError';
  }
}

/**
 * Thrown when attempting an invalid state transition
 * (e.g. trying to commit a reservation that was already committed, released, or expired).
 */
export class InvalidReservationStateError extends CappdError {
  constructor(
    public readonly reservationId: string,
    public readonly currentStatus: ReservationStatus,
    public readonly attemptedAction: string
  ) {
    super(
      `Cannot perform action "${attemptedAction}" on reservation "${reservationId}" because its status is "${currentStatus}"`
    );
    this.name = 'InvalidReservationStateError';
  }
}
