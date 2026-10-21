/**
 * Operator CLI: set an existing account's role directly in the accounts file.
 *
 *   npm run set-role --workspace packages/features/accounts -- <email> <user|moderator|admin>
 *
 * This is the only way the first admin can come to exist (ADR 0006). Being able to run it at all
 * requires shell access to the machine holding the accounts file — which is already full control
 * of the deployment — so it needs no further authentication of its own.
 */
import { accountsStorePath, buildAccountService, loadRootEnv } from "./bootstrap.ts";

loadRootEnv();

const [email, role] = process.argv.slice(2);
if (!email || !role) {
  console.error("usage: set-role <email> <user|moderator|admin>");
  process.exit(2);
}

const result = await buildAccountService().setRoleAsOperator(email, role);
if (!result.ok) {
  console.error(`error (${result.error}): ${result.message}`);
  console.error(`accounts file: ${accountsStorePath()}`);
  process.exit(1);
}
console.log(`${result.user.email} (${result.user.id}) is now "${result.user.role}"`);
