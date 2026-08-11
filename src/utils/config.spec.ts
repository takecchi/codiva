import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigPath, loadConfig, saveConfig } from '@/utils/config';

describe('config file I/O', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults to ~/.codiva/config.json', () => {
    expect(defaultConfigPath()).toMatch(/\.codiva\/config\.json$/);
  });

  it('returns empty config when the file is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-cfg-'));
    expect(await loadConfig(join(dir, 'nope.json'))).toEqual({});
  });

  it('returns empty config when the file is invalid JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-cfg-'));
    const path = join(dir, 'config.json');
    await writeFile(path, '{ not json', 'utf8');
    expect(await loadConfig(path)).toEqual({});
  });

  it('round-trips a saved config', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-cfg-'));
    const path = join(dir, 'nested', 'config.json'); // exercises mkdir of parent dir
    await saveConfig({ language: 'en' }, path);
    expect(await loadConfig(path)).toEqual({ language: 'en' });
  });

  // 一時ファイル → rename で書くので、書き終わったディレクトリに残骸を残さない
  // （残ると `.codiva`/`~/.codiva` にゴミが溜まり、次の保存で拾われる余地もできる）。
  it('leaves no temp file behind', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-cfg-'));
    const path = join(dir, 'config.json');
    await saveConfig({ language: 'en' }, path);
    await saveConfig({ language: 'ja' }, path);
    expect(await readdir(dir)).toEqual(['config.json']);
    expect(await loadConfig(path)).toEqual({ language: 'ja' });
  });

  it('drops invalid language on load', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-cfg-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ language: 'fr' }), 'utf8');
    expect(await loadConfig(path)).toEqual({});
  });
});
