/*
 * (c) Copyright IBM Corp. 2022
 */

'use strict';

const shimmer = require('shimmer');

let logger;
logger = require('../../../logger').getLogger('tracing/prisma', newLogger => {
  logger = newLogger;
});

const requireHook = require('../../../util/requireHook');
const { getErrorDetails, getStackTrace } = require('../../tracingUtil');
const { EXIT } = require('../../constants');
const cls = require('../../cls');

let isActive = false;

exports.init = function init() {
  requireHook.onModuleLoad('@prisma/client', instrumentPrismaClient);
};

function instrumentPrismaClient(prismaClientModule) {
  instrumentClientConstructor(prismaClientModule);
  shimRequest(prismaClientModule);
}

function instrumentClientConstructor(prismaClientModule) {
  // Additionally instrument the constructor to get access to database URL and type.
  if (typeof prismaClientModule.PrismaClient === 'function') {
    class InstanaPrismaClient extends prismaClientModule.PrismaClient {
      constructor() {
        super(...arguments);

        // Unfortunately, resolving the configuration is an asynchronous operation.
        // If the first model access happens in the same event loop iteration as creating the client, the span for that
        // Prisma operation will not have the provider or target URL available.
        if (this._engine && typeof this._engine.getConfig === 'function') {
          const configPromise = this._engine.getConfig();
          if (typeof configPromise.then === 'function') {
            configPromise.then(configResult => {
              if (!configResult || !Array.isArray(configResult.datasources)) {
                return;
              }
              const activeDatasource = configResult.datasources[0];
              if (!activeDatasource) {
                return;
              }

              // We attach the provider and destination URL to the Prisma client instance. That way, when multiple
              // Prisma client's are used, we do not confuse providers/database URLs
              this.__inProvider = activeDatasource.activeProvider;
              const dataSourceUrlObject = activeDatasource.url;
              if (dataSourceUrlObject && dataSourceUrlObject.value) {
                this.in_DataSourceUrl = redactPassword(activeDatasource.activeProvider, dataSourceUrlObject.value);
              } else if (dataSourceUrlObject && dataSourceUrlObject.fromEnvVar) {
                this.in_DataSourceUrl = redactPassword(
                  activeDatasource.activeProvider,
                  process.env[dataSourceUrlObject.fromEnvVar]
                );
              }
            });
          } else {
            logger.debug(
              'The operation getConfig did not yield a thenable, the database URL will not be captured on spans.'
            );
          }
        } else {
          logger.debug(
            'PrismaClient#_engine.getConfig does not exist, the database URL will not be captured on spans.'
          );
        }
      }
    }
    prismaClientModule.PrismaClient = InstanaPrismaClient;
  }
}

function shimRequest(prismaClientModule) {
  if (
    !prismaClientModule ||
    !prismaClientModule.PrismaClient ||
    !prismaClientModule.PrismaClient.prototype ||
    !prismaClientModule.PrismaClient.prototype._request
  ) {
    logger.debug('prismaClientModule.PrismaClient.prototype._request does not exist, will not instrument Prisma.');
    return;
  }

  // The relevant source file is:
  // https://github.com/prisma/prisma/blob/main/packages/client/src/runtime/getPrismaClient.ts
  shimmer.wrap(prismaClientModule.PrismaClient.prototype, '_request', instrumentRequest);
}

function instrumentRequest(original) {
  return function () {
    if (cls.skipExitTracing({ isActive })) {
      return original.apply(this, arguments);
    }

    const argsForOriginalRequest = new Array(arguments.length);
    for (let i = 0; i < arguments.length; i++) {
      argsForOriginalRequest[i] = arguments[i];
    }
    return instrumentedRequest(this, original, argsForOriginalRequest);
  };
}

function instrumentedRequest(ctx, originalRequest, argsForOriginalRequest) {
  return cls.ns.runAndReturn(() => {
    const span = cls.startSpan('prisma', EXIT);
    span.stack = getStackTrace(instrumentedRequest, 1);
    const params = argsForOriginalRequest[0] || {};
    span.data.prisma = {
      model: params.model,
      action: params.action,
      provider: ctx.__inProvider,
      url: ctx.in_DataSourceUrl
    };
    const requestPromise = originalRequest.apply(ctx, argsForOriginalRequest);
    if (!requestPromise && typeof requestPromise.then !== 'function') {
      span.cancel();
      return requestPromise;
    } else {
      return requestPromise
        .then(value => {
          finishSpan(null, span);
          return value;
        })
        .catch(error => {
          finishSpan(error, span);
          return error;
        });
    }
  });
}

function redactPassword(provider, url) {
  if (typeof provider !== 'string' || typeof url !== 'string' || 'sqlite' === provider.toLowerCase()) {
    return url;
  }

  const isKnownProvider = ['cockroachdb', 'mongodb', 'mysql', 'postgresql', 'sqlserver'].includes(
    provider.toLowerCase()
  );

  if (!isKnownProvider) {
    // Prisma might add new providers in the future and we cannot know how the connection URLs are structured. To err on
    // the side of caution, we do not capture the datasource URL for unknown providers. We do not want to risk capturing
    // the DB password inadvertently.
    return null;
  }

  if ('sqlserver' === provider.toLowerCase()) {
    return redactPasswordFromMsSQLUrl(url);
  }

  // Parse standard datasource URI (basically everything except for MsSQL).
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl != null) {
      parsedUrl.password = '_redacted_';
    }
    return parsedUrl.toString();
  } catch (e) {
    // Return null if we cannot parse the URL. We should rather not capture any URL at all than running the risk of
    // capturing the DB password inadvertently.
    return null;
  }
}

// exported for testing
exports._redactPassword = redactPassword;

function redactPasswordFromMsSQLUrl(url) {
  // MSSQL datasource URLs look like this:
  // sqlserver://hostname:9876;database=database_name;user=username;password=secret;encrypt=true
  const matchResult = /(.*;\s*password\s*=\s*)[^;]*(.*)/i.exec(url);
  if (!matchResult) {
    return null;
  }
  return `${matchResult[1]}_redacted_${matchResult[2]}`;
}

function finishSpan(error, span) {
  if (error) {
    span.ec = 1;
    span.data.prisma.error = getErrorDetails(error);
  }

  span.d = Date.now() - span.ts;
  span.transmit();
}

exports.activate = function activate() {
  isActive = true;
};

exports.deactivate = function deactivate() {
  isActive = false;
};
