import type { OpenerFacts } from '../coop';
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
	/** the client that sent it (declarativeNetRequest's frame tree and tab ids) */
	client?: string;
	/** the navigation may be another window's than that client's (a popup, a target) */
	opens?: boolean;
	/** that client set a frame's src: it is the frame's parent */
	framing?: boolean;
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

/**
 * The navigations a host started itself (a typed address, RemoteFrame.go),
 * by URL, when it told the worker: no document's hint is coming for them,
 * and the navigation waits for none (the isolated host's frame sends no
 * referrer, and each one it navigated waited the whole wait: 100 ms of
 * every address typed). Taken by the navigation that names it.
 */
const hostStarted = new Map<string, number>();

/** the host is about to navigate a frame of its own to `url` */
export function noteHostNavigation(url: string) {
	const key = keyOf(url);
	hostStarted.delete(key);
	hostStarted.set(key, Date.now());
	if (hostStarted.size > KEPT)
		hostStarted.delete(hostStarted.keys().next().value!);
	for (const wake of waiters.get(key) ?? []) wake();
}

/** whether the host told of a navigation to `key` (taken) */
function hostTook(key: string): boolean {
	const at = hostStarted.get(key);
	if (at === undefined) return false;
	hostStarted.delete(key);
	return Date.now() - at <= TTL_MS;
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
	if (hostTook(key)) return null;
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
	const told = takeNavigationHint(url);
	hostTook(key);
	return told;
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
	/**
	 * a frame's: the policy its element's csp attribute requires of the
	 * document it ends in (CSP Embedded Enforcement), when it has one
	 */
	required?: string;
	/** a top-level navigation's opener policy facts (src/coop.ts) */
	coop?: OpenerFacts;
}

const chains = new Map<string, NavigationChain & { at: number }>();
const CHAIN_TTL_MS = 60_000;

export function recordNavigationChain(
	url: string,
	policies: HopPolicy[],
	ancestors: string[] | undefined,
	client: string | undefined,
	parent: boolean,
	required?: string,
	coop?: OpenerFacts,
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
		// (told with the ancestors: a frame's hint says it, or that it has none)
		required: ancestors ? required : known?.required,
		coop: coop ?? known?.coop,
		at: Date.now(),
	});
	if (chains.size > KEPT) chains.delete(chains.keys().next().value!);
}

/** what the documents of a navigation that began at `url` told of it, if they did lately */
export function navigationChain(url: string): NavigationChain | null {
	const chain = chains.get(keyOf(url));
	return chain && Date.now() - chain.at <= CHAIN_TTL_MS ? chain : null;
}

/**
 * A navigation of another window that a document started (INITIATOR_ROUTE):
 * the inject makes it from that window's realm, since the browser would not
 * let the frame navigate an ancestor inside the host's frame, so the
 * request names that window as its referrer. The document that started it
 * is the navigation's initiator, as natively: its routed URL is the
 * referrer under its own policy (the announcement's, which the browser
 * filled in from the document), its origin judges Sec-Fetch-Site, and its
 * activation Sec-Fetch-User. Keyed and kept as the hints are, and it wins
 * over the hint the navigated window's own navigate event sends.
 */
export interface NavigationInitiator {
	/** the initiator's routed URL, '' for an opaque one (no referrer) */
	referrer: string;
	policy: ReferrerPolicy;
	/** its real origin, "null" for an opaque one */
	origin: string;
	activated: boolean;
}

const initiators = new Map<string, NavigationInitiator & { at: number }>();

export function recordNavigationInitiator(
	url: string,
	initiator: NavigationInitiator,
) {
	const key = keyOf(url);
	initiators.delete(key);
	initiators.set(key, { ...initiator, at: Date.now() });
	if (initiators.size > KEPT)
		initiators.delete(initiators.keys().next().value!);
}

/** the initiator a document announced for a navigation to `url`, taken */
export function takeNavigationInitiator(
	url: string,
): NavigationInitiator | null {
	const key = keyOf(url);
	const initiator = initiators.get(key);
	if (!initiator) return null;
	initiators.delete(key);
	return Date.now() - initiator.at > TTL_MS ? null : initiator;
}
