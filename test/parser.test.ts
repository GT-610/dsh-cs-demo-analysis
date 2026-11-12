import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoParser } from '../src/parser.ts';

const HANGING_WORKER = new URL('../test-fixtures/hanging-worker.ts', import.meta.url);
const CRASHING_WORKER = new URL('../test-fixtures/crashing-worker.ts', import.meta.url);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a timed-out request retires its worker instead of queueing behind it', async () => {
  const parser = new DemoParser({ workerUrl: HANGING_WORKER, timeoutMs: 200 });
  try {
    const first = parser.call('header', { path: '/annoying/missing.dem' });
    await delay(20);
    // Queued on the same worker: it must be failed by the retirement, not left
    // waiting for its own timeout.
    const queued = assert.rejects(
      parser.call('header', { path: '/annoying/missing.dem' }),
      /worker was restarted/,
    );
    await assert.rejects(first, /timed out/);
    await queued;
  } finally {
    await parser.dispose();
  }
});

test('one crash counts one fault, so the restart budget is not spent twice', async () => {
  const parser = new DemoParser({ workerUrl: CRASHING_WORKER, timeoutMs: 10_000 });
  // The refusal is thrown synchronously by `call`, so the closure keeps every
  // attempt a promise for `assert.rejects`.
  const call = async (): Promise<void> => {
    await parser.call('header', { path: '/annoying/missing.dem' });
  };
  try {
    // Both the `error` and the following `exit` event belong to the same crash.
    // Counting them separately would exhaust the five-failure budget after
    // three crashes and refuse to restart early.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(call(), /boom/, `crash ${attempt}`);
    }
    await assert.rejects(call(), /failed repeatedly/);
  } finally {
    await parser.dispose();
  }
});
