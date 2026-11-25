// The site pool's code a document runs only once something has happened
// (docs/site-pool.md): a frame of another slot navigates, a violation is
// reported, a frame gets an allow attribute, a message asks this window to
// navigate. A deferred part of the document bundle (./deferredParts.ts):
// never before the page's first script, so its top level reads no global.
// The hooks that call these stay in the bundle, and decide there whether a
// call is the pool's at all, so a document that never meets another slot
// never evaluates the parts.
import { namedRefusal } from '../../refusalName';
import type { NavigationHintMessage } from '../../transport/messages';
import { routedPrefix, unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';
import type { AcrossNavigation } from './Client';
import { deferred } from './deferred';
import type { Pool } from './pool';
import { siteWindows } from './siteWindows';

/** what the NavigationHint module tells the worker with (NavigationHintModule.hint) */
type Hint = (
	url: string,
	allow?: string,
	csp?: NavigationHintMessage['csp'],
) => void;

/**
 * A frame whose parent is a document of another slot, which it cannot
 * reach (NavigationHint judgeFrame). The parent's frame-src, as the
 * document that navigated the frame told the worker (ScriptFacts.framed),
 * judges the navigation here: a refused one is cancelled and goes to a URL
 * whose host names the refused URL (namedRefusal), which the parent's
 * browser frame-src refuses, and the parent's inject reads back (the parent
 * gets Chrome's event). A report-only refusal is not reported: the parent's
 * inject would have to dispatch it.
 */
export function judgeAcross(
	client: DocumentClient,
	event: Event,
	destination: string,
	send: Hint,
): boolean | null {
	const navigate = event as Event & { navigationType?: string };
	const framed = siteWindows().framedOf(client);
	if (!framed) return null;
	const real = unrouteURL(client, destination);
	if (
		!real ||
		!/^https?:/.test(real) ||
		/^[a-z]+:\/\/[^/]*\.refused\.invalid[:/]/.test(real) ||
		navigate.navigationType === 'traverse'
	)
		return null;
	let url: URL;
	try {
		url = new URL(real);
	} catch (error) {
		return null;
	}
	// (as the parent judges a src it sets: paths compared)
	const refused = framed.policies.some(
		([directive, sources, disposition, self]) => {
			if (directive !== 'frame-src' || disposition !== 'enforce') return false;
			try {
				// (the source matching is a part of its own: ../../cspSources.ts)
				return !deferred('sourcesMatch')(sources, url, new URL(self));
			} catch (error) {
				return false;
			}
		},
	);
	if (refused && navigate.cancelable) {
		event.preventDefault();
		event.stopImmediatePropagation();
		const refusal = namedRefusal(url.href);
		const location = client.global.location;
		if (navigate.navigationType === 'replace') location.replace(refusal);
		else location.assign(refusal);
		return true;
	}
	send(destination, undefined, {
		policies: framed.policies,
		ancestors: client.ancestorOrigins(),
		parent: true,
	});
	return false;
}

/**
 * A frame of another slot asked this window to navigate (DocumentClient
 * navigateAcross) in an envelope with the hub's token: carried out
 * (DocumentClient.acceptAcross, the Sandbox module's) when `source` is a
 * frame somewhere under this window, by the browser's own `parent`
 * (readable on a window of any origin)
 */
export function receiveAcross(
	client: DocumentClient,
	source: unknown,
	request: AcrossNavigation,
) {
	try {
		let context = source;
		for (let depth = 0; depth < 64 && context; depth++) {
			const parent = siteWindows().nativeParentOf(context);
			if (parent === context) return;
			if (parent === client.global) {
				// (a deferred part: Pool is the bundle's, so its index is
				// written here, and checked against it)
				client.pool[7 satisfies Pool.AcceptAcross]?.(request);
				return;
			}
			context = parent;
		}
	} catch (error) {
		// a window that went away
	}
}

/**
 * What the browser names on the origin of a slot of the pool other than
 * this document's (a frame's hop to its slot, the referrer a document of
 * another slot sent), read on this document's own origin: the routes are
 * the same on every slot. `slot`: whether the URL was on a slot's origin
 * (or the hub's), which the page never reads. (The ContentSecurity
 * module's violation reports.)
 */
export function onOwnSlot(
	client: DocumentClient,
	value: string,
): { value: string; slot: boolean } {
	const sites = client.sites;
	if (!sites) return { value, slot: false };
	let origin: string;
	try {
		origin = new URL(value).origin;
	} catch (error) {
		return { value, slot: false };
	}
	const own = new URL(routedPrefix(client)).origin;
	if (origin === own || origin === sites.hub) return { value, slot: true };
	if (!sites.origins?.includes(origin)) return { value, slot: false };
	return { value: `${own}${value.slice(origin.length)}`, slot: true };
}

/**
 * The allow attribute the browser reads for a frame whose document may be
 * another slot's (another origin to the browser, so an allowlist of
 * `'src'`, `'self'` or the frame's real origin would name none of it):
 * every feature the page's attribute names, delegated to any origin, but a
 * feature it gives nobody. The frame's documents are served with the policy
 * the page's attribute gives their real origin (src/server/clientHints.ts
 * browserPolicy), as without a pool, where the browser sees every frame as
 * of its parent's origin. (The DOMAttributes module, for a frame that has
 * an allow attribute.)
 */
export function slotContainerPolicy(allow: string): string {
	const entries: string[] = [];
	for (const entry of allow.split(';')) {
		const [feature, ...allowlist] = entry.trim().split(/\s+/);
		if (!feature) continue;
		entries.push(
			`${feature} ${allowlist.length && allowlist.every((source) => source.toLowerCase() === "'none'") ? "'none'" : '*'}`,
		);
	}
	return entries.join('; ');
}
