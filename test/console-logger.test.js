import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleLogger } from '../src/console-logger.js';

/** @param {() => void} fn */
function captureConsole(fn) {
  /** @type {string[]} */ const log = [];
  /** @type {string[]} */ const error = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (line) => log.push(line);
  console.error = (line) => error.push(line);
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { log, error };
}

test('ConsoleLogger: (obj, msg) and (msg) call shapes both produce one JSON line with msg', () => {
  const logger = new ConsoleLogger();
  const { log } = captureConsole(() => {
    logger.info({ a: 1 }, 'hello');
    logger.info('bare message');
  });
  assert.equal(log.length, 2);
  assert.deepEqual(JSON.parse(log[0]).a, 1);
  assert.equal(JSON.parse(log[0]).msg, 'hello');
  assert.equal(JSON.parse(log[1]).msg, 'bare message');
});

test('ConsoleLogger: level filters below it, error/fatal go to console.error', () => {
  const logger = new ConsoleLogger({ level: 'warn' });
  const { log, error } = captureConsole(() => {
    logger.debug('hidden');
    logger.info('hidden too');
    logger.warn('shown');
    logger.error('shown as error');
    logger.fatal('shown as fatal');
  });
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).msg, 'shown');
  assert.equal(error.length, 2);
  assert.deepEqual(error.map((l) => JSON.parse(l).msg), ['shown as error', 'shown as fatal']);
});

test('ConsoleLogger: child() merges bindings and inherits level, without mutating the parent', () => {
  const parent = new ConsoleLogger({ level: 'info', bindings: { service: 'x' } });
  const child = parent.child({ component: 'worker' });
  const { log } = captureConsole(() => {
    parent.info('from parent');
    child.info('from child');
  });
  assert.deepEqual(JSON.parse(log[0]), { level: 'info', time: JSON.parse(log[0]).time, service: 'x', msg: 'from parent' });
  assert.deepEqual(JSON.parse(log[1]), { level: 'info', time: JSON.parse(log[1]).time, service: 'x', component: 'worker', msg: 'from child' });
});
