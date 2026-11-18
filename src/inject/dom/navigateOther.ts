// A document's navigation of another window of the proxied world (`w.location
// = url`, a restricted stand-in's location, Sandbox's gated Location):
// refused as Chrome refuses it, with its console message and SecurityError,
// else made from that window's own realm once the service worker heard of
// its initiator (at once for a window on its initial about:blank whose
// client is of this document's realm). A deferred part of the document
// bundle (./deferredParts.ts), made by the Context module's hook before it
// calls anything of the browser's: without it the navigation throws and
// nothing navigates. Its top level reads no global (constants and functions
// only).
import { siteOf } from '../../partition';
import { routeHTML } from '../../rewriteHTML';
import StompURL, { type urlLike } from '../../StompURL';
import { INITIATOR_ROUTE } from '../../transport/messages';
import { getPublicSuffix } from '../rewriter';
import { activationState } from './activation';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import {
	initialBlank,
	nativeConsoleError,
	nativeOpener,
} from './modules/Context';
import { foreignWindow, siteWindows } from './siteWindows';

type Context = typeof globalThis;

/** what the Context module hands over: its client and its view of the windows */
export interface OtherNavigation {
	client: DocumentClient;
	/** the client of a window of the proxied world, if it is one */
	clientOf: (context: unknown) => DocumentClient | undefined;
	/** whether this document reaches `context`'s (same origin-domain, neither opaque) */
	reaches: (context: unknown) => boolean;
	/** the routed document that speaks for this one to the service worker */
	voucher: () => DocumentClient | null;
}

/** how long a navigation of another window waits for the worker to hear of its initiator */
const INITIATOR_WAIT_MS = 1000;

/** Chrome's reason for refusing a frame's navigation of its top (its framebusting intervention) */
const FRAMEBUSTING =
	'The frame attempting navigation is targeting its top-level window, but is neither same-origin with its target nor has it received a user gesture. See https://www.chromestatus.com/feature/5851021045661696.';

/**
 * A host's registrable domain as Chrome's framebusting check asks for it
 * (GetDomainAndRegistry): '' for an IP address and for a host that is a
 * public suffix itself (localhost)
 */
function registrableDomainOf(host: string): string {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return '';
	const suffix = getPublicSuffix(host);
	if (!suffix || host === suffix || !host.endsWith(`.${suffix}`)) return '';
	const rest = host.slice(0, -suffix.length - 1);
	return `${rest.slice(rest.lastIndexOf('.') + 1)}.${suffix}`;
}

/**
 * whether this document reaches `context` or one of its proxied
 * ancestors (by the browser's own parents: with the site pool one may be
 * of another slot, out of reach, and one above it of this document's)
 */
function reachesAncestor(nav: OtherNavigation, context: unknown): boolean {
	let current = context;
	for (let depth = 0; current && depth < 64; depth++) {
		if (nav.reaches(current)) return true;
		let parent: unknown;
		try {
			parent = siteWindows().nativeParentOf(current);
		} catch (error) {
			return false;
		}
		if (parent === current) return false;
		current = parent;
	}
	return false;
}
/**
 * Why Chrome refuses this document's navigation of `target` to
 * `destination` (the reason its console message gives), or null when it
 * allows it: LocalFrame::CanNavigate, measured in Chrome 152, 156 and 157
 * alike (top-navigation suite). The real frames cannot decide it: inside
 * the host's frame the proxied top is no browser top, and every proxied
 * window is of one real origin. A sandboxed document navigates what
 * DocumentClient.mayNavigate allows. Any other navigates a window of
 * its origin or under one (its descendants, a frame whose parent is its
 * origin's), its opener, the top level its opener's ancestors reach,
 * and its proxied top when it has had a user's activation (sticky: a
 * click long ago counts) or the destination is of the top's origin (or
 * registrable domain, of its scheme); Chrome's framebusting
 * intervention refuses the rest. A javascript: URL goes only to a
 * window this document reaches. `across`: the site pool's ancestor of
 * another slot (siteAcross.ts ancestorAcross), with no client in reach.
 */
