/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

const path = require('path');
const { expect } = require('chai');
const semver = require('semver');

const supportedVersion = require('@instana/core').tracing.supportedVersion;
const constants = require('@instana/core').tracing.constants;
const config = require('../../../../../core/test/config');
const { delay, expectExactlyOneMatching, retryUntilSpansMatch } = require('../../../../../core/test/test_util');
const ProcessControls = require('../../../test_util/ProcessControls');
const globalAgent = require('../../../globalAgent');

const agentControls = globalAgent.instance;

const allTestCases = require('./tracer_compliance_test_cases.json'); /* .slice(0, 1); */ // in lieu of .only

const testCasesWithW3cTraceCorrelation = [];
const testCasesWithoutW3cTraceCorrelation = [];
allTestCases.forEach(testDefinition => {
  if (testDefinition.INSTANA_DISABLE_W3C_TRACE_CORRELATION) {
    testCasesWithoutW3cTraceCorrelation.push(testDefinition);
  } else {
    testCasesWithW3cTraceCorrelation.push(testDefinition);
  }
});

const appPort = 3215;
const downstreamPort = 3216;

describe('spec compliance', function () {
  this.timeout(config.getTestTimeout());

  globalAgent.setUpCleanUpHooks();

  [false, true].forEach(http2 => {
    const mochaSuiteFn =
      supportedVersion(process.versions.node) && (!http2 || semver.gte(process.versions.node, '10.0.0'))
        ? describe
        : describe.skip;

    mochaSuiteFn(`compliance test suite (${http2 ? 'HTTP2' : 'HTTP1'})`, () => {
      const downstreamTarget = new ProcessControls({
        appPath: path.join(__dirname, 'downstreamTarget'),
        port: downstreamPort,
        useGlobalAgent: true,
        http2,
        env: {
          USE_HTTP2: http2
        }
      });
      before(() => downstreamTarget.start());
      after(() => downstreamTarget.stop());

      [false, true].forEach(w3cTraceCorrelationDisabled => {
        registerSuite(downstreamTarget, http2, w3cTraceCorrelationDisabled);
      });
    });
  });

  function registerSuite(downstreamTarget, http2, w3cTraceCorrelationDisabled) {
    describe(`compliance test suite (${http2 ? 'HTTP2' : 'HTTP1'})`, () => {
      const env = {
        USE_HTTP2: http2,
        DOWNSTREAM_PORT: downstreamPort
      };

      let testCases;
      if (w3cTraceCorrelationDisabled) {
        env.INSTANA_DISABLE_W3C_TRACE_CORRELATION = 'a non-empty string';
        testCases = testCasesWithoutW3cTraceCorrelation;
      } else {
        testCases = testCasesWithW3cTraceCorrelation;
      }

      const app = new ProcessControls({
        dirname: __dirname,
        port: appPort,
        useGlobalAgent: true,
        http2,
        env
      });
      ProcessControls.setUpHooks(app);

      testCases.forEach(testDefinition => {
        const label =
          `${testDefinition.index}: ${testDefinition['Scenario/incoming headers']} -> ` +
          `${testDefinition['What to do?']}`;
        it(label, async () => {
          const valuesForPlaceholders = {};
          const headers = {};
          [
            'X-INSTANA-T in',
            'X-INSTANA-S in',
            'X-INSTANA-L in',
            'X-INSTANA-SYNTHETIC in',
            'traceparent in',
            'tracestate in'
          ].forEach(headerName => {
            const actualHeaderName = headerName.slice(0, -3);
            const headerValue = testDefinition[headerName];
            if (headerValue) {
              headers[actualHeaderName] = headerValue;
              // eslint-disable-next-line no-console
              console.log(`setting ${actualHeaderName} to ${headerValue}`);
            } else {
              // eslint-disable-next-line no-console
              console.log(`not setting ${actualHeaderName}`);
            }
          });

          const suppressed = testDefinition['X-INSTANA-L in'] === '0';

          const request = {
            path: '/start',
            headers,
            resolveWithFullResponse: true
          };
          const response = await app.sendRequest(request);
          const expectedServerTimingValue = testDefinition['Server-Timing'];
          const actualServerTimingValue = response.headers['server-timing'];
          if (expectedServerTimingValue && expectedServerTimingValue.includes('$')) {
            expect(actualServerTimingValue).to.exist;
            parseForPlaceholders(valuesForPlaceholders, expectedServerTimingValue, actualServerTimingValue);
            expect(actualServerTimingValue).to.exist;
            if (!http2) {
              expect(response.rawHeaders).to.include('Server-Timing');
            }
          } else if (expectedServerTimingValue) {
            expect(actualServerTimingValue).to.equal(expectedServerTimingValue);
            if (!http2) {
              expect(response.rawHeaders).to.include('Server-Timing');
            }
          }

          let responseBody;
          if (typeof response.body === 'string') {
            responseBody = JSON.parse(response.body);
          } else if (typeof response.body === 'object') {
            responseBody = response.body;
          } else {
            throw new Error('Weird response?', response.body);
          }
          verifyHttpHeadersOnDownstreamRequest(testDefinition, valuesForPlaceholders, responseBody);

          if (suppressed) {
            await delay(500);
            const spans = await agentControls.getSpans();
            expect(spans).to.have.lengthOf(0);
          } else {
            await retryUntilSpansMatch(agentControls, spans => {
              verifyHttpEntry(testDefinition, valuesForPlaceholders, spans, '/start');
              verifyHttpExit(
                testDefinition,
                valuesForPlaceholders,
                spans,
                /^http(?:s)?:\/\/localhost:3216\/downstream$/
              );
            });
          }
        });
      });
    });
  }
});

