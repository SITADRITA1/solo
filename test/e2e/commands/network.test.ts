/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {after, before, describe, it} from 'mocha';
import {expect} from 'chai';

import {bootstrapTestVariables, getTmpDir, HEDERA_PLATFORM_VERSION_TAG} from '../../test_util.js';
import * as constants from '../../../src/core/constants.js';
import * as version from '../../../version.js';
import {sleep} from '../../../src/core/helpers.js';
import path from 'path';
import fs from 'fs';
import {NetworkCommand} from '../../../src/commands/network.js';
import {Flags as flags} from '../../../src/commands/flags.js';
import {Duration} from '../../../src/core/time/duration.js';
import {NamespaceName} from '../../../src/core/kube/resources/namespace/namespace_name.js';
import {PodName} from '../../../src/core/kube/resources/pod/pod_name.js';
import {PodRef} from '../../../src/core/kube/resources/pod/pod_ref.js';
import {type NetworkNodes} from '../../../src/core/network_nodes.js';
import {container} from 'tsyringe-neo';
import {InjectTokens} from '../../../src/core/dependency_injection/inject_tokens.js';
import {Argv} from '../../helpers/argv_wrapper.js';

describe('NetworkCommand', function networkCommand() {
  this.bail(true);
  const testName = 'network-cmd-e2e';
  const namespace = NamespaceName.of(testName);
  const applicationEnvFileContents = '# row 1\n# row 2\n# row 3';
  const applicationEnvParentDirectory = path.join(getTmpDir(), 'network-command-test');
  const applicationEnvFilePath = path.join(applicationEnvParentDirectory, 'application.env');
  const argv = Argv.getDefaultArgv(namespace);
  argv.setArg(flags.namespace, namespace.name);
  argv.setArg(flags.releaseTag, HEDERA_PLATFORM_VERSION_TAG);
  argv.setArg(flags.nodeAliasesUnparsed, 'node1');
  argv.setArg(flags.generateGossipKeys, true);
  argv.setArg(flags.generateTlsKeys, true);
  argv.setArg(flags.deployMinio, true);
  argv.setArg(flags.soloChartVersion, version.SOLO_CHART_VERSION);
  argv.setArg(flags.force, true);
  argv.setArg(flags.applicationEnv, applicationEnvFilePath);
  argv.setArg(flags.loadBalancerEnabled, true);
  argv.setArg(flags.chartDirectory, process.env.SOLO_CHARTS_DIR ?? undefined);
  argv.setArg(flags.quiet, true);

  const bootstrapResp = bootstrapTestVariables(testName, argv, {});
  const k8Factory = bootstrapResp.opts.k8Factory;
  const accountManager = bootstrapResp.opts.accountManager;
  const configManager = bootstrapResp.opts.configManager;

  const networkCmd = bootstrapResp.cmd.networkCmd;
  const clusterCmd = bootstrapResp.cmd.clusterCmd;
  const initCmd = bootstrapResp.cmd.initCmd;
  const nodeCmd = bootstrapResp.cmd.nodeCmd;
  const deploymentCmd = bootstrapResp.cmd.deploymentCmd;

  after(async function () {
    this.timeout(Duration.ofMinutes(3).toMillis());

    await container.resolve<NetworkNodes>(InjectTokens.NetworkNodes).getLogs(namespace);
    await k8Factory.default().namespaces().delete(namespace);
    await accountManager.close();
  });

  before(async () => {
    await k8Factory.default().namespaces().delete(namespace);
    await initCmd.init(argv.build());
    await clusterCmd.handlers.setup(argv.build());
    fs.mkdirSync(applicationEnvParentDirectory, {recursive: true});
    fs.writeFileSync(applicationEnvFilePath, applicationEnvFileContents);
  });

  it('deployment create should succeed', async () => {
    expect(await deploymentCmd.create(argv.build())).to.be.true;
    argv.setArg(flags.nodeAliasesUnparsed, undefined);
    configManager.reset();
    configManager.update(argv.build());
  });

  it('keys should be generated', async () => {
    expect(await nodeCmd.handlers.keys(argv.build())).to.be.true;
  });

  it('network deploy command should succeed', async () => {
    try {
      expect(await networkCmd.deploy(argv.build())).to.be.true;

      // check pod names should match expected values
      await expect(
        k8Factory
          .default()
          .pods()
          .read(PodRef.of(namespace, PodName.of('network-node1-0'))),
      ).eventually.to.have.nested.property('metadata.name', 'network-node1-0');
      // get list of pvc using k8 pvcs list function and print to log
      const pvcs = await k8Factory.default().pvcs().list(namespace, []);
      networkCmd.logger.showList('PVCs', pvcs);

      expect(networkCmd.getUnusedConfigs(NetworkCommand.DEPLOY_CONFIGS_NAME)).to.deep.equal([
        flags.apiPermissionProperties.constName,
        flags.applicationEnv.constName,
        flags.applicationProperties.constName,
        flags.bootstrapProperties.constName,
        flags.chainId.constName,
        flags.log4j2Xml.constName,
        flags.deployment.constName,
        flags.profileFile.constName,
        flags.profileName.constName,
        flags.quiet.constName,
        flags.settingTxt.constName,
        flags.grpcTlsKeyPath.constName,
        flags.grpcWebTlsKeyPath.constName,
        flags.gcsWriteAccessKey.constName,
        flags.gcsWriteSecrets.constName,
        flags.gcsEndpoint.constName,
        flags.awsWriteAccessKey.constName,
        flags.awsWriteSecrets.constName,
        flags.awsEndpoint.constName,
      ]);
    } catch (e) {
      networkCmd.logger.showUserError(e);
      expect.fail();
    }
  }).timeout(Duration.ofMinutes(4).toMillis());

  it('application env file contents should be in cached values file', () => {
    // @ts-ignore in order to access the private property
    const valuesYaml = fs.readFileSync(networkCmd.profileValuesFile).toString();
    const fileRows = applicationEnvFileContents.split('\n');
    for (const fileRow of fileRows) {
      expect(valuesYaml).to.contain(fileRow);
    }
  });

  it('network destroy should success', async () => {
    argv.setArg(flags.deletePvcs, true);
    argv.setArg(flags.deleteSecrets, true);
    argv.setArg(flags.force, true);
    configManager.update(argv.build());

    try {
      const destroyResult = await networkCmd.destroy(argv.build());
      expect(destroyResult).to.be.true;

      while ((await k8Factory.default().pods().list(namespace, ['solo.hedera.com/type=network-node'])).length > 0) {
        networkCmd.logger.debug('Pods are still running. Waiting...');
        await sleep(Duration.ofSeconds(3));
      }

      while ((await k8Factory.default().pods().list(namespace, ['app=minio'])).length > 0) {
        networkCmd.logger.showUser('Waiting for minio container to be deleted...');
        await sleep(Duration.ofSeconds(3));
      }

      // check if chart is uninstalled
      const chartInstalledStatus = await bootstrapResp.opts.chartManager.isChartInstalled(
        namespace,
        constants.SOLO_DEPLOYMENT_CHART,
      );
      expect(chartInstalledStatus).to.be.false;

      // check if pvc are deleted
      await expect(k8Factory.default().pvcs().list(namespace, [])).eventually.to.have.lengthOf(0);

      // check if secrets are deleted
      await expect(k8Factory.default().secrets().list(namespace)).eventually.to.have.lengthOf(0);
    } catch (e) {
      networkCmd.logger.showUserError(e);
      expect.fail();
    }
  }).timeout(Duration.ofMinutes(2).toMillis());
});
