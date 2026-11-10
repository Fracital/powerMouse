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
