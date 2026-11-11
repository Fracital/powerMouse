// How the host's own document was loaded, for the page a host shows again
// after a refresh. Natively a reload revalidates the document and a hard
// reload (Ctrl+Shift+R) fetches it and everything it loads past the caches;
// through the proxy either one only reloads the host, and the page the host
// then restores is a new navigation the worker's caches would answer. So the
// controller tells its worker how the host was loaded, and the worker gives
// the navigations that follow that cache mode (rewrites.ts hostReloaded).
//
// A reload is the navigation entry's type. A hard one reads the same there,
// but Chrome loads the frames a hard-reloaded document creates before its
// load event as hard reloads too, and their navigation entries say
// `reload` where any other frame's says `navigate` (measured in Chrome 152
// and 156, a srcdoc frame). So the question is asked when this module
// loads, the earliest a controller can: a host that loads it after its own
// load event learns of a reload, never of a hard one.
import type { HostReload } from '../transport/messages';

/** how long the probe frame may take to load */
const PROBE_WAIT_MS = 4000;

function detect(): Promise<HostReload | undefined> {
	if (typeof document === 'undefined' || typeof performance === 'undefined')
		return Promise.resolve(undefined);
	const entry = performance.getEntriesByType('navigation')[0] as
		PerformanceNavigationTiming | undefined;
	if (entry?.type !== 'reload') return Promise.resolve(undefined);
	if (document.readyState === 'complete') return Promise.resolve('no-cache');
	return new Promise((resolve) => {
		const probe = document.createElement('iframe');
		probe.style.display = 'none';
		probe.setAttribute('aria-hidden', 'true');
		const done = (mode: HostReload) => {
			clearTimeout(timer);
			probe.remove();
			resolve(mode);
		};
		probe.addEventListener('load', () => {
			let type: string | undefined;
			try {
				type = (
					probe.contentWindow?.performance.getEntriesByType('navigation')[0] as
						PerformanceNavigationTiming | undefined
				)?.type;
			} catch {
				// not ours to read: no answer
			}
			done(type === 'reload' ? 'reload' : 'no-cache');
		});
		const timer = setTimeout(() => done('no-cache'), PROBE_WAIT_MS);
		probe.srcdoc = '';
		(document.body || document.documentElement).append(probe);
	});
}

const detected = detect();

/**
 * `no-cache` when the host page was reloaded, `reload` when that was a hard
 * reload, undefined otherwise
 */
export function hostReload(): Promise<HostReload | undefined> {
	return detected;
}
