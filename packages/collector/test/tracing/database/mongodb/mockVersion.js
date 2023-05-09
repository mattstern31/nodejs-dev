/*
 * (c) Copyright IBM Corp. 2023
 */

'use strict';

const mock = require('mock-require');
const requireHook = require('../../../../../core/src/util/requireHook');

const MONGODB_VERSION = process.env.MONGODB_VERSION;
const MONGODB_REQUIRE = process.env.MONGODB_VERSION === 'latest' ? 'mongodb' : `mongodb-${MONGODB_VERSION}`;

if (MONGODB_REQUIRE !== 'mongodb') {
  mock('mongodb', MONGODB_REQUIRE);
}

const originalOnFileLoad = requireHook.onFileLoad;
requireHook.onFileLoad = function onFileLoad() {
  if (
    arguments[0].source === '\\/mongodb\\/lib\\/cmap\\/connection\\.js' ||
    arguments[0].source === '\\/mongodb\\/lib\\/core\\/connection\\/pool\\.js'
  ) {
    const str = arguments[0].source.replace('mongodb', MONGODB_REQUIRE);
    const reg = new RegExp(str, '');
    arguments[0] = reg;
    return originalOnFileLoad.apply(this, arguments);
  }

  return originalOnFileLoad.apply(this, arguments);
};
