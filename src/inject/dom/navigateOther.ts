// A document's navigation of another window of the proxied world (`w.location
// = url`, a restricted stand-in's location, Sandbox's gated Location):
// refused as Chrome refuses it, with its console message and SecurityError,
// else made from that window's own realm once the service worker heard of
// its initiator (at once for a window on its initial about:blank whose
// client is of this document's realm); and whether a sandboxed document
// may navigate another window at all (DocumentClient.mayNavigate), with the
// SecurityError it gets when it may not. A deferred part of the document
// bundle (./deferredParts.ts), made by the Context module's hook (and by
// mayNavigate's callers, Sandbox's gated Location, its link to the top and
// window.open()) before it calls anything of the browser's: without it the
// navigation throws (a link's is prevented) and nothing navigates. Its top
// level reads no global (constants and functions only).
import { siteOf } from '../../partition';
import { routeHTML } from '../../rewriteHTML';
import { injectDocumentJS } from '../../routeURL';
import StompURL, { type urlLike } from '../../StompURL';
import { INITIATOR_ROUTE } from '../../transport/messages';
import { withStack } from '../nativeErrors';
import { getPublicSuffix } from '../rewriter';
import { activationState } from './activation';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import { nativeContentType, nativeQuery } from './longEntryNatives';
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

/**
 * A form's submission another window makes as this document's navigation
 * of it (the Sandbox module's, for a form aimed by name at a frame the
 * browser would not navigate for this one): the copy of the form, its entry
 * list built in the page's call, that `window` submits from its document
 * once it is written in. `owner`, the window's client, routes the copy's
 * `action` by its hooks; with none (a frame on its initial about:blank
 * that nothing injected) `action` is routed already.
 */
export type OtherSubmission = (
	window: Context,
	owner: DocumentClient | null,
	action: string,
) => void;

/**
 * What started a navigation of another window, where the page's link or
 * form did (the Sandbox module's): what that window's navigate event reads
 * of it (History navigatedBy), and a form's submission.
 */
export interface OtherCause {
	/** the form's: the window submits it in place of its Location's */
	submission?: OtherSubmission;
	/** the link, or the form's submitter or the form */
	source: Element;
	/** whether the user's click or submission started it (a trusted event) */
	user: boolean;
}

/** how long a navigation of another window waits for the worker to hear of its initiator */
const INITIATOR_WAIT_MS = 1000;

/** how long a navigation of another window waits for that window's document to be written in */
const SHELL_WAIT_MS = 5000;

/**
 * Whether `target`'s document is a proxied shell its markup is not written
 * into yet: committed, with nothing parsed or with the shell's bundle
 * script still in it. The client's loadHTML writes the page with
 * document.open(), which aborts a navigation of the window that started a
 * moment before it (measured: one started 2 ms before was lost, one
 * started a few hundred before was not), where natively the page never
 * opens its document and the navigation always lands. (The browser's own
 * methods, taken before any page script ran: the target's page may have
 * replaced its own.)
 */
function unwritten(client: DocumentClient, target: Context): boolean {
	if (!nativeQuery || initialBlank(target)) return false;
	const document = target.document;
	if (
		nativeContentType &&
		Reflect.apply(nativeContentType, document, []) !== 'text/html'
	)
		return false;
	return (
		Reflect.apply(nativeQuery, document, ['body']).length === 0 ||
		Reflect.apply(nativeQuery, document, [
			`script[src="${injectDocumentJS(client.url, client.config)}"]`,
		]).length > 0
	);
}

/**
 * `then` once `target`'s document is written in (unwritten), at once
 * when it is, bounded (SHELL_WAIT_MS). On this document's timers: the
 * target's next page may replace its own.
 */
