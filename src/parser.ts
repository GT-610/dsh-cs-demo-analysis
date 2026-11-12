/** Main-thread client for the parsing worker: one request at a time, restartable. */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PARSE_TIMEOUT_MS } from './constants.ts';
import type { ParseArgs, ParseOperation, ParseRequest, ParseResult } from './worker-protocol.ts';
import { isParseResponse } from './worker-protocol.ts';

const WORKER_BASENAME = 'parse-worker';

/**
 * Resolve the worker entry that sits next to this module.
 *
 * The published build emits `parse-worker.js`; running the TypeScript sources
 * directly (tests, `node --test`) leaves `parse-worker.ts` beside them, which
 * Node executes through type stripping. Neither name is statically analyzable
 * on purpose: the worker is a separate build entry, not a bundle-time import,
 * and a literal path would make the bundler try to inline it.
 */
function resolveWorkerUrl(moduleUrl: string = import.meta.url): URL {
  for (const extension of ['js', 'ts']) {
    const candidate = new URL(`./${WORKER_BASENAME}.${extension}`, moduleUrl);
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return new URL(`./${WORKER_BASENAME}.js`, moduleUrl);
}

interface PendingEntry {
  resolve(value: { data: unknown; elapsedMs: number }): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class DemoParser {
  #worker: Worker | undefined;
  #pending = new Map<number, PendingEntry>();
  #sequence = 0;
  #failures = 0;
  #disposed = false;
  readonly workerUrl: URL;
  readonly timeoutMs: number;

  constructor({ workerUrl = resolveWorkerUrl(), timeoutMs = PARSE_TIMEOUT_MS }: { workerUrl?: URL; timeoutMs?: number } = {}) {
    this.workerUrl = workerUrl;
    this.timeoutMs = timeoutMs;
  }

  #ensure(): Worker {
    if (this.#disposed) throw new Error('the demo parser has been disposed');
    if (this.#worker !== undefined) return this.#worker;
    if (this.#failures >= 5) {
      throw new Error('the demo parser worker failed repeatedly; restart the app to try again');
    }
    const worker = new Worker(this.workerUrl);
    worker.on('message', (message: unknown) => this.#settle(message));
    worker.on('error', (error: Error) => this.#fail(error));
    worker.on('exit', (code: number) => {
      if (this.#worker === worker) this.#worker = undefined;
      if (code !== 0) this.#fail(new Error(`demo parser worker exited with code ${code}`));
    });
    this.#worker = worker;
    return worker;
  }

  #settle(message: unknown): void {
    if (!isParseResponse(message)) return;
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

  #fail(error: Error): void {
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
   *
   * The op/args pair is a discriminated union in {@link ParseRequest}, so a
   * misspelled operation or a mistyped argument name is a compile error rather
   * than an `undefined` the native parser silently accepts.
   */
  call<K extends ParseOperation>(op: K, args: ParseArgs[K], signal?: AbortSignal): Promise<ParseResult<K>> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    const worker = this.#ensure();
    this.#sequence += 1;
    const id = this.#sequence;
    return new Promise<ParseResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`demo parsing timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const onAbort = (): void => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          this.#failures = 0;
          resolve(value as ParseResult<K>);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      // `op` and `args` are correlated by the generic, which TypeScript keeps as
      // a single type parameter; the cast is what re-joins them into the union.
      worker.postMessage({ id, op, args } as ParseRequest);
    });
  }

  async dispose(): Promise<void> {
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
