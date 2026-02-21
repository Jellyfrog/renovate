import { isNonEmptyString, isString } from '@sindresorhus/is';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import {
  findLocalSiblingOrParent,
  readLocalFile,
} from '../../../util/fs/index.ts';
import { newlineRegex, regEx } from '../../../util/regex.ts';
import type { Upgrade } from '../types.ts';

export interface NpmrcResult {
  npmrc: string | undefined;
  npmrcFileName: string | null;
}

export async function resolveNpmrc(
  packageFile: string,
  config: { npmrc?: string; npmrcMerge?: boolean },
): Promise<NpmrcResult> {
  let npmrc: string | undefined;
  const npmrcFileName = await findLocalSiblingOrParent(packageFile, '.npmrc');
  if (npmrcFileName) {
    let repoNpmrc = await readLocalFile(npmrcFileName, 'utf8');
    if (isString(repoNpmrc)) {
      if (isString(config.npmrc) && !config.npmrcMerge) {
        logger.debug(
          { npmrcFileName },
          'Repo .npmrc file is ignored due to config.npmrc with config.npmrcMerge=false',
        );
        npmrc = config.npmrc;
      } else {
        npmrc = config.npmrc ?? '';
        if (npmrc.length) {
          if (!npmrc.endsWith('\n')) {
            npmrc += '\n';
          }
        }
        if (repoNpmrc?.includes('package-lock')) {
          logger.debug('Stripping package-lock setting from .npmrc');
          repoNpmrc = repoNpmrc.replace(
            regEx(/(^|\n)package-lock.*?(\n|$)/g),
            '\n',
          );
        }
        if (repoNpmrc.includes('=${') && !GlobalConfig.get('exposeAllEnv')) {
          logger.debug(
            { npmrcFileName },
            'Stripping .npmrc file of lines with variables',
          );
          repoNpmrc = repoNpmrc
            .split(newlineRegex)
            .filter((line) => !line.includes('=${'))
            .join('\n');
        }
        npmrc += repoNpmrc;
      }
    }
  } else if (isString(config.npmrc)) {
    npmrc = config.npmrc;
  }
  return { npmrc, npmrcFileName };
}

/**
 * Extracts registry URLs from upgrades and converts them to .npmrc registry lines.
 * Only scoped packages are supported, as npm doesn't support per-package registries
 * for unscoped packages.
 */
export function getRegistryNpmrcLines(upgrades: Upgrade[]): string[] {
  const seenScopes = new Set<string>();
  const lines: string[] = [];

  for (const upgrade of upgrades) {
    const registryUrl = upgrade.registryUrls?.[0];
    if (!isNonEmptyString(registryUrl) || !isNonEmptyString(upgrade.depName)) {
      continue;
    }

    if (!upgrade.depName.startsWith('@')) {
      continue;
    }

    const scope = upgrade.depName.split('/')[0];
    if (seenScopes.has(scope)) {
      continue;
    }
    seenScopes.add(scope);
    lines.push(`${scope}:registry=${registryUrl}`);
  }

  return lines;
}

export interface YarnrcNpmScopes {
  npmScopes: Record<string, { npmRegistryServer: string }>;
}

/**
 * Extracts registry URLs from upgrades and converts them to .yarnrc.yml
 * npmScopes entries for yarn v2+ (berry), which does not read scoped
 * registries from .npmrc.
 */
export function getRegistryYarnrcScopes(
  upgrades: Upgrade[],
): YarnrcNpmScopes | undefined {
  const scopes: Record<string, { npmRegistryServer: string }> = {};

  for (const upgrade of upgrades) {
    const registryUrl = upgrade.registryUrls?.[0];
    if (!isNonEmptyString(registryUrl) || !isNonEmptyString(upgrade.depName)) {
      continue;
    }

    if (!upgrade.depName.startsWith('@')) {
      continue;
    }

    // Strip the leading '@' from the scope
    const scope = upgrade.depName.split('/')[0].slice(1);
    if (scope in scopes) {
      continue;
    }
    scopes[scope] = { npmRegistryServer: registryUrl };
  }

  if (Object.keys(scopes).length === 0) {
    return undefined;
  }

  return { npmScopes: scopes };
}
