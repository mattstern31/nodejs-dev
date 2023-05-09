/*
 * (c) Copyright IBM Corp. 2023
 */

'use strict';

const mock = require('mock-require');
const MONGOOSE_VERSION = process.env.MONGOOSE_VERSION;
const MONGOOSE_REQUIRE = process.env.MONGOOSE_VERSION === 'latest' ? 'mongoose' : `mongoose-${MONGOOSE_VERSION}`;

if (MONGOOSE_REQUIRE !== 'mongoose') {
  mock('mongoose', MONGOOSE_REQUIRE);
}
