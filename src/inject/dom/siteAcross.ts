// The site pool's navigations across slots (docs/site-pool.md, "Windows and
// messages"): a link, a form or window.open() a frame aims at `_top` or
// `_parent` when that window shows a document of another slot, and the copy
// of a form a frame submits to its proxied parent or top (of its slot or
// another). A deferred part of the document bundle (./deferredParts.ts): it
// runs only once a page aims a navigation there, or once a frame under this
// window asks it to navigate, never before the page's first script, so its
// top level reads no global.
import { INITIATOR_ROUTE } from '../../transport/messages';
import type DocumentClient from './Client';
import type { AcrossInitiator, AcrossNavigation } from './Client';
import type { OtherSubmission } from './navigateOther';
import { siteWindows } from './siteWindows';

/** how long a navigation across slots waits for a worker to answer of its initiator, each way */
const INITIATOR_WAIT_MS = 1000;

/** the form attributes a submission aimed at another window carries, and the submitter's attribute that overrides each */
const FORM_OVERRIDES = [
	['method', 'formmethod'],
	['enctype', 'formenctype'],
	['accept-charset', null],
] as const;

/** the copy of a form, in `document`, that submits `entries` to `action` */
function copyOf(
	document: Document,
	realm: typeof globalThis,
	attributes: [string, string][],
	action: string,
	entries: Iterable<[string, string | File]>,
): HTMLFormElement {
	const copy = document.createElement('form');
	for (const [name, value] of attributes) copy.setAttribute(name, value);
	copy.setAttribute('action', action);
	for (const [name, value] of entries) {
		const input = document.createElement('input');
		input.name = name;
		if (typeof value === 'string') {
			input.type = 'hidden';
			input.value = value;
		} else {
			input.type = 'file';
			const files = new realm.DataTransfer();
			files.items.add(value);
			input.files = files.files;
		}
		copy.append(input);
	}
	copy.hidden = true;
	return copy;
}

/** the attributes and the entry list of `form`'s submission by `submitter`, as the browser builds them in the call */
function formParts(
	client: DocumentClient,
	form: HTMLFormElement,
	submitter: HTMLElement | null,
) {
	const attributes: [string, string][] = [];
	for (const [name, override] of FORM_OVERRIDES) {
		const value =
			(override && submitter?.getAttribute(override)) ??
			form.getAttribute(name);
		if (value !== null && value !== undefined) attributes.push([name, value]);
	}
	const entries = [
		...new client.global.FormData(form, submitter ?? undefined),
	] as [string, string | File][];
	return { attributes, entries };
}

/**
 * `form`'s submission by `submitter` as another window makes it
 * (OtherSubmission): the copy of the form, with the entry list built now,
 * that the window submits from its document when it is called. `submit`:
 * HTMLFormElement's own submit.
 */
export function formSubmission(
	client: DocumentClient,
	form: HTMLFormElement,
	submitter: HTMLElement | null,
	submit: () => void,
): OtherSubmission {
	const { attributes, entries } = formParts(client, form, submitter);
	return (window, owner, action) => {
		const document = window.document;
		const copy = copyOf(document, client.global, attributes, action, entries);
		document.documentElement.append(copy);
		try {
			if (owner) owner.callIn(submit, copy, []);
			else Reflect.apply(submit, copy, []);
		} finally {
			copy.remove();
		}
	};
}

/**
 * A form's submission to `destination`, an http(s) URL, aimed at the
 * proxied parent or top (the Sandbox module's submitAimed, which judged it):
 * `aimed`, a window in reach, submits a copy of the form as its own; else
 * `across`, a window of another slot, is asked to (navigateAcross).
 * `submit`: HTMLFormElement's own submit.
 */
export function submitAimed(
	client: DocumentClient,
	form: HTMLFormElement,
	submitter: HTMLElement | null,
	destination: URL,
	aimed: { window: typeof globalThis; client: DocumentClient } | null,
	across: typeof globalThis | null,
	submit: () => void,
) {
	if (aimed) {
		formSubmission(
			client,
			form,
			submitter,
			submit,
		)(aimed.window, aimed.client, destination.href);
		return;
	}
	const { attributes, entries } = formParts(client, form, submitter);
	navigateAcross(client, across!, {
		kind: 'form',
		action: destination.href,
		attributes,
		entries,
	});
}

