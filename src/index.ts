import { error, info } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { EOL } from 'os';
import { exec } from '@actions/exec';
import { readActionConfig } from './read-action-config';
import { createPullRequest } from 'octokit-plugin-create-pull-request';
import { readFileSync } from 'fs';

const porcelain = require('@putout/git-status-porcelain');

/**
 * Trying to validate if action can correctly access `cargo`, `cargo-oudated` and `cargo-edit`.
 *
 * As long as cargo is installed, it'll try to install `cargo-outdated` and `cargo-edit` automatically.
 */
const checkCargoBinaries = async () => {
  const tryInstall = async (command: string, binary: string, version: string) => {
    try {
      let commandStdout = '';
      await exec('cargo', [command, '--version'], {
        listeners: {
          stdout: (data: Buffer) => (commandStdout += data.toString()),
        },
      });
      if (!commandStdout.includes(version)) {
        await exec('cargo', ['install', '--locked', '--force', `${binary}@${version}`]);
      }
    } catch (e) {
      await exec('cargo', ['install', '--locked', '--force', `${binary}@${version}`]);
    }
  };

  const cargoVersionResult = await exec('cargo', ['--version']);
  if (cargoVersionResult !== 0) {
    throw new Error(
      `Action could not able to execute cargo command. Please check if cargo is installed and available in PATH`
    );
  }

  await tryInstall('upgrade', 'cargo-edit', '0.11.6');
  await tryInstall('outdated', 'cargo-outdated', '0.11.1');

  // Check and throw directly. If this fails, we can't proceed as installation wasn't successful.
  await exec('cargo', ['upgrade', '--version']);
  await exec('cargo', ['outdated', '--version']);
};

/**
 * Run `cargo-outdated` against given pkg if specified, then parse its output to determine if there are any outdated dependencies.
 *
 * The way to determine outdated dependencies is straightforward by checking if there are any dependencies listed by returned output,
 * do not support other calculation mechanism yet such as semver, or compat property.
 */
const checkOutdated = async (pkg?: string) => {
  let outdatedResult = '';
  const options = pkg ? ['outdated', '-p', pkg, '--format=json'] : ['outdated', '--format=json'];
  const outdatedExitcode = await exec('cargo', options, {
    listeners: {
      stdout: (data: Buffer) => (outdatedResult += data.toString()),
    },
  });
  if (outdatedExitcode !== 0) {
    throw new Error(`Action could not able to check if package is outdated.`);
  }
  // cargo outdated can return multiple json under workspace
  const results: Array<{
    crate_name: string;
    dependencies: Array<{
      name: string;
      project: string;
      latest: string;
      compat: string;
    }>;
  }> = outdatedResult
    .split(EOL)
    .filter((x) => x)
    .map((x) => JSON.parse(x));

  // Check if `depdenencies` contains matching package name.
  const isOutdated = results.reduce((acc, result) => {
    if (result.dependencies.find((x) => x.name === pkg)) {
      return acc + 1;
    }
    return acc;
  }, 0);

  info(`checkOutdated: [${pkg}] is outdated: ${isOutdated}`);
  return isOutdated > 0;
};

/**
 * Run `cargo upgrade` against given pkg if specified. It only runs if there are any outdated dependencies.
 *
 * Returns true if upgrade performed, false otherwise.
 */
const runUpgrade = async (
  packages: Array<string>,
  upgradeAll: boolean,
  incompatible: boolean,
  mandatoryPackages: Array<string>
): Promise<boolean> => {
  const packagesToUpgrade: Array<string> = [];
  const upgrade = async (pkg?: string) => {
    const options = pkg ? ['upgrade', '-p', pkg, '--recursive', 'false'] : ['upgrade'];
    if (incompatible) {
      options.push('--incompatible');
    }
    await exec('cargo', options);
  };

  // run cargo upgrade
  if (upgradeAll) {
    info(`Trying to upgrade all packages in the manifest`);
    if (await checkOutdated()) {
      await upgrade();
      info(`Upgraded all packages in the manifest`);
    } else {
      info(`All packages are up to date`);
      return false;
    }
  } else {
    for (const pkg of packages) {
      const isOutdated = await checkOutdated(pkg);
      info(`Package [${pkg}] is outdated: ${isOutdated}`);
      if (isOutdated && !packagesToUpgrade.includes(pkg)) {
        packagesToUpgrade.push(pkg);
      }
    }

    info(`Found outdated packages: ${packagesToUpgrade}`);

    if (mandatoryPackages.length > 0) {
      const areAllPackagesReady = mandatoryPackages.every((pkg) => packagesToUpgrade.includes(pkg));
      if (!areAllPackagesReady) {
        info(`Not all mandatory packages are upgraded. Skipping PR creation`);
        info(`Mandatory packages: ${mandatoryPackages}`);
        return false;
      }
    }

    for (const pkg of packagesToUpgrade) {
      info(`Trying to upgrade package [${pkg}]`);
      await upgrade(pkg);
    }

    if (packagesToUpgrade.length === 0) {
      info(`No packages to upgrade`);
      return false;
    } else {
      info(`Upgraded packages: ${packagesToUpgrade}`);
    }
  }

  return true;
};

