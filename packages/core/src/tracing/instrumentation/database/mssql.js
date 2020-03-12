'use strict';

var shimmer = require('shimmer');

var requireHook = require('../../../util/requireHook');
var tracingUtil = require('../../tracingUtil');
var constants = require('../../constants');
var cls = require('../../cls');

var isActive = false;

exports.init = function() {
  requireHook.onModuleLoad('mssql', instrumentMssql);
};

function instrumentMssql(mssql) {
  instrumentRequest(mssql.Request);
  instrumentPreparedStatement(mssql.PreparedStatement);
  instrumentTransaction(mssql.Transaction);
}

function instrumentRequest(Request) {
  shimmer.wrap(Request.prototype, 'query', shimMethod.bind(null, instrumentedRequestMethod));
  shimmer.wrap(Request.prototype, 'execute', shimMethod.bind(null, instrumentedRequestMethod));
  shimmer.wrap(Request.prototype, 'batch', shimMethod.bind(null, instrumentedRequestMethod));
  shimmer.wrap(Request.prototype, 'bulk', shimMethod.bind(null, instrumentedBulk));
}

function shimMethod(instrumentedFunction, originalFunction) {
  return function() {
    if (isActive && cls.isTracing()) {
      var originalArgs = new Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) {
        originalArgs[i] = arguments[i];
      }
      return instrumentedFunction(this, originalFunction, originalArgs);
    }
    return originalFunction.apply(this, arguments);
  };
}

function instrumentedRequestMethod(ctx, originalFunction, originalArgs) {
  return instrumentedMethod(ctx, originalFunction, originalArgs, instrumentedRequestMethod, function(args) {
    return args[0];
  });
}

function instrumentedBulk(ctx, originalFunction, originalArgs) {
  return instrumentedMethod(ctx, originalFunction, originalArgs, instrumentedBulk, function() {
    return 'MSSQL bulk operation';
  });
}

function instrumentedMethod(ctx, originalFunction, originalArgs, stackTraceRef, commandProvider) {
  var parentSpan = cls.getCurrentSpan();

  if (constants.isExitSpan(parentSpan)) {
    return originalFunction.apply(ctx, originalArgs);
  }

  var connectionParameters = findConnectionParameters(ctx);
  var command = commandProvider(originalArgs);
  return cls.ns.runAndReturn(function() {
    var span = cls.startSpan('mssql', constants.EXIT);
    span.stack = tracingUtil.getStackTrace(stackTraceRef);
    span.data.mssql = {
      stmt: tracingUtil.shortenDatabaseStatement(command),
      host: connectionParameters.host,
      port: connectionParameters.port,
      user: connectionParameters.user,
      db: connectionParameters.db
    };

    var originalCallback;
    if (originalArgs.length >= 2 && typeof originalArgs[1] === 'function') {
      originalCallback = originalArgs[1];
    }

    if (originalCallback) {
      // original call had a callback argument, replace it with our wrapper
      var wrappedCallback = function(error) {
        finishSpan(error, span);
        return originalCallback.apply(this, arguments);
      };
      originalArgs[1] = cls.ns.bind(wrappedCallback);
    }

    var promise = originalFunction.apply(ctx, originalArgs);
    if (typeof promise.then === 'function') {
      promise
        .then(function(value) {
          finishSpan(null, span);
          return value;
        })
        .catch(function(error) {
          finishSpan(error, span);
          return error;
        });
    }
    return promise;
  });
}

function instrumentPreparedStatement(PreparedStatement) {
  shimmer.wrap(PreparedStatement.prototype, 'prepare', shimPrepare);
  shimmer.wrap(PreparedStatement.prototype, 'execute', shimMethod.bind(null, instrumentedExecute));
}

function shimPrepare(originalFunction) {
  return function() {
    // Statements can be prepared globally at application startup, there is not necessarily any HTTP request active, so
    // we explicitly do not check for cls.isTracing() here.
    if (isActive) {
      var originalArgs = new Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) {
        originalArgs[i] = arguments[i];
      }
      if (originalArgs.length >= 2 && typeof originalArgs[1] === 'function') {
        originalArgs[1] = cls.ns.bind(originalArgs[1]);
      }
      // Attach the statement to the PreparedStatement object so that we can add it to the span when execute is called.
      this.__instanaStatement = originalArgs[0];
      return originalFunction.apply(this, originalArgs);
    }
    return originalFunction.apply(this, arguments);
  };
}

function instrumentedExecute(ctx, originalFunction, originalArgs) {
  return instrumentedMethod(ctx, originalFunction, originalArgs, instrumentedExecute, function() {
    return ctx.__instanaStatement;
  });
}

function instrumentTransaction(Transaction) {
  shimmer.wrap(Transaction.prototype, 'begin', shimBeginTransaction);
}

function shimBeginTransaction(originalFunction) {
  return function() {
    if (isActive && cls.isTracing()) {
      var originalArgs = new Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) {
        originalArgs[i] = arguments[i];
      }
      if (typeof originalArgs[1] === 'function') {
        originalArgs[1] = cls.ns.bind(originalArgs[1]);
      } else if (typeof originalArgs[0] === 'function') {
        originalArgs[0] = cls.ns.bind(originalArgs[0]);
      }
      return originalFunction.apply(this, originalArgs);
    }
    return originalFunction.apply(this, arguments);
  };
}

function finishSpan(error, span) {
  if (error) {
    span.ec = 1;
    span.data.mssql.error = tracingUtil.getErrorDetails(error);
  }

  span.d = Date.now() - span.ts;
  span.transmit();
}

function findConnectionParameters(ctx) {
  if (ctx.parent && ctx.parent.config && ctx.parent.config.server) {
    return {
      host: ctx.parent.config.server,
      port: ctx.parent.config.port,
      user: ctx.parent.config.user,
      db: ctx.parent.config.database
    };
  } else if (ctx.parent) {
    // search the tree of Request, Transaction, ... upwards recursively for a connection config
    return findConnectionParameters(ctx.parent);
  } else {
    // Fallback if we can't find the connection parameters.
    return {
      host: '',
      port: -1,
      user: '',
      db: ''
    };
  }
}

exports.activate = function() {
  isActive = true;
};

exports.deactivate = function() {
  isActive = false;
};
