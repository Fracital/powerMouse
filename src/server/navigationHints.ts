import type { HopPolicy } from '../csp';

// What documents told the worker about the navigations they started
// (NAVIGATION_HINT): the initiator's origin, as the worker verified it, and
// whether the page had user activation. Keyed by the destination's real URL
// without its fragment, taken by the navigation that names it, kept a few seconds.
const KEPT = 256;
const TTL_MS = 5000;

export interface NavigationHint {
	origin: string;
	activated: boolean;
	/** a frame's: its element's allow attribute */
	allow?: string;
	/** the address of the controller the document that sent it is routed under */
	directory: string;
	/** the nested route marker of that document's frame, false at the top level */
	nested: string | false;
	/** whether that document is the routed one itself: its address is then the navigation's referrer */
	own: boolean;
}

const hints = new Map<string, NavigationHint & { at: number }>();
const waiters = new Map<string, Set<() => void>>();

const keyOf = (url: string) => url.split('#')[0];

export function recordNavigationHint(url: string, hint: NavigationHint) {
	const key = keyOf(url);
	hints.delete(key);
	hints.set(key, { ...hint, at: Date.now() });
	if (hints.size > KEPT) hints.delete(hints.keys().next().value!);
	for (const wake of waiters.get(key) ?? []) wake();
}

/** the hint for a navigation to `url`, left for the navigation that takes it */
export function peekNavigationHint(url: string): NavigationHint | null {
	const hint = hints.get(keyOf(url));
	return hint && Date.now() - hint.at <= TTL_MS ? hint : null;
}

/** peekNavigationHint, waiting up to `ms` for the hint to arrive */
export async function awaitNavigationHintPeek(
	url: string,
	ms: number,
): Promise<NavigationHint | null> {
	const hint = peekNavigationHint(url);
	if (hint) return hint;
	const key = keyOf(url);
	await new Promise<void>((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			waiters.get(key)?.delete(wake);
			if (!waiters.get(key)?.size) waiters.delete(key);
			resolve();
		};
		const timer = setTimeout(wake, ms);
		if (!waiters.has(key)) waiters.set(key, new Set());
		waiters.get(key)!.add(wake);
	});
	return peekNavigationHint(url);
}

/** the hint for a navigation to `url`, taken (it serves one navigation), when one arrived */
export function takeNavigationHint(url: string): NavigationHint | null {
	const key = keyOf(url);
	const hint = hints.get(key);
	if (!hint) return null;
	hints.delete(key);
	return Date.now() - hint.at > TTL_MS ? null : hint;
}

/** the hint for `url`, waiting up to `ms` for it to arrive (its message may trail the navigation) */
export async function awaitNavigationHint(
	url: string,
	ms: number,
): Promise<NavigationHint | null> {
	const hint = takeNavigationHint(url);
	if (hint) return hint;
	const key = keyOf(url);
	await new Promise<void>((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			waiters.get(key)?.delete(wake);
			if (!waiters.get(key)?.size) waiters.delete(key);
			resolve();
		};
		const timer = setTimeout(wake, ms);
		if (!waiters.has(key)) waiters.set(key, new Set());
		waiters.get(key)!.add(wake);
	});
	return takeNavigationHint(url);
}

/**
 * What the documents a navigation concerns told the worker of the page's
 * policies that judge its later hops and the document it ends in
 * (NavigationHintMessage `csp`): kept by the real URL the navigation began
 * at, for as long as a redirect chain may take, and never taken (every hop
 * asks). A form's form-action and its frame's parent's frame-src are told
 * of one navigation by two documents, and kept side by side.
 */
export interface NavigationChain {
	policies: {
		policy: HopPolicy;
		/** the client that told it, which is told of a report-only refusal */
		client?: string;
		/** the policy is the parent's of the frame that told it */
		parent: boolean;
	}[];
	/** a frame's: its real ancestors' origins, nearest first */
	ancestors?: string[];
}

const chains = new Map<string, NavigationChain & { at: number }>();
const CHAIN_TTL_MS = 60_000;

export function recordNavigationChain(
	url: string,
	policies: HopPolicy[],
	ancestors: string[] | undefined,
	client: string | undefined,
	parent: boolean,
) {
	const key = keyOf(url);
	const known = navigationChain(url);
	const directives = new Set(policies.map(([directive]) => directive));
	chains.delete(key);
	chains.set(key, {
		policies: [
			...(known?.policies.filter(({ policy }) => !directives.has(policy[0])) ??
				[]),
			...policies.map((policy) => ({ policy, client, parent })),
		],
		ancestors: ancestors ?? known?.ancestors,
		at: Date.now(),
	});
	if (chains.size > KEPT) chains.delete(chains.keys().next().value!);
}

/** what the documents of a navigation that began at `url` told of it, if they did lately */
export function navigationChain(url: string): NavigationChain | null {
	const chain = chains.get(keyOf(url));
	return chain && Date.now() - chain.at <= CHAIN_TTL_MS ? chain : null;
}
