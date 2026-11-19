import type { IdentityState, PermissionOp } from '../transport/messages';
import { keepValue, keptValue } from './permissions';

/**
 * What the browser keeps of a site's FedCM sign-ins, which decides whether
 * a request may sign the user in without asking (src/inject/dom/
 * credentialFlows.ts). Chrome keeps it in the profile, per relying party,
 * so the proxy origin's would be every proxied site's at once: this worker
 * keeps each site's own beside its permission states (keptValue), keyed by
 * the document's real origin and its top's, as Chrome keys them. Measured
 * in Chrome 157 with a regular profile (the fedcm suite):
 *
 * - an account the user signed in with (picked in the chooser, or signed
 *   in again automatically) is a returning one from then on, as one whose
 *   approved_clients name the relying party is;
 * - an automatic sign-in makes the next request of the site ask the user
 *   (an optional one shows the chooser, a silent one fails before any
 *   request), until the user picks an account in a chooser or ten minutes
 *   pass; preventSilentAccess() does the same, until that pick;
 * - a chooser the user closed makes every request of the site fail before
 *   any request, mediation `required` too: two hours, then a day, a week
 *   and four weeks for each one after.
 *
 * (A profile that is off the record, an incognito window's, never signs
 * in automatically; nothing tells a proxied page's worker which it is.)
 */

/** how long an automatic sign-in keeps the site from another (Chrome's embargo) */
const QUIET_MS = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** how long the site's requests fail after the first, second, ... chooser the user closed */
const COOLDOWNS = [2 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 28 * 24 * HOUR];

/** the accounts of `rp` under `top` signed in with at the provider `idp`: id to when */
const accountsKey = (top: string, rp: string, idp: string) =>
	`${top} fedcm-accounts ${rp} ${idp}`;
/** when the site last signed in automatically */
const quietKey = (top: string) => `${top} fedcm-auto`;
/** preventSilentAccess() of `rp` */
const mediationKey = (rp: string) => `${rp} fedcm-mediation`;
/** the chooser the user closed: until when, and how many in a row */
const cooldownKey = (top: string) => `${top} fedcm-closed`;

const record = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: {};

async function accountsOf(
	top: string,
	rp: string,
	idp: string,
): Promise<Record<string, number>> {
	const kept = record(await keptValue(accountsKey(top, rp, idp)));
	const out: Record<string, number> = {};
	for (const [id, at] of Object.entries(kept))
		if (typeof at === 'number') out[id] = at;
	return out;
}

/** the state a document of `rp` under `top` reads for the provider `idp` */
export async function identityState(
	top: string,
	rp: string,
	idp: string,
	testing: boolean,
): Promise<IdentityState> {
	const now = Date.now();
	const accounts = await accountsOf(top, rp, idp);
	const auto = await keptValue(quietKey(top));
	const closed = record(await keptValue(cooldownKey(top)));
	return {
		accounts: Object.keys(accounts).sort((a, b) => accounts[b] - accounts[a]),
		quiet:
			(typeof auto === 'number' && now - auto < QUIET_MS) ||
			(await keptValue(mediationKey(rp))) === true,
		cooldown: typeof closed.until === 'number' && closed.until > now,
		testing,
	};
}

/** how a document's request ended (PermissionOp `identityDone`) */
export async function identityDone(
	top: string,
	rp: string,
	message: Extract<PermissionOp, { op: 'identityDone' }>,
): Promise<null> {
	const idp = String(message.idp);
	const account =
		typeof message.account === 'string' && message.account.length <= 1024
			? message.account
			: null;
	const now = Date.now();
	switch (message.how) {
		case 'chosen':
		case 'auto': {
			if (account === null) break;
			const accounts = await accountsOf(top, rp, idp);
			accounts[account] = now;
			await keepValue(accountsKey(top, rp, idp), accounts);
			if (message.how === 'auto') await keepValue(quietKey(top), now);
			else {
				// the user picked: the site may sign in automatically again
				await keepValue(quietKey(top), undefined);
				await keepValue(mediationKey(rp), undefined);
			}
			break;
		}
		case 'disconnected': {
			if (account === null) break;
			const accounts = await accountsOf(top, rp, idp);
			delete accounts[account];
			await keepValue(
				accountsKey(top, rp, idp),
				Object.keys(accounts).length ? accounts : undefined,
			);
			break;
		}
		case 'prevent':
			await keepValue(mediationKey(rp), true);
			break;
		case 'closed': {
			const closed = record(await keptValue(cooldownKey(top)));
			const count = (typeof closed.count === 'number' ? closed.count : 0) + 1;
			await keepValue(cooldownKey(top), {
				count,
				until: now + COOLDOWNS[Math.min(count, COOLDOWNS.length) - 1],
			});
			break;
		}
	}
	return null;
}
