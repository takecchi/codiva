import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTranscriptText, transcriptPath } from './transcript';

describe('transcriptPath', () => {
  it('locates the transcript under ~/.claude/projects/<munged cwd>/<id>.jsonl', () => {
    expect(transcriptPath('/repo/.codiva/worktrees/pr-2', 'abc-123', '/home/u')).toBe(
      '/home/u/.claude/projects/-repo--codiva-worktrees-pr-2/abc-123.jsonl',
    );
  });
});

describe('loadTranscriptText', () => {
  it('reads an existing transcript', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codiva-transcript-'));
    const dir = join(home, '.claude', 'projects', '-wt');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sid.jsonl'), '{"type":"user"}\n', 'utf8');
    await expect(loadTranscriptText('/wt', 'sid', home)).resolves.toBe('{"type":"user"}\n');
  });

  it('returns undefined when the transcript is missing (best-effort restore)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codiva-transcript-'));
    await expect(loadTranscriptText('/wt', 'nope', home)).resolves.toBeUndefined();
  });
});
