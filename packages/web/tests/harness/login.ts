/**
 * Switching the signed-in user mid-test through the UI's own real session module
 * (`src/session.ts`): a real log out and log in against the accounts API, exactly what the
 * sidebar's form does, so every view on screen sees the change through `useSession()`.
 *
 * Call only after `startStack()`: `session.ts` reads `VITE_ACCOUNTS_URL` when first imported.
 */
import { act } from "react";

/**
 * Signs out whoever is signed in, then logs in as `email`. Both run inside act() from their very
 * first (synchronous) step: `signOut()` updates the session store before its first await.
 */
export async function logInAs(email: string, password: string): Promise<void> {
  const session = await import("../../src/session.ts");
  await act(async () => session.signOut());
  const error = await act(async () => session.signIn("login", email, password));
  if (error !== null) throw new Error(`log in as ${email} failed: ${error}`);
}