/**
 * The window `_parent`, `_top` or `_unfencedtop` names (`name`, lower case)
 * from a frame under the proxied top when that window shows a document of
 * another slot, out of this one's reach (DocumentClient.targetWindow has no
 * client to hand out); null otherwise
 */
export function targetAcross(
	client: DocumentClient,
	name: string,
): typeof globalThis | null {
	const sites = client.sites;
	if (!sites || client.sandboxFlags !== null || !client.nested) return null;
	try {
		const window =
			name === '_parent'
				? client.parent
				: siteWindows().siteTop(client.global, sites.hub);
		if (
			window === client.global ||
			siteWindows().isHub(client.global, window, sites.hub)
		)
			return null;
		try {
			void (client.names.client in window);
			return null;
		} catch (error) {
			return window;
		}
	} catch (error) {
		return null;
	}
}

/**
 * Ask `window` (targetAcross) to navigate itself, as one of its own
 * navigations, in an envelope with the hub's token; the receiver's Context
 * module checks it comes from a frame under it and hands it to its
 * acceptAcross
 */
export function navigateAcross(
	client: DocumentClient,
	window: typeof globalThis,
	request: AcrossNavigation,
) {
	const sites = client.sites;
	if (!sites) return;
	Reflect.apply(
		Reflect.get(window, 'postMessage') as Window['postMessage'],
		window,
		[
			{
				[client.names.globalName]: 'stompNavigate',
				token: sites.token,
				request,
			},
			'*',
		],
	);
}

/**
 * The site pool: `target`, a window of another slot, as an ancestor of
 * this document's (by the browser's own parents, below the hub's page):
 * whether it is the top of the proxied world, and its origin as this
 * document knows it (the ancestors its route or its worker named). Null for
 * a window that is no ancestor of this one.
 */
export function ancestorAcross(
	client: DocumentClient,
	target: unknown,
): { top: boolean; origin: string } | null {
	const sites = client.sites;
	if (!sites) return null;
	try {
		let context: unknown = client.global;
		for (let depth = 0; depth < 64; depth++) {
			const parent = siteWindows().nativeParentOf(context);
			if (
				!parent ||
				parent === context ||
				siteWindows().isHub(client.global, parent, sites.hub)
			)
				return null;
			if (parent === target) {
				const top = target === siteWindows().siteTop(client.global, sites.hub);
				return {
					top,
					origin:
						(top ? client.topOrigin : client.ancestorOrigins()[depth]) ??
						'null',
				};
			}
			context = parent;
		}
	} catch (error) {
		// a window that went away
	}
	return null;
}

/**
 * The site pool: navigate `window`, an ancestor of another slot
 * (ancestorAcross), to `url` as this document's navigation, which the
 * Context module allowed: that window is asked to navigate itself
 * (acceptAcross), with what this document's worker would record of it as
 * the initiator (its routed URL and the referrer policy the browser gave
 * its request: INITIATOR_ROUTE, asked), so the request names it as natively
 * (its Referer by its policy, Sec-Fetch-Site from its origin; a frame of
 * another slot is of another site, so never Sec-Fetch-User). `voucher`: the
 * routed document that speaks for this one to its worker, if any.
 */
export function locationAcross(
	client: DocumentClient,
	voucher: DocumentClient | null,
	window: typeof globalThis,
	url: string,
	replace: boolean,
) {
	let sent = false;
	const send = (initiator?: AcrossInitiator) => {
		if (sent) return;
		sent = true;
		navigateAcross(client, window, {
			kind: 'location',
			url,
			replace,
			...(initiator ? { initiator } : {}),
		});
	};
	if (!voucher) return send();
	// bounded: a worker that does not answer delays nothing for long
	voucher.global.setTimeout(voucher.ownCallback(send), INITIATOR_WAIT_MS);
	voucher
		.nativeFetch(
			`${voucher.global.location.origin}${voucher.directory}${INITIATOR_ROUTE}`,
			{
				method: 'POST',
				body: JSON.stringify({
					url,
					opaque: client.sandboxedOpaque,
					ask: true,
				}),
				cache: 'no-store',
			},
		)
		.then((response) => (response.ok ? response.json() : null))
		.then(
			(facts: Partial<AcrossInitiator> | null) =>
				send(
					typeof facts?.referrer === 'string' &&
						typeof facts.policy === 'string'
						? { referrer: facts.referrer, policy: facts.policy }
						: undefined,
				),
			() => send(),
		);
}

