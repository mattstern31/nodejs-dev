'use strict';

// load very early on to ensure that we use the non-instrumented HTTP APIs.
require('./http');

var log = require('./logger');
var path = require('path');
var fs = require('fs');

module.exports = function start(config) {
  config = config || {};

  log.init(config);
  require('./util/requireHook').init(config);
  require('./agent/opts').init(config);
  require('./actions/profiling/cpu').init(config);
  require('./tracing').init(config);

  var logger = log.getLogger('index');

  var currentState = null;

  var states = fs.readdirSync(path.join(__dirname, 'states'))
    // ignore tests
    .filter(function(moduleName) {
      return moduleName.indexOf('_test.js') === -1;
    })
    .reduce(function(stateModules, stateModuleName) {
      var stateName = stateModuleName.replace(/\.js$/i, '');
      stateModules[stateName] = require(path.join(__dirname, 'states', stateModuleName));
      return stateModules;
    }, {});

  var ctx = {
    transitionTo: function(newStateName) {
      logger.info('Transitioning from %s to %s', currentState || '<init>', newStateName);

      if (currentState) {
        states[currentState].leave(ctx);
      }
      currentState = newStateName;
      states[newStateName].enter(ctx);
    }
  };

  ctx.transitionTo('agentHostLookup');
};
