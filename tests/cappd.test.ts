import { describe, expect, it } from 'vitest';
import { Cappd, createCappd } from '../src/cappd.js';
import { MemoryStore } from '../src/memory-store.js';
import {
  BudgetExceededError,
  CappdError,
  UsageMeasurementError,
} from '../src/types.js';

describe('Cappd — Public API Client', () => {
  it('initializes with default in-memory store', async () => {
    const cappd = new Cappd();
    expect(cappd.store).toBeInstanceOf(MemoryStore);

    await cappd.setBudget({ key: 'user:1', limit: 5000, unit: 'tokens' });
    const budget = await cappd.getBudget('user:1');
    expect(budget?.available).toBe(5000);
  });

  it('createCappd factory creates an instance with custom store', async () => {
    const customStore = new MemoryStore();
    const cappd = createCappd({ store: customStore });
    expect(cappd.store).toBe(customStore);
  });

  it('executes operation, measures actual usage, and reconciles balance', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:acme', limit: 100000, unit: 'tokens' });

    let operationRan = false;

    const { result, actualUsage, reservation } = await cappd.execute({
      key: 'tenant:acme',
      estimate: { amount: 20000, unit: 'tokens' },
      operation: async () => {
        operationRan = true;
        return { reportTitle: 'Annual Analysis', tokens: 14000 };
      },
      usage: (res) => ({ amount: res.tokens, unit: 'tokens' }),
    });

    expect(operationRan).toBe(true);
    expect(result).toEqual({ reportTitle: 'Annual Analysis', tokens: 14000 });
    expect(actualUsage).toEqual({ amount: 14000, unit: 'tokens' });
    expect(reservation.status).toBe('committed');

    // 20k reserved hold removed, 14k committed -> 86k remaining available
    const budget = await cappd.getBudget('tenant:acme');
    expect(budget?.committed).toBe(14000);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(86000);
  });

  it('rejects execution and never runs operation when budget is exceeded', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:acme', limit: 10000, unit: 'tokens' });

    let operationRan = false;

    await expect(
      cappd.execute({
        key: 'tenant:acme',
        estimate: { amount: 25000, unit: 'tokens' },
        operation: async () => {
          operationRan = true;
        },
        usage: () => ({ amount: 10000, unit: 'tokens' }),
      })
    ).rejects.toThrow(BudgetExceededError);

    expect(operationRan).toBe(false);

    const budget = await cappd.getBudget('tenant:acme');
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(10000);
  });

  it('releases reservation hold when the protected operation fails', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:acme', limit: 50000, unit: 'tokens' });

    await expect(
      cappd.execute({
        key: 'tenant:acme',
        estimate: { amount: 20000, unit: 'tokens' },
        operation: async () => {
          throw new Error('AI Service Unreachable');
        },
        usage: () => ({ amount: 10000, unit: 'tokens' }),
      })
    ).rejects.toThrow('AI Service Unreachable');

    // Hold should be restored
    const budget = await cappd.getBudget('tenant:acme');
    expect(budget?.committed).toBe(0);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(50000);
  });

  it('releases reservation hold when usage measurement fails', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:acme', limit: 50000, unit: 'tokens' });

    await expect(
      cappd.execute({
        key: 'tenant:acme',
        estimate: { amount: 20000, unit: 'tokens' },
        operation: async () => ({ bad: 'output' }),
        usage: () => {
          throw new Error('Failed to parse tokens from stream');
        },
      })
    ).rejects.toThrow(UsageMeasurementError);

    const budget = await cappd.getBudget('tenant:acme');
    expect(budget?.committed).toBe(0);
    expect(budget?.reserved).toBe(0);
    expect(budget?.available).toBe(50000);
  });

  it('rejects commit when actual usage exceeds the reservation estimate', async () => {
    const cappd = new Cappd();
    await cappd.setBudget({ key: 'tenant:acme', limit: 50000, unit: 'tokens' });

    await expect(
      cappd.execute({
        key: 'tenant:acme',
        estimate: { amount: 20000, unit: 'tokens' },
        operation: async () => ({ tokens: 25000 }),
        usage: (res) => ({ amount: res.tokens, unit: 'tokens' }),
      })
    ).rejects.toThrow(CappdError);

    // Accounting remains unmutated
    const budget = await cappd.getBudget('tenant:acme');
    expect(budget?.committed).toBe(0);
    expect(budget?.reserved).toBe(20000);
    expect(budget?.available).toBe(30000);
  });
});
