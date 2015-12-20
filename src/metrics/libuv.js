'use strict';

var debug = require('debug')('instana-nodejs-sensor:metrics-libuv');

var eventLoopStats;
try {
  eventLoopStats = require('event-loop-stats');
} catch (e) {
  debug(
    'Could not load event-loop-stats. You will only see limited event loop information in ' +
    'Instana for this application. This typically occurs when native addons could not be ' +
    'installed during module installation (npm install). See the instructions to learn more ' +
    'about the requirements of the sensor: ' +
    'https://github.com/instana/nodejs-sensor/blob/master/README.md'
  );
}
var lag = require('event-loop-lag')(1000);

exports.payloadType = 'runtime';
exports.payloadPrefix = 'libuv';
exports.currentPayload = {};

Object.defineProperty(exports, 'currentPayload', {
  get: function() {
    var stats = sense();
    stats.lag = Math.round(lag() * 100) / 100;
    return stats;
  }
});

function sense() {
  if (eventLoopStats) {
    var stats = eventLoopStats.sense();
    stats.statsSupported = true;
  }
  return {
    statsSupported: false
  };
}

exports.activate = function() {};
exports.deactivate = function() {};
