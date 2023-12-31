/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

'use strict';

const { DataProcessor } = require('@instana/metrics-util');

const { convert } = require('./dockerUtil');
const { dataForSecondaryContainer } = require('../container/containerUtil');

class SecondaryDockerProcessor extends DataProcessor {
  constructor(taskDataSource, taskStatsDataSource, dockerId, containerId) {
    super('com.instana.plugin.docker');
    this.addSource('task', taskDataSource);
    this.addSource('stats', taskStatsDataSource, false);
    this.dockerId = dockerId;
    this.entityId = containerId;
  }

  getEntityId() {
    return this.entityId;
  }

  processData(rawDataPerSource, previous, next) {
    const snapshotDataForThisContainer = dataForSecondaryContainer(rawDataPerSource.task, this.dockerId);
    const metricsForThisContainer = rawDataPerSource.stats ? rawDataPerSource.stats[this.dockerId] : {};
    return convert(snapshotDataForThisContainer, metricsForThisContainer, previous, next);
  }
}

module.exports = exports = SecondaryDockerProcessor;
