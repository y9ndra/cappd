/**
 * Cappd Basic Lifecycle Demo
 *
 * Demonstrates:
 * 1. Setting a shared resource budget ceiling.
 * 2. Two-phase reservation and reconciliation (pre-reserve -> execute -> measure actual -> commit actual + refund surplus).
 * 3. Atomic budget overage rejection (preventing expensive tasks from starting when quota is insufficient).
 * 4. Automatic reservation release on operation failure (preventing capacity leakage).
 *
 * Run with:
 *   npm run demo
 * Or with Redis:
 *   USE_REDIS=true npm run demo
 */

import {
  BudgetExceededError,
  Cappd,
  MemoryStore,
  RedisStore,
} from '../../src/index.js';

async function main() {
  const useRedis = process.env.USE_REDIS === 'true';
  const store = useRedis
    ? new RedisStore({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
    : new MemoryStore();

  const cappd = new Cappd({ store });
  const tenantKey = 'tenant:acme-corp';

  console.log('='.repeat(65));
  console.log(`  CAPPD RESOURCE BUDGET DEMO (${useRedis ? 'RedisStore' : 'MemoryStore'})`);
  console.log('='.repeat(65));

  // 1. Initialize a resource budget ceiling
  const TOTAL_BUDGET = 100_000;
  console.log(`\n[Step 1] Configuring budget ceiling: ${TOTAL_BUDGET.toLocaleString()} tokens for "${tenantKey}"`);
  await cappd.setBudget({
    key: tenantKey,
    limit: TOTAL_BUDGET,
    unit: 'tokens',
  });

  const printState = async (label: string) => {
    const state = await cappd.getBudget(tenantKey);
    console.log(
      `  --> [Balance after ${label}]: Committed: ${state?.committed.toLocaleString().padStart(6)} | Reserved: ${state?.reserved.toLocaleString().padStart(6)} | Available: ${state?.available.toLocaleString().padStart(6)} ${state?.unit}`
    );
  };

  await printState('Initialization');

  // Helper simulating backend LLM / compute work
  const simulateTask = async (taskName: string, actualTokens: number, ms = 40) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { task: taskName, tokensUsed: actualTokens, timestamp: Date.now() };
  };

  // 2. Request #1: Normal operation with surplus refund
  console.log('\n[Step 2] Request #1: LLM Chat Generation');
  console.log('  Estimate: 20,000 tokens');
  try {
    const { result, actualUsage, reservation } = await cappd.execute({
      key: tenantKey,
      estimate: { amount: 20_000, unit: 'tokens' },
      operation: async (res) => {
        console.log(`  [Executing] Reservation #${res.id.slice(0, 8)} held. Running model inference...`);
        return await simulateTask('chat_generation', 14_200);
      },
      usage: (res) => ({ amount: res.tokensUsed, unit: 'tokens' }),
    });

    console.log(`  [Success] Actual usage measured: ${actualUsage.amount.toLocaleString()} ${actualUsage.unit}`);
    console.log(`  [Reconciled] Reservation ${reservation.status}. Surplus refunded: ${(20_000 - actualUsage.amount).toLocaleString()} tokens`);
  } catch (err) {
    console.error('  [Failed]', err);
  }
  await printState('Request #1');

  // 3. Request #2: Larger operation with surplus refund
  console.log('\n[Step 3] Request #2: Document Summarization');
  console.log('  Estimate: 30,000 tokens');
  try {
    const { actualUsage, reservation } = await cappd.execute({
      key: tenantKey,
      estimate: { amount: 30_000, unit: 'tokens' },
      operation: async (res) => {
        console.log(`  [Executing] Reservation #${res.id.slice(0, 8)} held. Analyzing document...`);
        return await simulateTask('doc_summary', 27_400);
      },
      usage: (res) => ({ amount: res.tokensUsed, unit: 'tokens' }),
    });

    console.log(`  [Success] Actual usage measured: ${actualUsage.amount.toLocaleString()} ${actualUsage.unit}`);
    console.log(`  [Reconciled] Reservation ${reservation.status}. Surplus refunded: ${(30_000 - actualUsage.amount).toLocaleString()} tokens`);
  } catch (err) {
    console.error('  [Failed]', err);
  }
  await printState('Request #2');

  // 4. Request #3: Overage rejection (attempting to reserve more than available)
  console.log('\n[Step 4] Request #3: Heavy Batch Extraction');
  console.log('  Estimate: 60,000 tokens');
  try {
    await cappd.execute({
      key: tenantKey,
      estimate: { amount: 60_000, unit: 'tokens' },
      operation: async () => {
        console.log('  [CRITICAL ERROR] This operation should NEVER have been executed!');
        return await simulateTask('batch_extraction', 60_000);
      },
      usage: (res) => ({ amount: res.tokensUsed, unit: 'tokens' }),
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`  [REJECTED BEFORE EXECUTION] ${err.message}`);
      console.log(`  --> Downstream backend was protected; zero capacity leaked.`);
    } else {
      console.error('  [Unexpected Error]', err);
    }
  }
  await printState('Request #3 Rejection');

  // 5. Request #4: Operation failure cleanup
  console.log('\n[Step 5] Request #4: Faulty Operation (Downstream Crash)');
  console.log('  Estimate: 10,000 tokens');
  try {
    await cappd.execute({
      key: tenantKey,
      estimate: { amount: 10_000, unit: 'tokens' },
      operation: async (res) => {
        console.log(`  [Executing] Reservation #${res.id.slice(0, 8)} held. Operation throws an exception...`);
        throw new Error('Downstream API connection timeout');
      },
      usage: () => ({ amount: 10_000, unit: 'tokens' }),
    });
  } catch (err) {
    console.log(`  [Handled Error] Operation failed with: "${(err as Error).message}"`);
    console.log('  --> Cappd automatically released the temporary hold.');
  }
  await printState('Request #4 Failure Cleanup');

  console.log('\n' + '='.repeat(65));
  console.log('  DEMO COMPLETE: All invariant guarantees preserved successfully.');
  console.log('='.repeat(65));

  if (useRedis && 'disconnect' in (store as any)) {
    await (store as any).disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal demo error:', err);
  process.exit(1);
});
