/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2018
 */

/* eslint-env es6 */
/* eslint-disable */

// This is a copy of cls-hooked

// We are using a variation of cls-hooked, because we need to add additional cleanup logic.
// cls-hooked in its published version does not permit removal of values added to contexts.
// This is problematic for us in cases where sockets are long lived, e.g. http agents with
// maxSockets: Infinity. In such cases, the addition of the Node.js collector and the values it
// adds to async contexts (which are kept alive due to the living sockets), can tip a Node.js
// process over the edge.
//
// See also:
// https://github.com/Jeff-Lewis/cls-hooked/issues/21
// https://github.com/Jeff-Lewis/cls-hooked/issues/11

// Changes:
// - rename the symbols to avoid name clashes
// - have Namespace.prototype.set return a function which can be used to unset the value from the context
//   on which it was originally set.

// Copy of
// Jeff-Lewis, feat(compat): v4.2 for node v4.7-v8 (0ebfb9b  on Jul 21, 2017)
// https://github.com/Jeff-Lewis/cls-hooked/blob/066c6c4027a7924b06997cc6b175b1841342abdc/index.js

'use strict';

const semver = require('semver');

/**
 * In order to increase node version support, this loads the version of context
 * that is appropriate for the version of on nodejs that is running.
 * Node 12.17 - 16.6 - uses native AsyncLocalStorage. See below:
 * There is a bug introduced in Node 16.7 which breaks Async LS: https://github.com/nodejs/node/issues/40693
 * Node >= v8 - uses native async-hooks
 */
if (process && semver.satisfies(process.versions.node, '12.17 - 16.6')) {
  module.exports = require('./async_local_storage_context');
} else {
  module.exports = require('./context');
}
