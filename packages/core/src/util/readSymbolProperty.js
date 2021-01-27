/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

'use strict';

module.exports = exports = function readSymbolProperty(object, symbolString) {
  const symbol = Object.getOwnPropertySymbols(object).find(sym => sym && sym.toString() === symbolString);
  if (symbol) {
    return object[symbol];
  }
  return undefined;
};
