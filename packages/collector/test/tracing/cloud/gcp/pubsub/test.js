'use strict';

const path = require('path');
const { expect } = require('chai');
const { fail } = expect;
const semver = require('semver');

const constants = require('@instana/core').tracing.constants;
const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../../../core/test/config');
const { delay, expectExactlyOneMatching, retry, stringifyItems } = require('../../../../../../core/test/test_util');
const ProcessControls = require('../../../../test_util/ProcessControls');

const projectId = process.env.GCP_PROJECT;
// We use different topics/subscriptions per Node.js major version so tests on CI run independently of each other.
const defaultTopicName = `nodejs-test-topic-${semver.parse(process.version).major}`;
const defaultSubscriptionName = `nodejs-test-subscription-${semver.parse(process.version).major}`;

// This suite is skipped if no GCP project ID has been provided via GPC_PROJECT. It also requires to either have GCP
// default credentials to be configured, for example via GOOGLE_APPLICATION_CREDENTIALS, or (for CI) to get
// the credentials as a string from GOOGLE_APPLICATION_CREDENTIALS_CONTENT.
let mochaSuiteFn;

if (
  //
  !supportedVersion(process.versions.node) ||
  // Disable this suite if no GCP project has been supplied.
  !projectId ||
  // @google-cloud/pubsub@2.0.0 dropped support for Node.js 8
  (semver.lt(process.version, '10.0.0') && semver.gte(require('@google-cloud/pubsub/package.json').version, '2.0.0')) ||
  // Disable this suite on CI, as it is somewhat flaky.
  process.env.CI
) {
  mochaSuiteFn = describe.skip;
} else {
  mochaSuiteFn = describe;
}

const retryTime = config.getTestTimeout() * 2;