function afterShell(client: DocumentClient, target: Context, then: () => void) {
	const until = Date.now() + SHELL_WAIT_MS;
	const poll = () => {
		let waiting = false;
		try {
			waiting = unwritten(client, target);
		} catch (error) {
			// the window went away, or is of another real origin now
		}
		if (waiting && Date.now() < until)
			Reflect.apply(client.global.setTimeout, client.global, [
				client.ownCallback(poll),
				4,
			]);
		else then();
	};
	poll();
}

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
 * DocumentClient.mayNavigate for a sandboxed document, `client`, and a
 * `target` other than its own window: its descendants, the windows it
 * opened, and the proxied top under allow-top-navigation (with user
 * activation under allow-top-navigation-by-user-activation).
 * `frameTopNavigation`: whether its frame's sandbox attribute grants
 * allow-top-navigation.
 */
export function mayNavigate(
	client: DocumentClient,
	target: unknown,
	frameTopNavigation: boolean,
): boolean {
	if (typeof target !== 'object' || target === null) return true;
	if (client.openedWindows.has(target)) return true;
	// a descendant: its chain of parents reaches this window
	const parentOf = client['parentDescriptor'].get!;
	let context = target as Context;
	for (let depth = 0; depth < 64; depth++) {
		let parent: Context;
		try {
			parent = Reflect.apply(parentOf, context, []);
		} catch (error) {
			break;
		}
		if (parent === client.global) return true;
		if (parent === context) break;
		context = parent;
	}
	// (the site pool: the top of the proxied world may be another slot's,
	// out of reach)
	if (
		target !== client.proxiedTop &&
		!(
			client.sites &&
			target === siteWindows().siteTop(client.global, client.sites.hub)
		)
	)
		return false;
	const activated = (activationState(client) & 1) !== 0;
	// a document of another origin than its top's (an opaque one) needs a
	// user activation all the same, unless its frame's attribute grants the
	// flag: a policy's sandbox does not lift Chrome's framebusting
	// intervention (csp-sandbox suite, measured)
	if (client.allows('allow-top-navigation'))
		return (
			activated ||
			frameTopNavigation ||
			(!client.sandboxedOpaque && client.origin === client.topOrigin)
		);
	return client.allows('allow-top-navigation-by-user-activation') && activated;
}
/**
 * The SecurityError a sandboxed document gets for navigating a window it
 * may not (`member` of Location, set or called), naming the URL as the page
 * wrote it
 */
export function navigationRefused(
	client: DocumentClient,
	member: string,
	call: boolean,
	url: URL | string,
): DOMException {
	return withStack(
		new client.global.DOMException(
			`${call ? `Failed to execute '${member}' on` : `Failed to set a named property '${member}' on`} 'Location': The current window does not have permission to navigate the target frame to '${String(url)}'.`,
			'SecurityError',
		),
	);
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
	return navigationRefused(client, member, member !== 'href', destination);
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
 * needs no announcement. `cause`: a link or a form of this document's
 * started it, which the window's navigate event shows as natively (its
 * sourceElement and userInitiated); a form's submission the window
 * submits in place of its Location's (a POST keeps its method and body,
 * and this document is its initiator all the same).
 */
