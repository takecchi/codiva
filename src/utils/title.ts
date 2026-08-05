import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Cheap, fast model for one-shot title summarization.
 *
 * Uses the *family alias* rather than a version-pinned id (`claude-haiku-4-5`):
 * Claude Code resolves `'haiku'` to the current Haiku generation, so this never
 * goes stale when a new version ships (same reasoning as core/models.ts).
 */
const TITLE_MODEL = 'haiku';
/**
 * Hard ceiling so a wedged subprocess never leaks. Titles are generated while the
 * session's own `claude` subprocess (and every other session's) is competing for
 * the machine, so the budget is deliberately several times the measured latency —
 * a timeout silently costs the user the summary and leaves the raw instruction as
 * the row title.
 */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * Title generation is a one-shot text call: it must not read the repository, load
 * project settings, or think. Left at the SDK defaults the request carries the full
 * Claude Code preset — measured at **56,144 input tokens of tool definitions** plus
 * a few hundred thinking tokens — which made a 3-word summary take 8.4–11.1s and
 * cost ~$0.086 *per session*. Under load that overshot the timeout, so titles
 * intermittently stayed as the raw instruction (the bug this pares back fixes).
 *
 * Measured after: 3.2–4.3s and ~$0.0011 — same quality, ~80x cheaper.
 */
const TITLE_OPTIONS = {
  /** No built-in tools: nothing here should touch the filesystem, and the tool
   *  definitions were the bulk of the prompt. */
  tools: [],
  /** No CLAUDE.md / settings.json: irrelevant to summarizing, and unbounded in size. */
  settingSources: [],
  /** Replace the claude_code preset with one line — this is not an agent. */
  systemPrompt: 'You write short, precise titles. Reply with the title only.',
  /** A 3-to-6-word summary needs no reasoning budget; it only adds latency. */
  thinking: { type: 'disabled' },
} as const satisfies Partial<Options>;

/**
 * Instruction prepended to the prompt. We embed it in the prompt (rather than a
 * system option) to avoid depending on option names, and ask for the task's own
 * language so titles match the user's input.
 */
const TITLE_INSTRUCTION = [
  'Summarize the following task as a short title of 3 to 6 words.',
  'Reply with ONLY the title — no quotes, no punctuation at the end, no preamble.',
  'Write it in the same language as the task.',
  '',
  'Task:',
  '',
].join('\n');

/**
 * The slice of the SDK's `query` we use: a single-shot string prompt yielding
 * the message stream. The real `query` is assignable to this.
 */
export type TitleQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Build a title generator backed by a one-shot Haiku call. Returns the generated
 * title, or `null` if the model produced nothing / errored / timed out (callers
 * fall back to the input-derived placeholder). Never throws.
 */
export function createTitleGenerator(
  queryFn: TitleQuery,
  opts: { cwd: string },
): (prompt: string) => Promise<string | null> {
  return async (prompt: string): Promise<string | null> => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
    try {
      const stream = queryFn({
        prompt: `${TITLE_INSTRUCTION}${prompt}`,
        options: {
          ...TITLE_OPTIONS,
          model: TITLE_MODEL,
          cwd: opts.cwd,
          maxTurns: 1,
          abortController,
        },
      });
      let title: string | null = null;
      for await (const message of stream) {
        const m = message as { type?: string; subtype?: string; result?: unknown };
        if (m.type === 'result' && m.subtype === 'success' && typeof m.result === 'string') {
          const trimmed = m.result.trim();
          title = trimmed.length > 0 ? trimmed : null;
        }
      }
      return title;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
