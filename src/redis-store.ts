import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { ResourceStore } from './store.js';
import {
  Budget,
  BudgetExceededError,
  BudgetState,
  CappdError,
  InvalidReservationStateError,
  Reservation,
  ReservationNotFoundError,
  ReservationStatus,
  ResourceUsage,
} from './types.js';
import { COMMIT_LUA, RELEASE_LUA, RESERVE_LUA, SET_BUDGET_LUA } from './redis/lua.js';

export interface RedisStoreOptions {
  /**
   * Redis connection URL (e.g. 'redis://localhost:6379').
   * If omitted, falls back to process.env.REDIS_URL, then 'redis://localhost:6379'.
   */
  url?: string;

  /**
   * Optional pre-configured ioredis Redis instance.
   */
  client?: Redis;

  /**
   * Namespace prefix for Redis keys (default: 'cappd').
   */
  keyPrefix?: string;
}

/**
 * Production-ready distributed implementation of ResourceStore backed by Redis.
 *
 * Employs atomic Lua scripts for reserve, commit, and release operations,
 * ensuring serializability and preserving the core invariant:
 *   committed + reserved <= limit
 * across multiple application processes and container replicas.
 */
export class RedisStore implements ResourceStore {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;
  private readonly prefix: string;

  constructor(options: RedisStoreOptions = {}) {
    this.prefix = options.keyPrefix ?? 'cappd';

    if (options.client) {
      this.redis = options.client;
      this.ownsClient = false;
    } else {
      const redisUrl = options.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.ownsClient = true;
    }
  }

  /**
   * Deterministic Redis key format helpers.
   */
  private budgetKey(key: string): string {
    return `${this.prefix}:budget:${key}`;
  }

  private reservationKey(id: string): string {
    return `${this.prefix}:reservation:${id}`;
  }

  /**
   * Initializes or updates a budget ceiling for a given key.
   */
  async setBudget(budget: Budget): Promise<void> {
    if (budget.limit < 0) {
      throw new CappdError(`Budget limit cannot be negative for key "${budget.key}"`);
    }

    const bKey = this.budgetKey(budget.key);
    await this.redis.eval(
      SET_BUDGET_LUA,
      1,
      bKey,
      budget.limit.toString(),
      budget.unit
    );
  }

  /**
   * Retrieves the current balance and accounting state of a budget.
   * Returns null if unconfigured.
   */
  async getBudget(key: string): Promise<BudgetState | null> {
    const bKey = this.budgetKey(key);
    const data = await this.redis.hmget(bKey, 'limit', 'unit', 'committed', 'reserved');

    const rawLimit = data[0];
    const unit = data[1];

    if (!rawLimit || !unit) {
      return null;
    }

    const limit = Number(rawLimit);
    const committed = Number(data[2] ?? 0);
    const reserved = Number(data[3] ?? 0);
    const available = Math.max(0, limit - committed - reserved);

    return {
      key,
      limit,
      unit,
      committed,
      reserved,
      available,
    };
  }

  /**
   * Atomically checks available capacity and reserves the requested usage via Lua.
   *
   * Invariant: committed + reserved + requested <= limit is verified
   * and mutated as one indivisible atomic unit inside the Redis engine.
   */
  async reserve(key: string, usage: ResourceUsage, ttlMs: number = 30000): Promise<Reservation> {
    if (usage.amount <= 0) {
      throw new CappdError(`Reservation amount must be greater than zero, got ${usage.amount}`);
    }

    const id = randomUUID();
    const now = Date.now();
    const bKey = this.budgetKey(key);
    const rKey = this.reservationKey(id);

    const result = (await this.redis.eval(
      RESERVE_LUA,
      2,
      bKey,
      rKey,
      id,
      key,
      usage.amount.toString(),
      usage.unit,
      ttlMs.toString(),
      now.toString()
    )) as string[];

    const status = result[0];

    if (status === 'ERR_BUDGET_NOT_FOUND') {
      throw new CappdError(`No budget configured for key "${key}"`);
    }

    if (status === 'ERR_UNIT_MISMATCH') {
      const expectedUnit = result[1];
      const receivedUnit = result[2];
      throw new CappdError(
        `Resource unit mismatch for key "${key}". Expected "${expectedUnit}", received "${receivedUnit}"`
      );
    }

    if (status === 'ERR_BUDGET_EXCEEDED') {
      const available = Number(result[1]);
      const unit = result[2] ?? usage.unit;
      throw new BudgetExceededError(key, usage.amount, available, unit);
    }

    if (status === 'OK') {
      const createdAt = Number(result[1]);
      const expiresAt = Number(result[2]);

      return {
        id,
        key,
        reserved: { amount: usage.amount, unit: usage.unit },
        status: 'reserved',
        createdAt,
        expiresAt,
      };
    }

    throw new CappdError(`Unexpected response from reserve Lua script: ${JSON.stringify(result)}`);
  }

