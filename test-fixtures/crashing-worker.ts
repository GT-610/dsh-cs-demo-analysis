/** A worker that throws from its message handler, so the client sees a crash. */

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  throw new Error('boom');
});
