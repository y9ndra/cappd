import { randomUUID } from 'node:crypto';
import { ResourceStore } from './store.js';
import {
  Budget,
  BudgetExceededError,
  BudgetState,
  CappdError,
  InvalidReservationStateError,
  Reservation,
  ReservationNotFoundError,
  ResourceUsage,
} from './types.js';

interface InternalBudgetRecord {
  limit: number;
  unit: string;
  committed: number;
  reserved: number;
}

/**
 * In-memory reference implementation of ResourceStore.
 *
 * Implements deterministic budgeting, reservations, and reconciliation
 * using in-memory JavaScript Maps.
 */
export class MemoryStore implements ResourceStore {
  private readonly budgets = new Map<string, InternalBudgetRecord>();
  private readonly reservations = new Map<string, Reservation>();

  async setBudget(budget: Budget): Promise<void> {
    if (budget.limit < 0) {
      throw new CappdError(`Budget limit cannot be negative for key "${budget.key}"`);
    }

    const existing = this.budgets.get(budget.key);
    if (existing) {
      existing.limit = budget.limit;
      existing.unit = budget.unit;
    } else {
      this.budgets.set(budget.key, {
        limit: budget.limit,
        unit: budget.unit,
        committed: 0,
        reserved: 0,
      });
    }
  }

  async getBudget(key: string): Promise<BudgetState | null> {
    const record = this.budgets.get(key);
    if (!record) {
      return null;
    }

    const available = Math.max(0, record.limit - record.committed - record.reserved);

    return {
      key,
      limit: record.limit,
      unit: record.unit,
      committed: record.committed,
      reserved: record.reserved,
      available,
    };
  }

  async reserve(key: string, usage: ResourceUsage, ttlMs: number = 30000): Promise<Reservation> {
    if (usage.amount <= 0) {
      throw new CappdError(`Reservation amount must be greater than zero, got ${usage.amount}`);
    }

    const budget = this.budgets.get(key);
    if (!budget) {
      throw new CappdError(`No budget configured for key "${key}"`);
    }

    if (usage.unit !== budget.unit) {
      throw new CappdError(
        `Resource unit mismatch for key "${key}". Expected "${budget.unit}", received "${usage.unit}"`
      );
    }

    // Fundamental Invariant Check: committed + reserved + requested <= limit
    const available = budget.limit - budget.committed - budget.reserved;
    if (usage.amount > available) {
      throw new BudgetExceededError(key, usage.amount, Math.max(0, available), budget.unit);
    }

    // Hold the capacity in budget.reserved
    budget.reserved += usage.amount;

    const now = Date.now();
    const reservation: Reservation = {
      id: randomUUID(),
      key,
      reserved: { amount: usage.amount, unit: usage.unit },
      status: 'reserved',
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    this.reservations.set(reservation.id, reservation);

    return { ...reservation };
  }

  async commit(reservationId: string, actualUsage: ResourceUsage): Promise<Reservation> {
    if (actualUsage.amount < 0) {
      throw new CappdError(`Committed actual usage cannot be negative, got ${actualUsage.amount}`);
    }

    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== 'reserved') {
      throw new InvalidReservationStateError(reservationId, reservation.status, 'commit');
    }

    if (actualUsage.unit !== reservation.reserved.unit) {
      throw new CappdError(
        `Resource unit mismatch on commit. Expected "${reservation.reserved.unit}", received "${actualUsage.unit}"`
      );
    }

    const budget = this.budgets.get(reservation.key);
    if (!budget) {
      throw new CappdError(`Budget for key "${reservation.key}" no longer exists`);
    }

    // Handle expiration if the reservation has timed out
    const now = Date.now();
    if (now > reservation.expiresAt) {
      reservation.status = 'expired';
      budget.reserved -= reservation.reserved.amount;
      throw new InvalidReservationStateError(reservationId, 'expired', 'commit');
    }

    // Reject if actual usage exceeds reservation (prevents unauthorized capacity consumption)
    if (actualUsage.amount > reservation.reserved.amount) {
      throw new CappdError(
        `Actual usage (${actualUsage.amount} ${actualUsage.unit}) exceeds reservation (${reservation.reserved.amount} ${reservation.reserved.unit}) for reservation "${reservationId}"`
      );
    }

    // Reconcile: Release the reserved hold and commit the actual usage
    budget.reserved -= reservation.reserved.amount;
    budget.committed += actualUsage.amount;

    reservation.status = 'committed';
    reservation.committed = { amount: actualUsage.amount, unit: actualUsage.unit };

    return { ...reservation };
  }

  async release(reservationId: string): Promise<Reservation> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== 'reserved') {
      throw new InvalidReservationStateError(reservationId, reservation.status, 'release');
    }

    const budget = this.budgets.get(reservation.key);
    if (budget) {
      budget.reserved -= reservation.reserved.amount;
    }

    reservation.status = 'released';

    return { ...reservation };
  }

  async getReservation(reservationId: string): Promise<Reservation | null> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return null;
    }
    return { ...reservation };
  }
}