function refusal(
	nav: OtherNavigation,
	target: Context,
	destination: URL,
	across?: { top: boolean; origin: string },
): string | null {
	const client = nav.client;
	if (target === client.global) return null;
	if (destination.protocol === 'javascript:' && !nav.reaches(target))
		return 'The frame attempting navigation must be same-origin with the target if navigating to a javascript: url';
	const top = across ? (across.top ? target : null) : client.proxiedTop;
	if (client.sandboxFlags !== null) {
		if (client.mayNavigate(target)) return null;
		if (target !== top)
			return 'The frame attempting navigation is sandboxed, and is therefore disallowed from navigating its ancestors.';
		if (
			!client.allows('allow-top-navigation') &&
			!client.allows('allow-top-navigation-by-user-activation')
		)
			return "The frame attempting navigation of the top-level window is sandboxed, but the flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is not set.";
		if (!client.allows('allow-top-navigation'))
			return "The frame attempting navigation of the top-level window is sandboxed with the 'allow-top-navigation-by-user-activation' flag, but has no user activation (aka gesture). See https://www.chromestatus.com/feature/5629582019395584.";
		return FRAMEBUSTING;
	}
	if (reachesAncestor(nav, target)) return null;
	const targetClient = nav.clientOf(target);
	// a top level of the proxied world: this document's opener, or one
	// whose opener this document reaches
	if (targetClient && targetClient.proxiedTop === target) {
		try {
			// (openers as the browser has them: a window's own `opener`
			// answers one of another origin as a stand-in)
			const openerOf = (window: Context): unknown =>
				nativeOpener ? Reflect.apply(nativeOpener, window, []) : window.opener;
			if (openerOf(client.global) === target) return null;
			const theirs = openerOf(target);
			if (theirs && reachesAncestor(nav, theirs)) return null;
		} catch (error) {
			// an opener of another real origin
		}
	}
	if (target === top) {
		let active = false;
		try {
			active = (activationState(client) & 2) !== 0;
		} catch (error) {
			// no user activation API
		}
		if (active) return null;
		let topURL: URL | undefined;
		try {
			topURL = across
				? new URL(across.origin)
				: targetClient?.sandboxedOpaque
					? undefined
					: targetClient?.url.url;
		} catch (error) {
			// an opaque top ("null")
		}
		if (topURL) {
			if (topURL.origin === destination.origin) return null;
			const domain = registrableDomainOf(topURL.hostname);
			if (
				domain !== '' &&
				domain === registrableDomainOf(destination.hostname) &&
				topURL.protocol === destination.protocol
			)
				return null;
		}
		return FRAMEBUSTING;
	}
	return "The frame attempting navigation is neither same-origin with the target, nor is it the target's parent or opener.";
}
/**
 * Chrome's refusal of a navigation: its console message (printed by the
 * browser, so no page hook sees it) and the SecurityError of the
 * Location member, naming the URL as resolved
 */
function refuse(
	nav: OtherNavigation,
	target: Context,
	reason: string,
	member: 'href' | 'assign' | 'replace',
	destination: URL,
	origin = nav.clientOf(target)?.origin ?? 'null',
): DOMException {
	const client = nav.client;
	let from: string;
	try {
		from = client.global.location.href;
		if (/^https?:$/.test(new URL(from).protocol))
			from = client.location.toString();
	} catch (error) {
		from = '';
	}
	try {
		Reflect.apply(nativeConsoleError, client.global.console, [
			`Unsafe attempt to initiate navigation for frame with origin '${origin}' from frame with URL '${from}'. ${reason}\n`,
		]);
	} catch (error) {
		// no console
	}
	return client.navigationRefused(member, member !== 'href', destination);
}
/**
 * Navigate `target`, another window of the proxied world, to
 * `destination` as this document's navigation: refused as Chrome
 * refuses it (#refusal), else made from that window's own realm through
 * its Location (the browser lets a window navigate itself, and its
 * Location keeps the route, the history entry and the fresh browsing
 * context of a frame that changes origin), once this document has told
 * the service worker it started it (INITIATOR_ROUTE): its Referer by its
 * referrer policy, Sec-Fetch-Site from its origin, and Sec-Fetch-User
 * only when it had activation and is of the target document's site
 * (measured: a click in a frame of another site sends none). It starts
 * a moment later (natively it starts in the call, cancelling one under
 * way, and commits later), but for a window on its initial about:blank
 * whose client is of this document's realm, which starts in the call and
 * needs no announcement.
 */
