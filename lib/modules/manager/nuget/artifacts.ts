import { quote } from 'shlex';
import upath from 'upath';
import { TEMPORARY_ERROR } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { exec } from '../../../util/exec';
import type { ExecOptions } from '../../../util/exec/types';
import {
  ensureDir,
  getLocalFiles,
  getSiblingFileName,
  outputCacheFile,
  privateCacheDir,
  writeLocalFile,
} from '../../../util/fs';
import { getFiles } from '../../../util/git';
import { regEx } from '../../../util/regex';
import type {
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types';
import { createNuGetConfigXml } from './config-formatter';
import {
  GLOBAL_JSON,
  MSBUILD_CENTRAL_FILE,
  NUGET_CENTRAL_FILE,
  getDependentPackageFiles,
} from './package-tree';
import {
  findGlobalJson,
  getConfiguredRegistries,
  getDefaultRegistries,
} from './util';

async function createCachedNuGetConfigFile(
  nugetCacheDir: string,
  packageFileName: string,
  additionalRegistryUrls: string[] = [],
): Promise<string> {
  const configuredRegistries =
    (await getConfiguredRegistries(packageFileName)) ?? getDefaultRegistries();

  // Combine configured/default registries with any additional registry URLs,
  // deduplicating by URL. additionalRegistryUrls are just URLs (strings),
  // so convert them to Registry-like objects when adding.
  const urlSet = new Set<string>();
  const combinedRegistries = [];

  for (const r of configuredRegistries) {
    if (r?.url && !urlSet.has(r.url)) {
      urlSet.add(r.url);
      combinedRegistries.push(r);
    }
  }

  for (const url of additionalRegistryUrls ?? []) {
    if (!url) continue;
    if (!urlSet.has(url)) {
      urlSet.add(url);
      // Minimal Registry-like object with just the url property.
      combinedRegistries.push({ url });
    }
  }

  const contents = createNuGetConfigXml(combinedRegistries);

  const cachedNugetConfigFile = upath.join(nugetCacheDir, `nuget.config`);
  await ensureDir(nugetCacheDir);
  await outputCacheFile(cachedNugetConfigFile, contents);

  return cachedNugetConfigFile;
}

async function runDotnetRestore(
  packageFileName: string,
  dependentPackageFileNames: string[],
  config: UpdateArtifactsConfig,
  additionalRegistryUrls: string[] = [],
): Promise<void> {
  const nugetCacheDir = upath.join(privateCacheDir(), 'nuget');

  const nugetConfigFile = await createCachedNuGetConfigFile(
    nugetCacheDir,
    packageFileName,
    additionalRegistryUrls,
  );

  const dotnetVersion =
    config.constraints?.dotnet ??
    (await findGlobalJson(packageFileName))?.sdk?.version;
  const execOptions: ExecOptions = {
    docker: {},
    extraEnv: {
      NUGET_PACKAGES: upath.join(nugetCacheDir, 'packages'),
      MSBUILDDISABLENODEREUSE: '1',
    },
    toolConstraints: [{ toolName: 'dotnet', constraint: dotnetVersion }],
  };

  const cmds = [
    ...dependentPackageFileNames.map(
      (fileName) =>
        `dotnet restore ${quote(
          fileName,
        )} --force-evaluate --configfile ${quote(nugetConfigFile)}`,
    ),
  ];

  if (config.postUpdateOptions?.includes('dotnetWorkloadRestore')) {
    cmds.unshift(
      `dotnet workload restore --configfile ${quote(nugetConfigFile)}`,
    );
  }

  await exec(cmds, execOptions);
}

export async function updateArtifacts({
  packageFileName,
  newPackageFileContent,
  config,
  updatedDeps,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`nuget.updateArtifacts(${packageFileName})`);

  // Collect and deduplicate registry URLs extracted from updatedDeps.
  const combinedRegistryUrls: string[] = Array.from(
    new Set((updatedDeps ?? []).flatMap((d) => d.registryUrls ?? [])),
  );

  // https://github.com/NuGet/Home/wiki/Centrally-managing-NuGet-package-versions
  // https://github.com/microsoft/MSBuildSdks/tree/main/src/CentralPackageVersions
  const isCentralManagement =
    packageFileName === NUGET_CENTRAL_FILE ||
    packageFileName === MSBUILD_CENTRAL_FILE ||
    packageFileName.endsWith(`/${NUGET_CENTRAL_FILE}`) ||
    packageFileName.endsWith(`/${MSBUILD_CENTRAL_FILE}`);

  const isGlobalJson = packageFileName === GLOBAL_JSON;

  if (
    !isCentralManagement &&
    !isGlobalJson &&
    !regEx(/(?:cs|vb|fs)proj$/i).test(packageFileName)
  ) {
    // This could be implemented in the future if necessary.
    // It's not that easy though because the questions which
    // project file to restore how to determine which lock files
    // have been changed in such cases.
    logger.debug(
      { packageFileName },
      'Not updating lock file for non project files',
    );
    return null;
  }

  const deps = await getDependentPackageFiles(
    packageFileName,
    isCentralManagement,
    isGlobalJson,
  );
  const packageFiles = deps.filter((d) => d.isLeaf).map((d) => d.name);

  logger.trace(
    { packageFiles },
    `Found ${packageFiles.length} dependent package files`,
  );

  const lockFileNames = deps.map((f) =>
    getSiblingFileName(f.name, 'packages.lock.json'),
  );

  const existingLockFileContentMap = await getFiles(lockFileNames);

  const hasLockFileContent = Object.values(existingLockFileContentMap).some(
    (val) => !!val,
  );
  if (!hasLockFileContent) {
    logger.debug(
      { packageFileName },
      'No lock file found for package or dependents',
    );
    return null;
  }

  try {
    if (updatedDeps.length === 0 && config.isLockFileMaintenance !== true) {
      logger.debug(
        `Not updating lock file because no deps changed and no lock file maintenance.`,
      );
      return null;
    }

    await writeLocalFile(packageFileName, newPackageFileContent);

    // Pass combinedRegistryUrls so the generated nuget.config includes both
    // configured/default registries and the extracted registry URLs.
    await runDotnetRestore(
      packageFileName,
      packageFiles,
      config,
      combinedRegistryUrls,
    );

    const newLockFileContentMap = await getLocalFiles(lockFileNames);

    const retArray: UpdateArtifactsResult[] = [];
    for (const lockFileName of lockFileNames) {
      if (
        existingLockFileContentMap[lockFileName] ===
        newLockFileContentMap[lockFileName]
      ) {
        logger.trace(`Lock file ${lockFileName} is unchanged`);
      } else if (newLockFileContentMap[lockFileName]) {
        retArray.push({
          file: {
            type: 'addition',
            path: lockFileName,
            contents: newLockFileContentMap[lockFileName],
          },
        });
      }
      // TODO: else should we return an artifact error if new content is missing?
    }

    return retArray.length > 0 ? retArray : null;
  } catch (err) {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err }, 'Failed to generate lock file');
    return [
      {
        artifactError: {
          lockFile: lockFileNames.join(', '),
          // error is written to stdout
          stderr: err.stdout ?? err.message,
        },
      },
    ];
  }
}
```
