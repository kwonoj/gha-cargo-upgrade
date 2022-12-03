import { getInput, info } from '@actions/core';

interface UpdateActionConfig {
  packages: Array<string>;
  upgradeAll: boolean;
  branchName: string;
  notifiedUsers: Array<string>;
  manifestPath?: string;
  incompatible: boolean;
  ghToken: string;
  prTitle: string;
}

/**
 * Check gh action metadata and read necessary values
 */
const readActionConfig = (): UpdateActionConfig => {
  const rawPackages = getInput('packages', { required: true });
  info(`readActionConfig: packages are specified as [${rawPackages}]`);
  const branchName = getInput('branch_name');
  if (branchName) {
    info(`readActionConfig: branchName is specified as [${branchName}]`);
  } else {
    info(`readActionConfig: branchName is not specified, using default`);
  }
  const notifiedUsers = getInput('notified_users');
  if (notifiedUsers) {
    info(`readActionConfig: notifiedUsers are specified as [${notifiedUsers}]`);
  }

  const upgradeAll = rawPackages === "*";
  const packages = upgradeAll ? [] : rawPackages.split(',');

  const ret: UpdateActionConfig = {
    packages,
    upgradeAll,
    branchName: branchName || "__gha-cargo-upgrade-action",
    notifiedUsers: notifiedUsers ? notifiedUsers.split(',') : [],
    manifestPath: getInput('manifest_path'),
    incompatible: getInput('incompatible') === 'true',
    ghToken: getInput('token', { required: true }),
    // [TODO] This is not configurable for now
    prTitle: `[BOT] build(cargo): upgrade dependencies ${upgradeAll ? '' : `for ${rawPackages}`}`,
  }

  info(`readActionConfig: returning [${JSON.stringify(ret)}]`);
  return ret;
}

export {
  readActionConfig,
  UpdateActionConfig
}