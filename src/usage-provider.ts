import { CappdError, ResourceUsage, UsageProvider, UsageProviderFn, UsageResolver } from './types.js';

/**
 * Creates a UsageProvider instance from a function.
 */
export function createUsageProvider<TResult>(
  fn: UsageProviderFn<TResult>
): UsageProvider<TResult> {
  return {
    getUsage: (result: TResult) => fn(result),
  };
}

/**
 * UsageProvider that always reports a fixed, static resource usage.
 * Useful for operations with deterministic, constant costs (e.g. 1 API credit, fixed query fee).
 */
export class StaticUsageProvider implements UsageProvider<unknown> {
  constructor(private readonly usage: ResourceUsage) {
    if (usage.amount < 0) {
      throw new CappdError(`Static usage amount cannot be negative, got ${usage.amount}`);
    }
  }

  getUsage(): ResourceUsage {
    return { ...this.usage };
  }
}

/**
 * UsageProvider that extracts a ResourceUsage object from a specified property of the operation result.
 */
export class FieldUsageProvider<TResult extends Record<string, any>>
  implements UsageProvider<TResult>
{
  constructor(private readonly fieldName: keyof TResult = 'usage') {}

  getUsage(result: TResult): ResourceUsage {
    if (!result || typeof result !== 'object') {
      throw new CappdError(`Expected object result to extract usage, received ${typeof result}`);
    }

    const field = result[this.fieldName];
    if (
      !field ||
      typeof field !== 'object' ||
      typeof field.amount !== 'number' ||
      typeof field.unit !== 'string'
    ) {
      throw new CappdError(
        `Field "${String(this.fieldName)}" does not contain a valid ResourceUsage object ({ amount: number, unit: string })`
      );
    }

    return {
      amount: field.amount,
      unit: field.unit,
    };
  }
}

/**
 * Resolves actual resource usage using either a UsageProvider instance or a functional resolver.
 */
export async function resolveUsage<TResult>(
  resolver: UsageResolver<TResult>,
  result: TResult
): Promise<ResourceUsage> {
  if (typeof resolver === 'function') {
    return await resolver(result);
  }
  return await resolver.getUsage(result);
}
