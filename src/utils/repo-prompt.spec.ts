import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRepoPromptPath, loadRepoPrompt, saveRepoPrompt } from '@/utils/repo-prompt';

describe('repo prompt file I/O', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves to <repo>/.codiva/prompt.md', () => {
    expect(defaultRepoPromptPath('/repo')).toBe(join('/repo', '.codiva', 'prompt.md'));
  });

  it('returns undefined when the file is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    expect(await loadRepoPrompt(dir)).toBeUndefined();
  });

  it('returns the normalized prompt when the file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    const path = join(dir, 'prompt.md');
    await writeFile(path, '  Open a PR when done\n', 'utf8');
    expect(await loadRepoPrompt(dir, path)).toBe('Open a PR when done');
  });

  it('returns undefined for an empty file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    const path = join(dir, 'prompt.md');
    await writeFile(path, '   \n', 'utf8');
    expect(await loadRepoPrompt(dir, path)).toBeUndefined();
  });

  it('saves the normalized prompt to <repo>/.codiva/prompt.md, creating the dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    await saveRepoPrompt(dir, '  Open a PR when done  ');
    const path = defaultRepoPromptPath(dir);
    expect(await readFile(path, 'utf8')).toBe('Open a PR when done\n');
    // Round-trips back through the loader.
    expect(await loadRepoPrompt(dir)).toBe('Open a PR when done');
  });

  it('deletes the file when saving an empty prompt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    await saveRepoPrompt(dir, 'something');
    await saveRepoPrompt(dir, '   \n'); // clear
    expect(await loadRepoPrompt(dir)).toBeUndefined();
  });

  it('clearing a non-existent prompt is a no-op (does not throw)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-rp-'));
    await expect(saveRepoPrompt(dir, '')).resolves.toBeUndefined();
  });
});
