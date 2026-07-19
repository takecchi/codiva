import { summarizeToolUse, toolResultSummary } from './sdk-parse';
import type { LogEntry } from './types';

/**
 * Rebuild the detail-view log from a Claude CLI transcript (JSONL).
 *
 * Why: the SDK's `resume` restores the *model-side* conversation context only —
 * it does NOT re-emit past messages on the consumer stream. So a restored
 * session would show an empty log until its next turn. The full history does
 * exist on disk though: the CLI writes one JSONL transcript per session under
 * `~/.claude/projects/<munged cwd>/<sessionId>.jsonl`. This module converts
 * those lines into the same `LogEntry` shapes the live reducer produces, so a
 * restored detail view looks identical to the live one.
 *
 * Pure: parsing/conversion only. Reading the file lives in `utils/transcript.ts`.
 */

/**
 * Directory name the Claude CLI derives from a session's cwd
 * (`~/.claude/projects/<this>/<sessionId>.jsonl`): every non-alphanumeric
 * character becomes `-` (verified against real transcript dirs;
 * `/a/.b` → `-a--b`).
 */
export function transcriptProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Minimal shapes read out of (untrusted) transcript lines. */
interface TranscriptContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
}

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Push `entry` (without seq) onto `out`, numbering it like the live reducer would. */
function push(out: LogEntry[], entry: Omit<LogEntry, 'seq'>): void {
  out.push({ seq: out.length + 1, ...entry });
}

function appendUserLine(out: LogEntry[], content: unknown, timestamp: number | undefined): void {
  // A plain string is the prompt the user typed; block arrays carry either
  // typed text blocks or tool_result blocks (summarized like the live reducer).
  if (typeof content === 'string') {
    const text = content.trim();
    if (text.length > 0) {
      push(out, { kind: 'user', text, timestamp });
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as TranscriptContentBlock;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text.length > 0) {
        push(out, { kind: 'user', text, timestamp });
      }
    } else if (block.type === 'tool_result') {
      const text = toolResultSummary(block.content);
      if (text.length > 0) {
        push(out, { kind: 'tool_result', text, timestamp });
      }
    }
  }
}

function appendAssistantLine(
  out: LogEntry[],
  content: unknown,
  timestamp: number | undefined,
): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as TranscriptContentBlock;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text.length > 0) {
        push(out, { kind: 'assistant_text', text, timestamp });
      }
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      push(out, { kind: 'tool_use', text: summarizeToolUse(block.name, input), timestamp });
    }
    // thinking / other block types are not part of the visible log
  }
}

/**
 * Convert a transcript's JSONL text into detail-view log entries (seq 1..n).
 * Mirrors the live reducer's rendering: user text → `user`, tool_result →
 * one-line `tool_result` summary, assistant text → `assistant_text`, tool_use →
 * summarized `tool_use`. Meta/sidechain lines and non-message records
 * (queue-operation, attachment, ai-title, last-prompt, pr-link, …) are skipped.
 * Malformed lines are ignored — a corrupt transcript must not break restore.
 */
export function transcriptLogEntries(jsonl: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    const o = parsed as {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      message?: unknown;
      timestamp?: unknown;
    };
    if (o.isMeta === true || o.isSidechain === true) {
      continue;
    }
    const message =
      o.message && typeof o.message === 'object' ? (o.message as { content?: unknown }) : undefined;
    const timestamp = parseTimestamp(o.timestamp);
    if (o.type === 'user') {
      appendUserLine(out, message?.content, timestamp);
    } else if (o.type === 'assistant') {
      appendAssistantLine(out, message?.content, timestamp);
    }
  }
  return out;
}