/**
 * Create a new, or update existing PR with latest changes for the upgrade.
 *
 * This currently brute-force refresh PR everytime it runs even though current commit's changes are same as new one.
 * However, will hold updates if user manually add new commits to the PR.
 */
const buildPullRequest = async (
  ghToken: string,
  branchName: string,
  prTitle: string,
  notifiedUsers?: Array<string>
) => {
  // Basic sanity check to update cargo.lock, but proceed if we can't.
  let checkOutput = '';
  let isCheckSuccess = true;
  try {
    await exec('cargo', ['check'], {
      listeners: {
        stdout: (data: Buffer) => (checkOutput += data.toString()),
        stderr: (data: Buffer) => (checkOutput += data.toString()),
      },
    });
  } catch (e) {
    isCheckSuccess = false;
  }

  const octokit = getOctokit(ghToken);

  // Get the lists of existing open PRs
  const currentOpenPullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    ...context.repo,
    state: 'open',
    per_page: 50,
  });

  // Try to find if there's a PR opened by this action by branch name
  const existingPR = currentOpenPullRequests.find((pr) => pr.head.ref === branchName);

  if (existingPR) {
    info(`Found existing PR #${existingPR.number} for branch ${branchName}, will try to update it`);
    const current = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: existingPR.number,
    });

    // Action will always create single commit, if there are other commits it should comes from user and won't update new one.
    // This is naive check, we'll may have better.
    if (current.data.commits > 1) {
      info(`PR #${existingPR.number} has more than 1 commit, will not update it`);
      return;
    }
  } else {
    info(`Trying to create a new PR for branch ${branchName}`);
  }

  // Find updated files.
  const updatedFiles: Array<string> =
    porcelain({
      untracked: true,
      // probably this won't happen, but just in case
      modified: true,
      added: true,
      deleted: true,
    }) ?? [];

  info(`Found updated files: ${updatedFiles}`);

  // Create a changeset for the commit. We may need to update existing PR with new commits,
  // so for the conviniences always create a single PR only.
  const changes: import('octokit-plugin-create-pull-request/dist-types/types').Changes = updatedFiles.reduce(
    (acc, file) => {
      if (acc.files) {
        acc.files[file] = ({ exists }) => {
          // do not create the file if it does not exist. We do not expect cargo update can create a new file.
          if (!exists) {
            info(`File ${file} does not exist, will not create it`);
            return null;
          }

          return readFileSync(file, 'utf-8');
        };
      }

      return acc;
    },
    {
      files: {},
      commit: 'build(cargo): update dependencies',
      emptyCommit: false,
    } as import('octokit-plugin-create-pull-request/dist-types/types').Changes
  );

  const basePRBody = `Hello! This is a friendly bot trying to update some of the dependencies in this repository.

  This PR is result of running bots for you.
  If there are new updates, this PR will try to replace existing commit with new ones.
  Unfortunately it cannot resolve conflicts, or resolve breaking changes automatically.
  If it happens, please try to resolve it manually.

  You can add new commits on top of this PR to do so. Then bot will not try to update PR and let you resolve it.

  ${
    (notifiedUsers?.length ?? 0) > 0
      ? `Bot could see there are some users may check on this PR, so mentioned in here: ${notifiedUsers?.map(
          (user) => `@${user}`
        )}`
      : ''
  }`;

  const prBody = isCheckSuccess
    ? basePRBody
    : `${basePRBody}

  It Looks like there were some errors while trying to upgrade dependencies. Please check below error message:

  \`\`\`
  ${checkOutput}
  \`\`\`
  `;

  const prResponse = await createPullRequest(octokit).createPullRequest({
    ...context.repo,
    title: prTitle,
    body: prBody,
    head: branchName,
    update: true,
    createWhenEmpty: false,
    changes,
  });

  if (prResponse) {
    info(`PR is available at ${prResponse.data.html_url}`);
  } else {
    error(`Failed to create a PR`);
  }
};

const main = async () => {
  const { packages, upgradeAll, incompatible, ghToken, branchName, prTitle, notifiedUsers, mandatoryPackages } =
    readActionConfig();

  await checkCargoBinaries();
  const shouldCreateUpgradePR = await runUpgrade(packages, upgradeAll, incompatible, mandatoryPackages);
  if (shouldCreateUpgradePR) {
    await buildPullRequest(ghToken, branchName, prTitle, notifiedUsers);
  }
};

main();
