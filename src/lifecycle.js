/**
 * Graceful shutdown, byte-identical in every service's `application.js` today: SIGTERM/SIGINT
 * trigger an ordered sequence of steps under a force-exit timer; `unhandledRejection` triggers the
 * same shutdown; `uncaughtException` exits immediately (no cleanup — the process state is already
 * suspect). `forceExitMs` and the `steps` array are supplied by the caller so each service's exact
 * current timeout and step order (worker before/after audit flush, extra per-service steps) are
 * reproduced unchanged — this module does not decide or fix that order.
 */
export class Lifecycle {
  /**
   * @param {object} o
   * @param {number} o.forceExitMs
   * @param {(() => (void|Promise<void>))[]} o.steps Run in order, each awaited; any throw aborts
   *   the remaining steps and is treated as a failed shutdown (exit 1).
   * @param {{ info: (o: object|string, m?: string) => void, error: (o: object|string, m?: string) => void, fatal: (o: object|string, m?: string) => void }} o.log
   * @returns {{ shutdown: (reason: string) => Promise<void> }}
   */
  static install({ forceExitMs, steps, log }) {
    let shuttingDown = false;

    /** @param {string} reason */
    async function shutdown(reason) {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ reason }, 'shutting down');
      const forceExit = setTimeout(() => {
        log.error('shutdown timed out, exiting');
        process.exit(1);
      }, forceExitMs).unref();
      try {
        for (const step of steps) await step();
        clearTimeout(forceExit);
        log.info('shutdown complete');
        process.exit(0);
      } catch (err) {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });

    return { shutdown };
  }
}
