// The per-site shields the host application reads and writes (the demo's
// content-blocker UI, docs/adblock.md "Per-site shields"). The manager holds
// the host-keyed state in memory, pushes the whole list to the service worker
// on every change (as the request rules are pushed), and lets the host persist
// it however it likes. `StompController` and `RemoteController` each expose one
// as `controller.shields`; the only difference is where the push goes (the
// worker directly, or the controller frame over the remote RPC).
import type { ShieldsMode, SiteShields } from '../blocker/types';

export type { ShieldsMode, SiteShields };

/**
 * A new host's shields: the "goodies on" defaults (shields up, the blocker on
 * in standard mode, HTTPS upgraded, fingerprinting protected, third-party
 * cookies blocked). The two destructive controls, blocking the page's own
 * scripts, and forgetting the site on close, default off, as Brave's do.
 */
export const DEFAULT_SHIELDS: Omit<SiteShields, 'host'> = {
	enabled: true,
	mode: 'standard',
	httpsUpgrade: 'upgrade',
	blockScripts: false,
	blockFingerprinting: true,
	cookies: 'third-party',
	forget: false,
};

export interface Shields {
	/** the host's shields, the defaults when it has no stored entry */
	get(host: string): SiteShields;
	/** whether the host has a stored entry (the demo seeds one on first visit) */
	has(host: string): boolean;
	/** merge a patch into the host's shields, push to the worker, return the new state */
	set(host: string, patch: Partial<Omit<SiteShields, 'host'>>): SiteShields;
	/** every stored entry (for the host to persist) */
	all(): SiteShields[];
	/** replace the whole set (on startup, from what the host persisted) and push */
	replace(list: SiteShields[]): void;
}

const normalizeHost = (host: string): string =>
	String(host ?? '').toLowerCase();

/** a stored entry filled out with the defaults, and its host fixed */
function complete(host: string, entry?: Partial<SiteShields>): SiteShields {
	return { ...DEFAULT_SHIELDS, ...entry, host };
}

/**
 * Make a shields manager. `push` sends the whole list wherever it needs to go
 * (the service worker, or the controller frame); `onChange`, when given, is
 * called after each `set` with the host and its new state (the demo persists
 * from it). Both run after the manager's own state is updated.
 */
export function createShields(
	push: (list: SiteShields[]) => void,
	onChange?: (host: string, state: SiteShields) => void,
): Shields {
	const map = new Map<string, SiteShields>();
	const list = (): SiteShields[] => [...map.values()];

	return {
		has: (host) => map.has(normalizeHost(host)),
		get(host) {
			const key = normalizeHost(host);
			return map.get(key) ?? complete(key);
		},
		all: list,
		replace(entries) {
			map.clear();
			for (const entry of entries) {
				if (!entry || !entry.host) continue;
				const key = normalizeHost(entry.host);
				map.set(key, complete(key, entry));
			}
			push(list());
		},
		set(host, patch) {
			const key = normalizeHost(host);
			const next = complete(key, { ...map.get(key), ...patch });
			map.set(key, next);
			push(list());
			onChange?.(key, next);
			return next;
		},
	};
}
