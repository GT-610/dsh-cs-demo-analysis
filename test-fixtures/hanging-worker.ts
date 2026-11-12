/**
 * A worker that accepts requests and never answers.
 *
 * It stands in for a synchronous native parse that outlives the request which
 * started it: the worker is alive and idle, but the request will never be
 * settled by it.
 */

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  // Deliberately silent.
});
