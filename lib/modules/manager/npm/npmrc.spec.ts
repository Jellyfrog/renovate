import { fs } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import type { Upgrade } from '../types.ts';
import {
  getRegistryNpmrcLines,
  getRegistryYarnrcScopes,
  resolveNpmrc,
} from './npmrc.ts';

vi.mock('../../../util/fs/index.ts');

describe('modules/manager/npm/npmrc', () => {
  describe('resolveNpmrc', () => {
    beforeEach(async () => {
      const realFs = await vi.importActual<typeof fs>('../../../util/fs');
      fs.readLocalFile.mockResolvedValue(null);
      fs.findLocalSiblingOrParent.mockResolvedValue(null);
      fs.getSiblingFileName.mockImplementation(realFs.getSiblingFileName);
    });

    it('returns undefined if no .npmrc exists and no config.npmrc', async () => {
      const res = await resolveNpmrc('package.json', {});
      expect(res).toStrictEqual({ npmrc: undefined, npmrcFileName: null });
    });

    it('uses config.npmrc if no .npmrc is found', async () => {
      const res = await resolveNpmrc('package.json', {
        npmrc: 'config-npmrc',
      });
      expect(res).toStrictEqual({ npmrc: 'config-npmrc', npmrcFileName: null });
    });

    it('finds and filters .npmrc', async () => {
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve('save-exact = true\npackage-lock = false\n');
        }
        return Promise.resolve(null);
      });
      const res = await resolveNpmrc('package.json', {});
      expect(res).toStrictEqual({
        npmrc: 'save-exact = true\n',
        npmrcFileName: '.npmrc',
      });
    });

    it('uses config.npmrc if .npmrc does exist but npmrcMerge=false', async () => {
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve('repo-npmrc\n');
        }
        return Promise.resolve(null);
      });
      const res = await resolveNpmrc('package.json', {
        npmrc: 'config-npmrc',
      });
      expect(res).toStrictEqual({
        npmrc: 'config-npmrc',
        npmrcFileName: '.npmrc',
      });
      expect(logger.debug).toHaveBeenCalledWith(
        { npmrcFileName: '.npmrc' },
        'Repo .npmrc file is ignored due to config.npmrc with config.npmrcMerge=false',
      );
    });

    it('uses config.npmrc if no .npmrc file is found', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('package.json');
      fs.findLocalSiblingOrParent.mockResolvedValueOnce(null);
      fs.readLocalFile.mockResolvedValueOnce(
        JSON.stringify({
          name: 'test',
          version: '0.0.1',
          dependencies: { dep1: '1.0.0' },
        }),
      );

      const res = await resolveNpmrc('package.json', {
        npmrc: 'config-npmrc',
      });
      expect(res.npmrc).toBe('config-npmrc');
    });

    it('merges config.npmrc and repo .npmrc when npmrcMerge=true', async () => {
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve('repo-npmrc\n');
        }
        return Promise.resolve(null);
      });
      const res = await resolveNpmrc('package.json', {
        npmrc: 'config-npmrc',
        npmrcMerge: true,
      });
      expect(res).toStrictEqual({
        npmrc: `config-npmrc\nrepo-npmrc\n`,
        npmrcFileName: '.npmrc',
      });
    });

    it('does not add a newline between config.npmrc and repo .npmrc when npmrcMerge is true, if a newline already exists', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('package.json');
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve('repo-setting=value\n');
        }
        if (fileName === 'package.json') {
          return Promise.resolve(
            JSON.stringify({
              name: 'test',
              version: '0.0.1',
              dependencies: { dep1: '1.0.0' },
            }),
          );
        }
        return Promise.resolve(null);
      });

      const res = await resolveNpmrc('package.json', {
        npmrc: 'config-setting=value\n',
        npmrcMerge: true,
      });
      expect(res.npmrc).toBe('config-setting=value\nrepo-setting=value\n');
    });

    it('finds and filters .npmrc with variables', async () => {
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve(
            'registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=${NPM_AUTH_TOKEN}\n',
          );
        }
        return Promise.resolve(null);
      });
      const res = await resolveNpmrc('package.json', {});
      expect(res).toStrictEqual({
        npmrc: 'registry=https://registry.npmjs.org\n',
        npmrcFileName: '.npmrc',
      });
    });

    it('keeps variables when exposeAllEnv is true', async () => {
      GlobalConfig.set({ exposeAllEnv: true });
      fs.findLocalSiblingOrParent.mockImplementation(
        (packageFile, configFile): Promise<string | null> => {
          if (packageFile === 'package.json' && configFile === '.npmrc') {
            return Promise.resolve('.npmrc');
          }
          return Promise.resolve(null);
        },
      );
      fs.readLocalFile.mockImplementation((fileName): Promise<any> => {
        if (fileName === '.npmrc') {
          return Promise.resolve(
            'registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=${NPM_AUTH_TOKEN}\n',
          );
        }
        return Promise.resolve(null);
      });
      const res = await resolveNpmrc('package.json', {});
      expect(res).toStrictEqual({
        npmrc:
          'registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=${NPM_AUTH_TOKEN}\n',
        npmrcFileName: '.npmrc',
      });
      GlobalConfig.reset();
    });
  });

  describe('getRegistryNpmrcLines', () => {
    it('returns empty array for empty upgrades', () => {
      expect(getRegistryNpmrcLines([])).toEqual([]);
    });

    it('returns empty array for upgrades without registryUrls', () => {
      const upgrades: Upgrade[] = [
        { depName: '@scope/package' },
        { depName: 'unscoped-package' },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([]);
    });

    it('returns registry line for scoped package', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@myorg/my-package',
          registryUrls: ['https://npm.myorg.com/'],
        },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([
        '@myorg:registry=https://npm.myorg.com/',
      ]);
    });

    it('skips unscoped packages', () => {
      const upgrades: Upgrade[] = [
        {
          depName: 'unscoped-package',
          registryUrls: ['https://custom-registry.example.org/'],
        },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([]);
    });

    it('deduplicates scopes', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@myorg/package-a',
          registryUrls: ['https://npm.myorg.com/'],
        },
        {
          depName: '@myorg/package-b',
          registryUrls: ['https://npm.myorg.com/'],
        },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([
        '@myorg:registry=https://npm.myorg.com/',
      ]);
    });

    it('handles multiple scopes', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@org-a/package',
          registryUrls: ['https://registry-a.example.org/'],
        },
        {
          depName: '@org-b/package',
          registryUrls: ['https://registry-b.example.org/'],
        },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([
        '@org-a:registry=https://registry-a.example.org/',
        '@org-b:registry=https://registry-b.example.org/',
      ]);
    });

    it('skips upgrades with empty registryUrls', () => {
      const upgrades: Upgrade[] = [
        { depName: '@scope/package', registryUrls: [] },
        { depName: '@scope/package', registryUrls: null },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([]);
    });

    it('skips upgrades with empty depName', () => {
      const upgrades: Upgrade[] = [
        { depName: '', registryUrls: ['https://registry.example.org/'] },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([]);
    });

    it('uses first registry URL when multiple are provided', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@scope/package',
          registryUrls: [
            'https://primary.example.org/',
            'https://secondary.example.org/',
          ],
        },
      ];
      expect(getRegistryNpmrcLines(upgrades)).toEqual([
        '@scope:registry=https://primary.example.org/',
      ]);
    });
  });

  describe('getRegistryYarnrcScopes', () => {
    it('returns undefined for empty upgrades', () => {
      expect(getRegistryYarnrcScopes([])).toBeUndefined();
    });

    it('returns undefined for upgrades without registryUrls', () => {
      const upgrades: Upgrade[] = [{ depName: '@scope/package' }];
      expect(getRegistryYarnrcScopes(upgrades)).toBeUndefined();
    });

    it('returns npmScopes for scoped package', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@myorg/my-package',
          registryUrls: ['https://npm.myorg.com/'],
        },
      ];
      expect(getRegistryYarnrcScopes(upgrades)).toEqual({
        npmScopes: {
          myorg: { npmRegistryServer: 'https://npm.myorg.com/' },
        },
      });
    });

    it('skips unscoped packages', () => {
      const upgrades: Upgrade[] = [
        {
          depName: 'unscoped-package',
          registryUrls: ['https://custom-registry.example.org/'],
        },
      ];
      expect(getRegistryYarnrcScopes(upgrades)).toBeUndefined();
    });

    it('deduplicates scopes', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@myorg/package-a',
          registryUrls: ['https://npm.myorg.com/'],
        },
        {
          depName: '@myorg/package-b',
          registryUrls: ['https://npm.myorg.com/'],
        },
      ];
      expect(getRegistryYarnrcScopes(upgrades)).toEqual({
        npmScopes: {
          myorg: { npmRegistryServer: 'https://npm.myorg.com/' },
        },
      });
    });

    it('handles multiple scopes', () => {
      const upgrades: Upgrade[] = [
        {
          depName: '@org-a/package',
          registryUrls: ['https://registry-a.example.org/'],
        },
        {
          depName: '@org-b/package',
          registryUrls: ['https://registry-b.example.org/'],
        },
      ];
      expect(getRegistryYarnrcScopes(upgrades)).toEqual({
        npmScopes: {
          'org-a': {
            npmRegistryServer: 'https://registry-a.example.org/',
          },
          'org-b': {
            npmRegistryServer: 'https://registry-b.example.org/',
          },
        },
      });
    });
  });
});
