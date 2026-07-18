/**
 * Phase 1 SDK spike.
 *
 * Purpose: run a REAL Claude Code session through @anthropic-ai/claude-agent-sdk
 * in streaming-input mode and capture every SDKMessage to a JSONL file, so the
 * status-reducer (Phase 2) can be built and tested against real data rather than
 * assumptions. See docs/TASKS.md "Phase 1" and docs/TECH_NOTES.md checklist.
 *
 * Usage:
 *   pnpm spike            # 'basic' scenario (todo + question + file edit)
 *   pnpm spike followup   # push a 2nd user message after the first result
 *   pnpm spike interrupt  # interrupt() mid-run
 *
 * Requires Claude auth (the spawned `claude` subprocess inherits ~/.claude).
 * Everything runs inside a throwaway temp repo + worktree, cleaned up on exit
 * (pass --keep to leave it for inspection).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

type Scenario = 'basic' | 'followup' | 'interrupt';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const scenario = (positional[0] as Scenario) ?? 'basic';
const keep = process.argv.includes('--keep');

const PROMPTS: Record<Scenario, string> = {
  basic:
    'This is a test harness. Do a small multi-step task and TRACK IT with your todo/task tool: ' +
    '(1) plan the steps, (2) use your question-asking tool to ask me which language the greeting ' +
    'should be in, then (3) create a file greeting.txt with a one-line greeting in the language I pick. ' +
    'Keep everything minimal.',
  followup:
    'Create a file notes.txt with the single word "hello". Then stop and tell me you are done.',
  interrupt:
    'Count slowly: create files step1.txt, step2.txt, step3.txt, step4.txt, step5.txt one at a time, ' +
    'each containing its number.',
};

const prompt = PROMPTS[scenario];
if (prompt === undefined) {
  console.error(`unknown scenario "${scenario}". use: basic | followup | interrupt`);
  process.exit(1);
}

/** Push-based async queue used as the streaming-input generator for query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private readonly waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

function setupSampleRepo(): { dir: string; worktree: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codiva-spike-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'spike@codiva.test');
  git('config', 'user.name', 'codiva spike');
  writeFileSync(join(dir, 'README.md'), '# spike sample repo\n');
  git('add', '-A');
  git('commit', '-m', 'initial');
  const worktree = join(dir, '.codiva', 'worktrees', 'spike');
  git('worktree', 'add', worktree, '-b', 'codiva/spike');
  return { dir, worktree };
}

function summarize(messages: SDKMessage[]): void {
  const typeCounts = new Map<string, number>();
  const toolNames = new Set<string>();
  for (const m of messages) {
    const key = 'subtype' in m && m.subtype ? `${m.type}/${m.subtype}` : m.type;
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
    if (m.type === 'assistant') {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && block.type === 'tool_use') {
            toolNames.add(block.name);
          }
        }
      }
    }
  }
  console.log('\n===== SPIKE SUMMARY =====');
  console.log('message types seen:');
  for (const [k, v] of [...typeCounts.entries()].sort()) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('tool_use names seen:', [...toolNames].sort().join(', ') || '(none)');
  const checks = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'];
  console.log('checklist tools present in stream:');
  for (const t of checks) {
    console.log(`  ${t}: ${toolNames.has(t) ? 'YES' : 'no'}`);
  }
  const hasTaskSystem = [...typeCounts.keys()].some((k) => k.startsWith('system/task'));
  console.log(`  system/task_* messages: ${hasTaskSystem ? 'YES' : 'no'}`);
  console.log('=========================\n');
}

async function main(): Promise<void> {
  const { dir, worktree } = setupSampleRepo();
  const fixturesDir = join(process.cwd(), 'scripts', 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(fixturesDir, `${scenario}-${stamp}.jsonl`);
  console.log(`scenario:  ${scenario}`);
  console.log(`worktree:  ${worktree}`);
  console.log(`fixtures:  ${outFile}\n`);

  const input = new InputQueue();
  const abort = new AbortController();
  const collected: SDKMessage[] = [];
  let resultCount = 0;

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    console.log(`[canUseTool] ${toolName} ${JSON.stringify(toolInput).slice(0, 200)}`);
    appendFileSync(
      outFile,
      `${JSON.stringify({ _spike: 'canUseTool', toolName, input: toolInput })}\n`,
    );
    // AskUserQuestion is the "question" channel. Answer by injecting an `answers`
    // map (questionText -> chosen option label) into updatedInput.
    if (toolName === 'AskUserQuestion') {
      console.log('[canUseTool] >>> AskUserQuestion input:', JSON.stringify(toolInput, null, 2));
      const questions = (toolInput as { questions?: unknown[] }).questions ?? [];
      const answers: Record<string, string> = {};
      for (const raw of questions) {
        const q = raw as { question?: string; options?: { label?: string }[] };
        if (q.question && q.options?.[0]?.label) {
          answers[q.question] = q.options[0].label;
        }
      }
      console.log('[canUseTool] >>> answering with:', JSON.stringify(answers));
      return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
    }
    return { behavior: 'allow', updatedInput: toolInput };
  };

  input.push(prompt);

  const q = query({
    prompt: input,
    options: {
      cwd: worktree,
      permissionMode: 'acceptEdits',
      canUseTool,
      abortController: abort,
      maxTurns: 40,
      settingSources: [],
    },
  });

  try {
    for await (const message of q) {
      collected.push(message);
      appendFileSync(outFile, `${JSON.stringify(message)}\n`);
      const tag =
        'subtype' in message && message.subtype
          ? `${message.type}/${message.subtype}`
          : message.type;
      console.log(`[msg] ${tag}`);

      if (message.type === 'result') {
        resultCount += 1;
        if (scenario === 'followup' && resultCount === 1) {
          console.log('[spike] pushing follow-up message...');
          input.push('Now append the word "world" to notes.txt.');
          continue;
        }
        // basic / followup(after 2nd) / interrupt: end the session.
        input.close();
        break;
      }

      if (scenario === 'interrupt' && message.type === 'assistant') {
        console.log('[spike] calling interrupt()...');
        await q.interrupt();
      }
    }
  } catch (err) {
    console.error('[spike] query threw:', err);
    appendFileSync(outFile, `${JSON.stringify({ _spike: 'error', error: String(err) })}\n`);
  }

  summarize(collected);

  if (keep) {
    console.log(`[spike] temp repo kept at: ${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