export function navigateOther(
	nav: OtherNavigation,
	target: Context,
	value: urlLike,
	member: 'href' | 'assign' | 'replace',
) {
	const client = nav.client;
	const destination = client.encodingParse(
		String(value),
		client.baseURL.toString(),
	);
	const targetClient = nav.clientOf(target);
	if (!targetClient) {
		// the site pool: an ancestor of another slot, out of reach: refused
		// here as Chrome refuses it, else asked to navigate itself to an
		// http(s) URL (siteAcross.ts)
		const across =
			client.sites && foreignWindow(target)
				? deferred('ancestorAcross')(client, target)
				: null;
		const reason = across && refusal(nav, target, destination, across);
		if (reason)
			throw refuse(nav, target, reason, member, destination, across!.origin);
		if (across && /^https?:$/.test(destination.protocol)) {
			deferred('locationAcross')(
				client,
				nav.voucher(),
				target,
				destination.href,
				member === 'replace',
			);
			return;
		}
		// a window that runs nothing yet (a popup or frame still on its
		// initial about:blank): only a sandbox decides, and the browser lets
		// this document navigate it
		if (!client.mayNavigate(target))
			throw client.navigationRefused(member, member !== 'href', destination);
		target.location.replace(
			routeHTML(
				new StompURL(destination, client.url),
				client.url,
				client.config,
				false,
				false,
			),
		);
		return;
	}
	const reason = refusal(nav, target, destination);
	if (reason !== null) throw refuse(nav, target, reason, member, destination);
	const replace = member === 'replace';
	const go = () => {
		try {
			const standIn = (target.location as Record<string, any>)[
				client.names.globalProxy
			] as Location;
			const descriptor = Reflect.getOwnPropertyDescriptor(
				standIn,
				replace ? 'replace' : 'href',
			);
			const method = replace ? descriptor?.value : descriptor?.set;
			if (typeof method === 'function')
				targetClient.callIn(method, standIn, [destination.href]);
		} catch (error) {
			// the window went away
		}
	};
	if (!/^https?:$/.test(destination.protocol)) return go();
	// a navigation to a fragment of the target's document is synchronous
	// and sends no request, as natively (a navigation the page makes
	// after it, or a javascript: URL's document, sees the fragment)
	// (a URL that ends in `#` has an empty one)
	if (destination.href.includes('#')) {
		try {
			const at = new URL(targetClient.location.toString());
			at.hash = '';
			const to = new URL(destination.href);
			to.hash = '';
			if (at.href === to.href) return go();
		} catch (error) {
			// no URL to compare: navigated as any other
		}
	}
	// a window still on its initial about:blank (a frame whose src is on
	// its way, a popup opened with no URL): natively the navigation starts
	// in the call and cancels the one under way, whose request is aborted
	// and whose document never commits (wpt-location's nested-iframe
	// pages). Announced first, it started after the frame's src had
	// committed, and when it started before that document's markup was
	// written in, loadHTML's document.open() aborted it. Such a window's
	// client is its creator's, code of the creator's realm, which the
	// browser takes for the initiator of what it navigates (the Referer,
	// under that document's policy): when that is this document's realm,
	// the navigation is made now and the worker needs no announcement. An
	// opaque document's navigation (no Referer, Origin null) is the
	// worker's to know only from one.
	if (
		initialBlank(target) &&
		!client.sandboxedOpaque &&
		!targetClient.sandboxedOpaque &&
		Reflect.getPrototypeOf(targetClient.callIn) ===
			Reflect.getPrototypeOf(client.ownCallback(() => {}))
	)
		return go();
	let active = false;
	try {
		active = (activationState(client) & 1) !== 0;
	} catch (error) {
		// no user activation API
	}
	let sameSite = false;
	try {
		sameSite =
			!client.sandboxedOpaque &&
			!targetClient.sandboxedOpaque &&
			siteOf(client.url.url, getPublicSuffix) ===
				siteOf(targetClient.url.url, getPublicSuffix);
	} catch (error) {
		// no URL to compare
	}
	const routed = nav.voucher();
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		// (in the target's realm: this document may be gone by then)
		targetClient.global.setTimeout(targetClient.ownCallback(go), 0);
	};
	if (!routed) return start();
	// bounded: a worker that does not answer delays nothing for long
	targetClient.global.setTimeout(
		targetClient.ownCallback(start),
		INITIATOR_WAIT_MS,
	);
	routed
		.nativeFetch(
			`${routed.global.location.origin}${routed.directory}${INITIATOR_ROUTE}`,
			{
				method: 'POST',
				body: JSON.stringify({
					url: destination.href,
					activated: active && sameSite,
					opaque: client.sandboxedOpaque,
				}),
				cache: 'no-store',
			},
		)
		.then(start, start);
}
