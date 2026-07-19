/** A display string for an unknown catch value — the Error message, else String(). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
