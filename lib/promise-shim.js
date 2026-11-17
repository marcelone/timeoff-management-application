'use strict';

/*
 * Transitional native-Promise compatibility shim.
 *
 * The legacy codebase was written against Bluebird. This module augments the
 * NATIVE Promise with the small subset of Bluebird APIs the code actually uses,
 * so we can drop the abandoned `bluebird` dependency without rewriting ~150
 * call sites at once. Because it augments the global Promise, promises returned
 * by Sequelize 6 (native) also gain the instance helpers (.map/.spread/...),
 * which the legacy chaining relies on.
 *
 * APIs provided:
 *   static:   Promise.try, Promise.join, Promise.map({concurrency}),
 *             Promise.promisify, Promise.promisifyAll
 *   instance: .map({concurrency}), .spread, .tap, .return/.thenReturn,
 *             .timeout, .catchReturn   (.finally is native)
 *
 * THIS IS A TRANSITIONAL BRIDGE. New code MUST use native async/await and
 * Promise.all. The shim is scheduled for removal once the legacy call sites are
 * refactored (see docs/MODERNIZATION_PLAN.md, "bluebird removal").
 */

const util = require('util');

function defineStatic(name, fn) {
  if (typeof Promise[name] !== 'function') {
    Object.defineProperty(Promise, name, { value: fn, writable: true, configurable: true });
  }
}
function defineProto(name, fn) {
  if (typeof Promise.prototype[name] !== 'function') {
    Object.defineProperty(Promise.prototype, name, { value: fn, writable: true, configurable: true });
  }
}

defineStatic('try', (fn) => Promise.resolve().then(() => fn()));

defineStatic('join', (...args) => {
  const fn = args.pop();
  return Promise.all(args).then((values) => fn(...values));
});

defineStatic('map', (items, mapper, opts = {}) => {
  const concurrency = opts.concurrency || Infinity;
  return Promise.resolve(items).then((input) => {
    const arr = Array.from(input);
    const results = new Array(arr.length);
    let index = 0;
    const workerCount = Math.max(0, Math.min(concurrency, arr.length));
    const workers = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        while (index < arr.length) {
          const i = index++;
          results[i] = await mapper(arr[i], i);
        }
      })());
    }
    return Promise.all(workers).then(() => results);
  });
});

defineStatic('promisify', util.promisify);

defineStatic('promisifyAll', (obj) => {
  for (const key of Object.keys(obj)) {
    const fn = obj[key];
    if (typeof fn === 'function' && typeof obj[`${key}Async`] !== 'function') {
      try { obj[`${key}Async`] = util.promisify(fn); } catch (e) { /* non-callback fn */ }
    }
  }
  return obj;
});

defineProto('map', function (mapper, opts) {
  return this.then((items) => Promise.map(items, mapper, opts));
});

defineProto('spread', function (fn) {
  return this.then((arr) => fn(...arr));
});

defineProto('tap', function (fn) {
  return this.then((value) => Promise.resolve(fn(value)).then(() => value));
});

defineProto('return', function (value) {
  return this.then(() => value);
});
defineProto('thenReturn', function (value) {
  return this.then(() => value);
});

defineProto('catchReturn', function (value) {
  return this.catch(() => value);
});

defineProto('timeout', function (ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || `operation timed out after ${ms}ms`)), ms);
    this.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
});

module.exports = Promise;