function parseForPlaceholders(valuesForPlaceholders, template, value) {
  // I'm sorry, this is ugly and complicated. To ease the pain, let's follow along with an example. Assuming we have:
  // template = 00-0000000000000000$new_64_bit_trace_id-$new_span_id_2-01
  // value = 00-0000000000000000b9e374754ca092b9-de54a2e7e1ceffc4-01
  // Then we will get
  // placeholdersInString = [ '$new_64_bit_trace_id', '$new_span_id_2' ]
  const placeholdersInString = template.match(/(\$[a-z0-9_]*)/g);

  // Now escape "$" characters so we they are used as literals in the regex:
  // escapedPlaceholdersInString = [ '\\$new_64_bit_trace_id', '\\$new_span_id_2' ]
  const escapedPlaceholdersInString = placeholdersInString.map(tpl => tpl.replace('$', '\\$'));
  const placeholderPattern = `^(.*)${escapedPlaceholdersInString.join('(.*)')}(.*)$`;
  const placeholderRegex = new RegExp(placeholderPattern);
  let fixedLiteralsMatchResult = placeholderRegex.exec(template);
  if (!fixedLiteralsMatchResult) {
    throw new Error(`No placeholder match result ${template}.`);
  }
  // fixedLiteralsMatchResult = [ '00-0000000000000000', '-', '-01' ]
  fixedLiteralsMatchResult = fixedLiteralsMatchResult.slice(1);

  // valuesPattern = '^00-0000000000000000(.*)-(.*)-01$'
  const valuesPattern = `^${fixedLiteralsMatchResult.join('(.*)')}$`;
  const valuesRegex = new RegExp(valuesPattern);
  let valuesMatchResult = valuesRegex.exec(value);
  if (!valuesMatchResult) {
    throw new Error(`I could not match the value ${value} against the template ${template}.`);
  }
  // valuesMatchResult = [ '3124d02b3e5b1531', 'e16a9d4443b7e2d1' ]
  valuesMatchResult = valuesMatchResult.slice(1);

  for (let i = 0; i < placeholdersInString.length; i++) {
    const key = placeholdersInString[i];
    const existingValue = valuesForPlaceholders[key];
    const newValue = valuesMatchResult[i];
    if (existingValue) {
      expect(
        newValue,
        `The placeholder ${key} had the value ${existingValue} earlier but now it has the value ${newValue}. ` +
          'The same placeholders needs to always have the same value throughout one single test case.'
      ).to.equal(existingValue);
    } else {
      valuesForPlaceholders[placeholdersInString[i]] = newValue;
    }
  }

  // valuesForPlaceholders = {
  //   '$new_64_bit_trace_id': '3124d02b3e5b1531',
  //   '$new_span_id_2': 'e16a9d4443b7e2d1'
  // }
}

