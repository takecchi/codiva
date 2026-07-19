import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { transcriptProjectDir } from '@/core';

/**
 * Thin I/O wrapper for the Claude CLI's per-session transcript
 * (`~/.claude/projects/<munged cwd>/<sessionId>.jsonl`). Parsing lives in the
 * pure `core/transcript.ts`; this module only locates and reads the file.
 */

/** Absolute path of the transcript for a session run in `worktreePath`. */
export function transcriptPath(
  worktreePath: string,
  sdkSessionId: string,
  home: string = homedir(),
): string {
  return join(
    home,
    '.claude',
    'projects',
    transcriptProjectDir(worktreePath),
    `${sdkSessionId}.jsonl`,
  );
}

/**
 * Read a session's transcript JSONL, or undefined when it doesn't exist (e.g.
 * the transcript was cleaned up, or the session ran on another machine).
 * Best-effort: restore must never fail because history is missing.
 */
export async function loadTranscriptText(
  worktreePath: string,
  sdkSessionId: string,
  home?: string,
): Promise<string | undefined> {
  try {
    return await readFile(transcriptPath(worktreePath, sdkSessionId, home), 'utf8');
  } catch {
    return undefined;
  }
}
