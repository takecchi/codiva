import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Cheap, fast model for one-shot title summarization. */
const TITLE_MODEL = 'claude-haiku-4-5';
/** Hard ceiling so a wedged subprocess never leaks; title gen is a quick call. */
const TITLE_TIMEOUT_MS = 20_000;

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
