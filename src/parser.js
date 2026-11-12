/** Main-thread client for the parsing worker: one request at a time, restartable. */

import { Worker } from 'node:worker_threads';
import { PARSE_TIMEOUT_MS } from './constants.js';

export class DemoParser {
  #worker;
  #pending = new Map();
  #sequence = 0;
  #failures = 0;
  #disposed = false;

  constructor({ workerUrl = new URL('./parse-worker.js', import.meta.url), timeoutMs = PARSE_TIMEOUT_MS } = {}) {
    this.workerUrl = workerUrl;
    this.timeoutMs = timeoutMs;
  }

  #ensure() {
    if (this.#disposed) throw new Error('the demo parser has been disposed');
    if (this.#worker !== undefined) return this.#worker;
    if (this.#failures >= 5) {
      throw new Error('the demo parser worker failed repeatedly; restart the app to try again');
    }
    const worker = new Worker(this.workerUrl);
    worker.on('message', (message) => this.#settle(message));
    worker.on('error', (error) => this.#fail(error));
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = undefined;
      if (code !== 0) this.#fail(new Error(`demo parser worker exited with code ${code}`));
    });
    this.#worker = worker;
    return worker;
  }

  #settle(message) {
    const entry = this.#pending.get(message.id);
    if (entry === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve({ data: message.data, elapsedMs: message.elapsedMs });
    } else {
      entry.reject(new Error(message.error));
    }
  }

  #fail(error) {
    this.#failures += 1;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) worker.terminate().catch(() => {});
  }

  /**
   * Run one parser operation.
   * @param {string} op - worker operation name.
   * @param {object} args - operation arguments (always include `path`).
   * @param {AbortSignal} [signal] - cooperative cancellation from the tool call.
   */
  call(op, args, signal) {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    const worker = this.#ensure();
    this.#sequence += 1;
    const id = this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`demo parsing timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const onAbort = () => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error('cancelled'));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener?.('abort', onAbort);
          this.#failures = 0;
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
        timer,
      });
      worker.postMessage({ id, op, args });
    });
  }

  async dispose() {
    this.#disposed = true;
    const worker = this.#worker;
    this.#worker = undefined;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('the demo parser was disposed'));
    }
    this.#pending.clear();
    if (worker !== undefined) await worker.terminate();
  }
}