  /**
   * Atomically reconciles an active reservation with actual measured usage:
   * - Subtracts original hold from budget.reserved
   * - Adds actual usage to budget.committed
   * - Transitions reservation status to 'committed'
   */
  async commit(reservationId: string, actualUsage: ResourceUsage): Promise<Reservation> {
    if (actualUsage.amount < 0) {
      throw new CappdError(`Committed actual usage cannot be negative, got ${actualUsage.amount}`);
    }

    const rKey = this.reservationKey(reservationId);
    const budgetKeyName = await this.redis.hget(rKey, 'key');

    if (!budgetKeyName) {
      throw new ReservationNotFoundError(reservationId);
    }

    const bKey = this.budgetKey(budgetKeyName);
    const now = Date.now();

    const result = (await this.redis.eval(
      COMMIT_LUA,
      2,
      rKey,
      bKey,
      actualUsage.amount.toString(),
      actualUsage.unit,
      now.toString()
    )) as string[];

    const status = result[0];

    if (status === 'ERR_RESERVATION_NOT_FOUND') {
      throw new ReservationNotFoundError(reservationId);
    }

    if (status === 'ERR_INVALID_STATE') {
      const currentStatus = result[1] as ReservationStatus;
      const attemptedAction = result[2] ?? 'commit';
      throw new InvalidReservationStateError(reservationId, currentStatus, attemptedAction);
    }

    if (status === 'ERR_UNIT_MISMATCH') {
      const expectedUnit = result[1];
      const receivedUnit = result[2];
      throw new CappdError(
        `Resource unit mismatch on commit. Expected "${expectedUnit}", received "${receivedUnit}"`
      );
    }

    if (status === 'ERR_OVERAGE') {
      const actual = result[1];
      const reserved = result[2];
      const unit = result[3];
      throw new CappdError(
        `Actual usage (${actual} ${unit}) exceeds reservation (${reserved} ${unit}) for reservation "${reservationId}"`
      );
    }

    if (status === 'ERR_BUDGET_NOT_FOUND') {
      throw new CappdError(`Budget for key "${budgetKeyName}" no longer exists`);
    }

    if (status === 'OK') {
      const createdAt = Number(result[1]);
      const expiresAt = Number(result[2]);
      const reservedAmount = Number(result[3]);
      const committedAmount = Number(result[4]);
      const unit = result[5] ?? actualUsage.unit;
      const key = result[6] ?? budgetKeyName;

      return {
        id: reservationId,
        key,
        reserved: { amount: reservedAmount, unit },
        status: 'committed',
        createdAt,
        expiresAt,
        committed: { amount: committedAmount, unit },
      };
    }

    throw new CappdError(`Unexpected response from commit Lua script: ${JSON.stringify(result)}`);
  }

  /**
   * Atomically cancels an active reservation and releases the entire held amount
   * back to the budget's available capacity.
   */
  async release(reservationId: string): Promise<Reservation> {
    const rKey = this.reservationKey(reservationId);
    const budgetKeyName = await this.redis.hget(rKey, 'key');

    if (!budgetKeyName) {
      throw new ReservationNotFoundError(reservationId);
    }

    const bKey = this.budgetKey(budgetKeyName);

    const result = (await this.redis.eval(
      RELEASE_LUA,
      2,
      rKey,
      bKey
    )) as string[];

    const status = result[0];

    if (status === 'ERR_RESERVATION_NOT_FOUND') {
      throw new ReservationNotFoundError(reservationId);
    }

    if (status === 'ERR_INVALID_STATE') {
      const currentStatus = result[1] as ReservationStatus;
      const attemptedAction = result[2] ?? 'release';
      throw new InvalidReservationStateError(reservationId, currentStatus, attemptedAction);
    }

    if (status === 'OK') {
      const createdAt = Number(result[1]);
      const expiresAt = Number(result[2]);
      const reservedAmount = Number(result[3]);
      const unit = result[4]!;
      const key = result[5] ?? budgetKeyName;

      return {
        id: reservationId,
        key,
        reserved: { amount: reservedAmount, unit },
        status: 'released',
        createdAt,
        expiresAt,
      };
    }

    throw new CappdError(`Unexpected response from release Lua script: ${JSON.stringify(result)}`);
  }

  /**
   * Retrieves a reservation by its unique ID.
   * Returns null if not found.
   */
  async getReservation(reservationId: string): Promise<Reservation | null> {
    const rKey = this.reservationKey(reservationId);
    const data = await this.redis.hgetall(rKey);

    if (!data || Object.keys(data).length === 0 || !data.id || !data.key) {
      return null;
    }

    const reservation: Reservation = {
      id: data.id,
      key: data.key,
      reserved: {
        amount: Number(data.reservedAmount),
        unit: data.unit ?? '',
      },
      status: data.status as ReservationStatus,
      createdAt: Number(data.createdAt),
      expiresAt: Number(data.expiresAt),
    };

    if (data.committedAmount !== undefined) {
      reservation.committed = {
        amount: Number(data.committedAmount),
        unit: data.unit ?? '',
      };
    }

    return reservation;
  }

  /**
   * Closes the underlying Redis connection if this instance created it.
   */
  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }

  /**
   * Access the underlying ioredis client instance.
   */
  get client(): Redis {
    return this.redis;
  }
}
