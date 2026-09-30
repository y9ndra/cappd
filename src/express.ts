import type { NextFunction, Request, Response } from 'express';
import { Cappd } from './cappd.js';
import {
  BudgetExceededError,
  CappdError,
  Reservation,
  ResourceUsage,
  UsageResolver,
} from './types.js';

export interface ExpressProtectionOptions<TResult> {
  /**
   * Resolves the budget key (e.g. tenant or user identifier) from the request or static string.
   */
  key: string | ((req: Request) => string | Promise<string>);

  /**
   * Resolves estimated capacity to reserve before executing the route handler.
   */
  estimate: ResourceUsage | ((req: Request) => ResourceUsage | Promise<ResourceUsage>);

  /**
   * Measures actual resource usage from the value returned by the route handler.
   */
  usage: UsageResolver<TResult>;

  /**
   * Optional reservation time-to-live in milliseconds.
   */
  ttlMs?: number;

  /**
   * Optional custom handler invoked when budget capacity is exceeded.
   * If omitted, defaults to sending HTTP 429 with JSON error details.
   */
  onBudgetExceeded?: (
    error: BudgetExceededError,
    req: Request,
    res: Response,
    next: NextFunction
  ) => void | Promise<void>;

  /**
   * HTTP status code for successful responses (default: 200).
   */
  successStatus?: number;

  /**
   * Optional custom response formatter called after usage is measured and committed.
   * If omitted, defaults to res.status(successStatus).json(result).
   */
  sendResponse?: (
    res: Response,
    result: TResult,
    actualUsage: ResourceUsage,
    reservation: Reservation
  ) => void;
}

export type ProtectedHandler<TResult> = (
  req: Request,
  res: Response
) => Promise<TResult> | TResult;

/**
 * Express route adapter that wraps a route handler with Cappd budget protection.
 *
 * Lifecycle & Execution Sequence:
 * 1. Checks available capacity and holds an atomic reservation before the handler runs.
 * 2. If the budget is exceeded, sends HTTP 429 (or calls onBudgetExceeded) without executing the handler.
 * 3. Executes the protected route handler.
 * 4. IMPORTANT: protectRoute() measures the handler's returned value BEFORE sending the HTTP response.
 *    - The return value of the handler is passed to the usage provider.
 *    - The actual usage is committed to the budget and any unused capacity is refunded.
 * 5. ONLY AFTER usage is successfully measured and reconciled is the HTTP response sent (e.g. res.status(200).json(result)).
 * 6. If the handler throws an error, the held reservation is automatically released immediately, and the error is forwarded to next(err).
 * 7. If usage measurement fails, the reservation is released and UsageMeasurementError is forwarded to next(err).
 */
export function protectRoute<TResult>(
  cappd: Cappd,
  options: ExpressProtectionOptions<TResult>,
  handler: ProtectedHandler<TResult>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Resolve key from request
      const key =
        typeof options.key === 'function' ? await options.key(req) : options.key;

      if (!key) {
        throw new CappdError('Budget key resolved to an empty or undefined identifier');
      }

      // 2. Resolve estimated usage
      const estimate =
        typeof options.estimate === 'function'
          ? await options.estimate(req)
          : options.estimate;

      // 3. Execute via Cappd: reserves hold -> executes handler -> measures return value -> commits
      const { result, actualUsage, reservation } = await cappd.execute({
        key,
        estimate,
        ttlMs: options.ttlMs,
        operation: async () => {
          return await handler(req, res);
        },
        usage: options.usage,
      });

      // 4. IMPORTANT: protectRoute() measures the handler's returned value BEFORE sending the HTTP response.
      // Now that measurement and reconciliation are complete, send the HTTP response if not already sent:
      if (!res.headersSent) {
        if (options.sendResponse) {
          options.sendResponse(res, result, actualUsage, reservation);
        } else {
          res.status(options.successStatus ?? 200).json(result);
        }
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        if (options.onBudgetExceeded) {
          await options.onBudgetExceeded(error, req, res, next);
          return;
        }

        res.status(429).json({
          error: 'BudgetExceededError',
          message: error.message,
          key: error.key,
          requested: error.requested,
          available: error.available,
          unit: error.unit,
        });
        return;
      }

      // Forward application errors or measurement errors to Express error handler
      next(error);
    }
  };
}