/** what acceptAcross navigates with, the Sandbox module's natives */
export interface AcceptNatives {
	assign: (url: string) => void;
	submit: () => void;
}

/**
 * Carry out what a frame of another slot under this window asked of it
 * (navigateAcross) as this window's own navigation: a document routed as
 * its own, a form submitted from a copy in its document
 */
export function acceptAcross(
	client: DocumentClient,
	request: AcrossNavigation,
	{ assign, submit }: AcceptNatives,
) {
	const global = client.global;
	try {
		if (request.kind === 'location') {
			const destination = new URL(request.url);
			if (!['http:', 'https:'].includes(destination.protocol)) return;
			const replace = request.replace === true;
			let started = false;
			// through this window's own Location, as its script would: the
			// route, the history entry (or none, for replace) and a frame's
			// fresh browsing context are its own navigation's
			const go = () => {
				if (started) return;
				started = true;
				const standIn = (global.location as Record<string, any>)[
					client.names.globalProxy
				] as Location;
				const descriptor = Reflect.getOwnPropertyDescriptor(
					standIn,
					replace ? 'replace' : 'href',
				);
				const method = replace ? descriptor?.value : descriptor?.set;
				if (typeof method === 'function')
					Reflect.apply(method, standIn, [destination.href]);
			};
			const initiator = request.initiator;
			if (
				typeof initiator?.referrer !== 'string' ||
				typeof initiator.policy !== 'string'
			)
				return go();
			// this window's worker is told who started it before it goes
			// (bounded, as the frame's ask was)
			global.setTimeout(client.ownCallback(go), INITIATOR_WAIT_MS);
			client
				.nativeFetch(
					`${global.location.origin}${client.directory}${INITIATOR_ROUTE}`,
					{
						method: 'POST',
						body: JSON.stringify({
							url: destination.href,
							initiator: {
								referrer: initiator.referrer,
								policy: initiator.policy,
							},
						}),
						cache: 'no-store',
					},
				)
				.then(go, go);
			return;
		}
		if (request.kind === 'link') {
			const destination = new URL(request.url);
			if (!['http:', 'https:'].includes(destination.protocol)) return;
			Reflect.apply(assign, global.location, [
				client.navigationRoute(destination),
			]);
			return;
		}
		if (request.kind !== 'form') return;
		const destination = new URL(request.action);
		if (!['http:', 'https:'].includes(destination.protocol)) return;
		const document = global.document;
		// only the attributes submitAimed sends, as strings: an envelope this
		// window takes is from a document of the hub, but any other name (a
		// handler, a style, a target) would be this document's own markup
		// written by another site
		const copy = copyOf(
			document,
			global,
			(Array.isArray(request.attributes) ? request.attributes : []).filter(
				(pair): pair is [string, string] =>
					Array.isArray(pair) &&
					FORM_OVERRIDES.some(([name]) => name === pair[0]) &&
					typeof pair[1] === 'string',
			),
			destination.href,
			(Array.isArray(request.entries) ? request.entries : []).filter(
				(pair): pair is [string, string | File] =>
					Array.isArray(pair) &&
					typeof pair[0] === 'string' &&
					(typeof pair[1] === 'string' || pair[1] instanceof global.File),
			),
		);
		document.documentElement.append(copy);
		try {
			Reflect.apply(submit, copy, []);
		} finally {
			copy.remove();
		}
	} catch (error) {
		// a request this window cannot carry out: nothing navigates
	}
}