function verifyHttpEntry(testDefinition, valuesForPlaceholders, spans, url) {
  const expectations = [
    span => expect(span.n).to.equal('node.http.server'),
    span => expect(span.k).to.equal(constants.ENTRY),
    span => expect(span.ec).to.equal(0),
    span => expect(span.t).to.be.a('string'),
    span => expect(span.s).to.be.a('string'),
    span => expect(span.data.http.method).to.equal('GET'),
    span => expect(span.data.http.url).to.equal(url),
    span => expect(span.data.http.host).to.equal(`localhost:${appPort}`),
    span => expect(span.data.http.status).to.equal(200)
  ];

  [
    'entrySpan.t',
    'entrySpan.p',
    'entrySpan.s',
    'entrySpan.ia',
    'entrySpan.tp',
    'entrySpan.lt',
    'entrySpan.crid',
    'entrySpan.crtp',
    'entrySpan.sy'
  ].forEach(definitionAttribute => {
    const spanAttribute = definitionAttribute.substring(definitionAttribute.indexOf('.') + 1);
    addExpectation(expectations, testDefinition, valuesForPlaceholders, definitionAttribute, spanAttribute);
  });

  // span.fp is no longer supported
  expectations.push(span => expect(span.fp).to.not.exist);

  return expectExactlyOneMatching(spans, expectations);
}

function verifyHttpExit(testDefinition, valuesForPlaceholders, spans, url) {
  const expectations = [
    span => expect(span.n).to.equal('node.http.client'),
    span => expect(span.k).to.equal(constants.EXIT),
    span => expect(span.ec).to.equal(0),
    span => expect(span.t).to.be.a('string'),
    span => expect(span.s).to.be.a('string'),
    span => expect(span.data.http.method).to.equal('GET'),
    span => expect(span.data.http.url).to.match(url),
    span => expect(span.data.http.status).to.equal(200),
    span => expect(span.fp).to.not.exist
  ];
  [
    'exitSpan.t',
    'exitSpan.p',
    'exitSpan.s',
    'exitSpan.ia',
    'exitSpan.tp',
    'exitSpan.lt',
    'exitSpan.crid',
    'exitSpan.crtp',
    'exitSpan.sy'
  ].forEach(definitionAttribute => {
    const spanAttribute = definitionAttribute.substring(definitionAttribute.indexOf('.') + 1);
    addExpectation(expectations, testDefinition, definitionAttribute, spanAttribute);
  });

  return expectExactlyOneMatching(spans, expectations);
}

function addExpectation(expectations, testDefinition, valuesForPlaceholders, definitionAttribute, spanAttribute) {
  const expectedValue = testDefinition[definitionAttribute];
  const msg = `value for span attribute ${spanAttribute}`;
  if (expectedValue == null || expectedValue === '') {
    expectations.push(span => expect(span[spanAttribute], msg).to.not.exist);
  } else if (expectedValue && typeof expectedValue === 'object') {
    expectations.push(span =>
      expect(
        span[spanAttribute],
        `${msg}, actual: ${JSON.stringify(span[spanAttribute])} vs. expected ${JSON.stringify(expectedValue)}`
      ).to.deep.equal(expectedValue)
    );
  } else if (expectedValue === true) {
    expectations.push(span => expect(span[spanAttribute], msg).to.be.true);
  } else if (expectedValue === false) {
    expectations.push(span => expect(span[spanAttribute], msg).to.be.false);
  } else if (expectedValue && expectedValue.startsWith('$')) {
    expectations.push(span => {
      expect(span[spanAttribute], msg).to.exist;
      parseForPlaceholders(valuesForPlaceholders, expectedValue, span[spanAttribute]);
    });
  } else if (expectedValue) {
    expectations.push(span => expect(span[spanAttribute], msg).to.equal(expectedValue));
  } else {
    throw new Error(
      `Expected value for ${definitionAttribute} has an unexpected shape: ${expectedValue}. ` +
        'I cannot add an expectation for this.'
    );
  }
}

function verifyHttpHeadersOnDownstreamRequest(testDefinition, valuesForPlaceholders, responseBody) {
  [
    //
    'X-INSTANA-T out',
    'X-INSTANA-S out',
    'X-INSTANA-L out',
    'traceparent out',
    'tracestate out'
  ].forEach(headerName => {
    const actualHeaderName = headerName.slice(0, -4).toLowerCase();
    const actualValue = responseBody[actualHeaderName];
    const expectedHeaderValue = testDefinition[headerName];
    const msg = `value for outgoing HTTP header ${actualHeaderName} going downstream`;
    if (!expectedHeaderValue) {
      expect(actualValue, msg).to.not.exist;
    } else if (expectedHeaderValue.includes('$')) {
      expect(actualValue, msg).to.exist;
      parseForPlaceholders(valuesForPlaceholders, expectedHeaderValue, actualValue);
    } else {
      expect(actualValue, msg).to.equal(expectedHeaderValue);
    }
  });
}
