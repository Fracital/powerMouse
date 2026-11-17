// Cross-Origin-Opener-Policy between proxied pages. The browser cannot
// apply a page's own policy: every proxied site is one origin to it, and
// a proxied page is a frame of the host's tab or a popup of it. So the
// worker decides, as Chrome does (the HTML standard's "check if COOP
// values require a browsing context group switch", measured in Chrome 157
// by the coop suite), whether a top-level navigation leaves its browsing
// context group, and makes the browser do it with a real policy of its
// own on the document it serves: one that differs from the window's
// current one switches, the same one keeps the group. What the browser
// does then is what a page natively sees: the opener's window of the
// popup reads closed and takes no message, the popup has no opener and
// its name is gone.

/** a navigation's side as the documents told it (NavigationHintMessage `coop`) */
export type OpenerFacts = [
	/** the window shows its initial about:blank (a popup's first navigation) */
	initial: boolean,
	/** the policy of the active document (an initial about:blank: its creator's top's) */
	policy: string,
	/** the active document's origin (an initial about:blank: its creator's) */
	origin: string,
	/** the policy the browser has for the window now: '' or 'same-origin' */
	real: string,
];

const POLICIES = [
	'same-origin',
	'same-origin-allow-popups',
	'noopener-allow-popups',
];

/**
 * A response's opener policy as Chrome takes it: the header's token (its
 * parameters dropped), '' (unsafe-none) for none, an unknown or malformed
 * one, and on an origin that is not potentially trustworthy, where the
 * header is ignored
 */
export function openerPolicy(value: string | null, origin: string): string {
	if (value === null || !trustworthy(origin)) return '';
	const token = value.split(';')[0].trim();
	return POLICIES.includes(token) ? token : '';
}

/** whether an origin is potentially trustworthy (https, or a loopback host) */
export function trustworthy(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol === 'https:') return true;
		if (url.protocol !== 'http:') return false;
		const host = url.hostname;
		return (
			host === 'localhost' ||
			host.endsWith('.localhost') ||
			/^127\.\d+\.\d+\.\d+$/.test(host) ||
			host === '[::1]'
		);
	} catch (error) {
		return false;
	}
}

/**
 * Whether a top-level navigation from the active document (`facts`) to a
 * response of `policy` at `origin` leaves the browsing context group
 */
export function switchesGroup(
	[initial, active, activeOrigin]: OpenerFacts,
	policy: string,
	origin: string,
): boolean {
	if (active === '' && policy === '') return false;
	// a popup's first document: an opener that allows popups keeps one
	// without a policy, whatever its origin
	if (
		initial &&
		(active === 'same-origin-allow-popups' ||
			active === 'noopener-allow-popups') &&
		policy === ''
	)
		return false;
	if (active === policy && activeOrigin === origin) return false;
	return true;
}

/**
 * The policy the browser gets for a document that `switches` (or not)
 * from a window whose policy it has now is `real`: '' sends none
 */
export function realPolicy(real: string, switches: boolean): string {
	const now = real === 'same-origin' ? 'same-origin' : '';
	if (!switches) return now;
	return now === 'same-origin' ? '' : 'same-origin';
}