export function navigateOther(
	nav: OtherNavigation,
	target: Context,
	value: urlLike,
	member: 'href' | 'assign' | 'replace',
	cause: OtherCause | null = null,
	/** (once it has waited for the target's document: afterShell) */
	waited = false,
) {
	const client = nav.client;
	const submission = cause?.submission;
	const destination = client.encodingParse(
		String(value),
		client.baseURL.toString(),
	);
	const targetClient = nav.clientOf(target);
	if (!targetClient) {
		// the site pool: an ancestor of another slot, out of reach: refused
		// here as Chrome refuses it, else asked to navigate itself to an
		// http(s) URL (siteAcross.ts)
		// (a form's is never one: the Context module hands over no window
		// of another slot for it)
		const across =
			!submission && client.sites && foreignWindow(target)
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
		// a window whose next document has committed and runs nothing yet
		// (its shell's bundle has not run): decided and made once it does
		// (the page's call has returned by then, and a refusal throws
		// nowhere)
		let waits = false;
		try {
			waits = !waited && unwritten(client, target);
		} catch (error) {
			// a window of another real origin
		}
		if (waits) {
			afterShell(client, target, () => {
				try {
					navigateOther(nav, target, value, member, cause, true);
				} catch (error) {
					// refused, or the window went away
				}
			});
			return;
		}
		// a window that runs nothing yet (a popup or frame still on its
		// initial about:blank): only a sandbox decides, and the browser lets
		// this document navigate it
		if (!client.mayNavigate(target))
			throw navigationRefused(client, member, member !== 'href', destination);
		const routed = routeHTML(
			new StompURL(destination, client.url),
			client.url,
			client.config,
			false,
			false,
		);
		if (submission) submission(target, null, routed);
		else target.location.replace(routed);
		return;
	}
	const reason = refusal(nav, target, destination);
	if (reason !== null) throw refuse(nav, target, reason, member, destination);
	const replace = member === 'replace';
	// (made once the target's document is written in: started while it is
	// still the shell, the navigation is aborted when it is, as above; a
	// form's copy is taken out of the document with it)
	const go = (late = waited) => {
		try {
			if (!late && unwritten(client, target))
				return afterShell(client, target, () => go(true));
		} catch (error) {
			// the window went away, or is of another real origin now
		}
		const owner = nav.clientOf(target) ?? targetClient;
		// (the element only when its document is of the window's origin:
		// natively the event shows no other origin's)
		if (cause)
			try {
				owner.navigatedBy?.(
					destination.href,
					cause.user,
					!client.sandboxedOpaque &&
						!owner.sandboxedOpaque &&
						client.url.url.origin === owner.url.url.origin
						? cause.source
						: null,
				);
			} catch (error) {
				// no URL to compare
			}
		if (submission) {
			try {
				submission(target, owner, destination.href);
			} catch (error) {
				// the window went away
			}
			return;
		}
		try {
			const standIn = (target.location as Record<string, any>)[
				client.names.globalProxy
			] as Location;
			const descriptor = Reflect.getOwnPropertyDescriptor(
				standIn,
				replace ? 'replace' : 'href',
			);
			const method = replace ? descriptor?.value : descriptor?.set;
			// (the window's client now: the target's document may have been
			// replaced since the call)
			if (typeof method === 'function')
				owner.callIn(method, standIn, [destination.href]);
		} catch (error) {
			// the window went away
		}
	};
	if (!/^https?:$/.test(destination.protocol)) return go();
	// a navigation to a fragment of the target's document is synchronous
	// and sends no request, as natively (a navigation the page makes
	// after it, or a javascript: URL's document, sees the fragment)
	// (a URL that ends in `#` has an empty one; a POST form's submission
	// always loads its action)
	if (!submission && destination.href.includes('#')) {
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
	// (this document's activation as the call finds it: an open of the
	// window in the same task consumed what it had, as natively)
	let active = false;
	try {
		active = (activationState(client) & 1) !== 0;
	} catch (error) {
		// no user activation API
	}
	if (
		initialBlank(target) &&
		!client.sandboxedOpaque &&
		!targetClient.sandboxedOpaque &&
		Reflect.getPrototypeOf(targetClient.callIn) ===
			Reflect.getPrototypeOf(client.ownCallback(() => {}))
	) {
		// the window's location hooks tell the worker of the navigation
		// (NavigationHint), and the browser takes this document's activation
		// for its Sec-Fetch-User, not the window's: they hear it for the
		// navigation they send on now. The window's document is of this
		// document's origin (its creator's), so the site rule below holds
		const owner = nav.clientOf(target) ?? targetClient;
		owner.initiatorActivation = { url: destination.href, active };
		try {
			return go();
		} finally {
			owner.initiatorActivation = undefined;
		}
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
		targetClient.global.setTimeout(
			targetClient.ownCallback(() => go()),
			0,
		);
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
