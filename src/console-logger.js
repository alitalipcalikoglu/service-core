const LEVELS = /** @type {const} */ ({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });

/**
 * Minimal structured console logger, same call shape as Fastify's pino logger
 * (`log.info(msg)` or `log.info(obj, msg)`, plus `child(bindings)`). For a process that builds no
 * Fastify instance and so has no pino logger to reuse — e.g. a worker-only entry point that never
 * opens an HTTP listener — but still needs something to pass to `Lifecycle.install`'s `log` and to
 * its own background loop. Stage 6, first adopted by notify/scheduler/webhook-out's `*-worker.js`.
 */
export class ConsoleLogger {
  /** @param {{ level?: keyof typeof LEVELS, bindings?: object }} [opts] */
  constructor({ level = 'info', bindings = {} } = {}) {
    this.level = level;
    this.bindings = bindings;
  }

  /** @param {keyof typeof LEVELS} level @param {[obj: object|string, msg?: string]} args */
  #log(level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const [a, b] = args;
    const extra = typeof a === 'string' ? {} : a;
    const msg = typeof a === 'string' ? a : b;
    const line = { level, time: Date.now(), ...this.bindings, ...extra, msg };
    (level === 'error' || level === 'fatal' ? console.error : console.log)(JSON.stringify(line));
  }

  /** @param {object|string} a @param {string} [b] */
  trace(a, b) { this.#log('trace', [a, b]); }
  /** @param {object|string} a @param {string} [b] */
  debug(a, b) { this.#log('debug', [a, b]); }
  /** @param {object|string} a @param {string} [b] */
  info(a, b) { this.#log('info', [a, b]); }
  /** @param {object|string} a @param {string} [b] */
  warn(a, b) { this.#log('warn', [a, b]); }
  /** @param {object|string} a @param {string} [b] */
  error(a, b) { this.#log('error', [a, b]); }
  /** @param {object|string} a @param {string} [b] */
  fatal(a, b) { this.#log('fatal', [a, b]); }
  /** @param {object} bindings */
  child(bindings) { return new ConsoleLogger({ level: this.level, bindings: { ...this.bindings, ...bindings } }); }
}
