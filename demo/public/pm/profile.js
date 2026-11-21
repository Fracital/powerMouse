// Which profile this page is in (docs/tor.md "Profiles"), before anything
// else of the demo runs: Tor mode is a STomp profile of its own ('tor'),
// apart from the normal one and kept only while a Tor-mode tab is open, as
// Brave's Tor window is an off-the-record profile. The demo's own data is
// kept the same way: in Tor mode what the page writes of its settings,
// bookmarks, history and tabs lasts only this page (`storage`, read through
// to the normal profile's settings and bookmarks, as a Tor window inherits
// them, except the history), and this browser tab's session is kept under
// the profile's keys (`sessionKey`), which the profile's wipe removes. A
// classic script in index.html's <head>; globalThis.PMProfile is the
// interface (pm/theme.js, pm/main.js, pm/extensions-page.js).
(() => {
	const TOR_KEY = 'stomp-demo:tor';
	const query = new URLSearchParams(location.search);
	let saved = false;
	try {
		saved = localStorage.getItem(TOR_KEY) === '1';
	} catch {}
	const tor = query.has('tor')
		? query.get('tor') !== '0'
		: query.has('notor')
			? false
			: saved;
	const id = tor ? 'tor' : '';
	// the mark every store name of a profile ends with (src/profile.ts)
	const named = (key) => (id ? `${key}|${id}` : key);

	// A Tor-mode page that this browser tab showed a moment ago (a reload, a
	// step back to the page) continues its session; anything else (a new
	// tab, a browser started again with its tabs restored) starts a new one
	const LEFT_KEY = named('stomp-demo:left');
	const CONTINUE_MS = 15000;
	let continuing = false;
	if (tor)
		try {
			const left = Number(sessionStorage.getItem(LEFT_KEY));
			continuing = left > 0 && Date.now() - left < CONTINUE_MS;
			sessionStorage.removeItem(LEFT_KEY);
			// a new session reads nothing of an earlier one (a restored tab's)
			if (!continuing)
				for (let i = sessionStorage.length - 1; i >= 0; i--) {
					const key = sessionStorage.key(i);
					if (key?.endsWith(`|${id}`)) sessionStorage.removeItem(key);
				}
			addEventListener('pagehide', () => {
				try {
					sessionStorage.setItem(LEFT_KEY, String(Date.now()));
				} catch {}
			});
		} catch {}

	// what a Tor-mode page starts without: the pages visited
	const FRESH = new Set(['omnibox:visits']);
	/** localStorage in the normal profile; in Tor mode the page's own overlay of it */
	const storage = (() => {
		if (!tor) return localStorage;
		const written = new Map();
		const read = (key) => {
			key = String(key);
			if (written.has(key)) return written.get(key);
			if (FRESH.has(key)) return null;
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		};
		const keys = () => {
			const all = new Set();
			try {
				for (let i = 0; i < localStorage.length; i++) {
					const key = localStorage.key(i);
					if (key !== null && !FRESH.has(key)) all.add(key);
				}
			} catch {}
			for (const [key, value] of written)
				if (value === null) all.delete(key);
				else all.add(key);
			return [...all];
		};
		return {
			getItem: read,
			setItem(key, value) {
				written.set(String(key), String(value));
			},
			removeItem(key) {
				written.set(String(key), null);
			},
			clear() {
				for (const key of keys()) written.set(key, null);
			},
			key: (index) => keys()[index] ?? null,
			get length() {
				return keys().length;
			},
		};
	})();

	globalThis.PMProfile = Object.freeze({
		/** '' (normal) or 'tor' */
		id,
		tor,
		/** a Tor-mode page that continues this browser tab's session (a reload) */
		continuing,
		storage,
		/** this browser tab's sessionStorage key `key` in the profile */
		sessionKey: named,
		/** a name of the demo's own store (an IndexedDB database) in the profile */
		storeName: named,
		TOR_KEY,
	});
})();