mochaSuiteFn('tracing/cloud/gcp/pubsub', function() {
  this.timeout(config.getTestTimeout() * 3);

  describe('tracing enabled, no suppression', function() {
    const agentControls = require('../../../../apps/agentStubControls');
    agentControls.registerTestHooks(retryTime);

    const topicName = defaultTopicName;
    const subscriptionName = defaultSubscriptionName;

    const publisherControls = new ProcessControls({
      appPath: path.join(__dirname, 'publisher'),
      port: 3216,
      agentControls,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);
    const subscriberControls = new ProcessControls({
      appPath: path.join(__dirname, 'subscriber'),
      agentControls,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);

    ['promise', 'callback'].forEach(apiVariant => {
      [false, 'publisher'].forEach(withError => {
        const mochaTestFn = apiVariant === 'callback' && withError === 'publisher' ? it.skip : it;

        // It's not clear how to trigger a non-sync error in the publisher, so we skip that combination.
        mochaTestFn(`must trace google cloud pubsub publish and subscribe (${apiVariant}, error: ${withError})`, () => {
          const apiPath = `/publish-${apiVariant}`;
          const queryParams = [withError ? `withError=${withError}` : null].filter(param => !!param).join('&');
          const apiPathWithQuery = queryParams ? `${apiPath}?${queryParams}` : `${apiPath}`;

          return publisherControls
            .sendRequest({
              method: 'POST',
              path: apiPathWithQuery,
              simple: withError !== 'publisher'
            })
            .then(response => verify(response, apiPath, withError));
        });
      });
    });

    function verify(response, apiPath, withError) {
      if (withError === 'publisher') {
        expect(response).to.equal('Data must be in the form of a Buffer.');
        return retry(() => {
          return agentControls.getSpans().then(spans => verifySpans(spans, apiPath, null, withError));
        }, retryTime);
      } else {
        return retry(() => {
          const messageId = verifyResponseAndMessage(response, subscriberControls);
          return agentControls.getSpans().then(spans => verifySpans(spans, apiPath, messageId, withError));
        }, retryTime);
      }
    }

    function verifySpans(spans, apiPath, messageId, withError) {
      const httpEntry = verifyHttpEntry(spans, apiPath);
      const gcpsExit = verifyGoogleCloudPubSubExit(spans, httpEntry, messageId, withError);
      if (withError !== 'publisher') {
        verifyGoogleCloudPubSubEntry(spans, gcpsExit, messageId, withError);
      }
    }

    function verifyHttpEntry(spans, apiPath) {
      return expectExactlyOneMatching(spans, span => {
        expect(span.p).to.not.exist;
        expect(span.k).to.equal(constants.ENTRY);
        expect(span.f.e).to.equal(String(publisherControls.getPid()));
        expect(span.f.h).to.equal('agent-stub-uuid');
        expect(span.n).to.equal('node.http.server');
        expect(span.data.http.url).to.equal(apiPath);
      });
    }

    function verifyGoogleCloudPubSubExit(spans, parent, messageId, withError) {
      return expectExactlyOneMatching(spans, span => {
        expect(span.n).to.equal('gcps');
        expect(span.k).to.equal(constants.EXIT);
        expect(span.t).to.equal(parent.t);
        expect(span.p).to.equal(parent.s);
        expect(span.f.e).to.equal(String(publisherControls.getPid()));
        expect(span.f.h).to.equal('agent-stub-uuid');
        expect(span.error).to.not.exist;
        if (withError) {
          expect(span.ec).to.equal(1);
        } else {
          expect(span.ec).to.equal(0);
        }
        expect(span.async).to.not.exist;
        expect(span.data).to.exist;
        expect(span.data.gcps).to.be.an('object');
        expect(span.data.gcps.op).to.equal('publish');
        expect(span.data.gcps.projid).to.equal(projectId);
        expect(span.data.gcps.top).to.equal(topicName);
        if (withError === 'publisher') {
          expect(span.data.gcps.error).to.equal('Data must be in the form of a Buffer.');
        } else {
          expect(span.data.gcps.messageId).to.equal(messageId);
        }
      });
    }

    function verifyGoogleCloudPubSubEntry(spans, parent, messageId, withError) {
      return expectExactlyOneMatching(spans, span => {
        expect(span.n).to.equal('gcps');
        expect(span.k).to.equal(constants.ENTRY);
        expect(span.t).to.equal(parent.t);
        expect(span.p).to.equal(parent.s);
        expect(span.f.e).to.equal(String(subscriberControls.getPid()));
        expect(span.f.h).to.equal('agent-stub-uuid');
        expect(span.error).to.not.exist;
        if (withError) {
          expect(span.ec).to.equal(1);
        } else {
          expect(span.ec).to.equal(0);
        }
        expect(span.async).to.not.exist;
        expect(span.data).to.exist;
        expect(span.data.gcps).to.be.an('object');
        expect(span.data.gcps.op).to.equal('consume');
        expect(span.data.gcps.projid).to.equal(projectId);
        expect(span.data.gcps.sub).to.equal(subscriptionName);
        expect(span.data.gcps.messageId).to.equal(messageId);
      });
    }
  });

  describe('tracing enabled but suppressed', () => {
    const agentControls = require('../../../../apps/agentStubControls');
    agentControls.registerTestHooks(retryTime);

    const topicName = `${defaultTopicName}-suppression`;
    const subscriptionName = `${defaultSubscriptionName}-suppression`;

    const publisherControls = new ProcessControls({
      appPath: path.join(__dirname, 'publisher'),
      port: 3216,
      agentControls,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);
    const subscriberControls = new ProcessControls({
      appPath: path.join(__dirname, 'subscriber'),
      agentControls,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);

    it('should not trace when suppressed', () =>
      publisherControls
        .sendRequest({
          method: 'POST',
          path: '/publish-promise',
          headers: {
            'X-INSTANA-L': '0'
          }
        })
        .then(response => {
          return retry(() => verifyResponseAndMessage(response, subscriberControls), retryTime)
            .then(() => delay(config.getTestTimeout() / 4))
            .then(() => agentControls.getSpans())
            .then(spans => {
              if (spans.length > 0) {
                fail(`Unexpected spans (Google Cloud Run/suppressed: ${stringifyItems(spans)}`);
              }
            });
        }));
  });

  describe('tracing disabled', function() {
    const agentControls = require('../../../../apps/agentStubControls');
    this.timeout(config.getTestTimeout() * 2);
    agentControls.registerTestHooks(retryTime);

    const topicName = defaultTopicName;
    const subscriptionName = defaultSubscriptionName;

    const publisherControls = new ProcessControls({
      appPath: path.join(__dirname, 'publisher'),
      port: 3216,
      agentControls,
      tracingEnabled: false,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);
    const subscriberControls = new ProcessControls({
      appPath: path.join(__dirname, 'subscriber'),
      agentControls,
      tracingEnabled: false,
      env: {
        GCP_PROJECT: projectId,
        GCP_PUBSUB_TOPIC: topicName,
        GCP_PUBSUB_SUBSCRIPTION: subscriptionName
      }
    }).registerTestHooks(retryTime);

    it('should not trace when disabled', () =>
      publisherControls
        .sendRequest({
          method: 'POST',
          path: '/publish-promise'
        })
        .then(response => {
          return retry(() => verifyResponseAndMessage(response, subscriberControls), retryTime)
            .then(() => delay(config.getTestTimeout() / 4))
            .then(() => agentControls.getSpans())
            .then(spans => {
              if (spans.length > 0) {
                fail(`Unexpected spans (Google Cloud Run/suppressed: ${stringifyItems(spans)}`);
              }
            });
        }));
  });
});

function verifyResponseAndMessage(response, subscriberControls) {
  expect(response).to.be.an('object');
  const messageId = response.messageId;
  expect(messageId).to.be.a('string');
  const receivedMessages = subscriberControls.getIpcMessages();
  expect(receivedMessages).to.be.an('array');
  expect(receivedMessages).to.have.lengthOf.at.least(1);
  const message = receivedMessages.filter(({ id }) => id === messageId)[0];
  expect(message).to.exist;
  expect(message.content).to.equal('test message');
  return messageId;
}
