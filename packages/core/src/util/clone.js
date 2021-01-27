/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2015
 */

'use strict';

module.exports = function clone(x) {
  let r;
  if (x === null || x === undefined) {
    return x;
  }

  if (x.constructor === Array) {
    r = [];

    for (let i = 0, n = x.length; i < n; i++) {
      r[i] = clone(x[i]);
    }

    return r;
  }

  if (typeof x === 'object') {
    r = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const key in x) {
      // eslint-disable-next-line no-prototype-builtins
      if (x.hasOwnProperty(key)) {
        r[key] = clone(x[key]);
      }
    }

    return r;
  }

  return x;
};
