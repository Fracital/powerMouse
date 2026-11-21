// Links and forms aimed at another window than their own, and the site
// pool's navigations across slots (docs/site-pool.md, "Windows and
// messages"): a link or a form whose target (or its document's base target)
// is `_top`, `_parent`, `_unfencedtop` or a name (the Sandbox module's
// linkAimed and submitAimed; the IFrame module's blankLink and
// blankSubmission, for a frame still on its initial about:blank), a link, a
// form or window.open() a frame aims at `_top` or `_parent` when that window
// shows a document of another slot, and the copy of a form a frame submits
// to its proxied parent or top (of its slot or another). A deferred part of
// the document bundle (./deferredParts.ts): it runs only once a page aims a
// navigation there, or once a frame under this window asks it to navigate,
// never before the page's first script, so its top level reads no global.
// Without it the link or the submit event navigates nothing (its default is
// prevented) and submit() throws, never the browser's own navigation in its
// place (for `_top` or `_parent` it lands in the frame: the hooks made its
// target `_self` to the browser).
import { routeHTML } from '../../rewriteHTML';
import StompURL from '../../StompURL';
import { INITIATOR_ROUTE } from '../../transport/messages';
import type DocumentClient from './Client';
import type { AcrossInitiator, AcrossNavigation } from './Client';
import { frameWindow } from './freshContext';
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
function formSubmission(
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

/** `destination`, a javascript: URL, routed to run in `aimed`'s window, the proxied parent or top */
const javascriptIn = (
	client: DocumentClient,
	destination: URL,
	aimed: DocumentClient,
) =>
	routeHTML(
		new StompURL(destination, client.url),
		client.url,
		client.config,
		false,
		aimed.nestedRoute,
	);

/**
 * The Sandbox module's: a click on `link`, whose target (or its document's
 * base target: `aim`, as the page wrote it) may name another window than
 * its own. A link to the top (or to the parent, when the parent is the
 * top) in a sandboxed document: the hooks leave its target as the page
 * wrote it (DOMAttributes), so the browser refuses it, unless the sandbox
 * allows top navigation; then the proxied top goes there, from its own
 * realm (the browser would not let this frame navigate it).
 *
 * And a link to the parent or the top in a frame under the proxied top,
 * sandboxed or not: the hooks made its target the frame itself (the
 * browser's `_parent` and `_top` are not the page's: the host frames the
 * proxied top sandboxed, and its top is the host), so the window the page
 * means is navigated here, from its own realm, with the URL routed as its
 * document. A javascript: URL runs there. `assign`: Location's own.
 */
export function linkAimed(
	client: DocumentClient,
	event: MouseEvent,
	link: HTMLAnchorElement | HTMLAreaElement,
	aim: string,
	assign: (url: string) => void,
) {
	const target = aim.toLowerCase();
	const resolve = () =>
		new URL(String(link.getAttribute('href')), client.baseHref);
	if (client.sandboxFlags === null) {
		const aimed = client.targetWindow(target);
		// the site pool: the window is another slot's, asked to go there
		// itself; a javascript: URL runs in no window of another origin, as
		// natively
		const across =
			aimed || !client.sites
				? null
				: siteWindows().targetAcross(client, target);
		if (!aimed && !across) {
			// a window by that name the browser would not navigate for this
			// frame (DocumentClient namedWindow; the hooked getter answers
			// with what the page wrote): this document's navigation of it
			const named = client.namedWindow?.(aim);
			if (!named) return;
			const destination = resolve();
			if (!['http:', 'https:'].includes(destination.protocol)) return;
			// (its navigate event shows the link, and the user's click as the
			// user's)
			if (
				client.navigateWindow?.(named, destination.href, 'href', {
					source: link,
					user: event.isTrusted,
				})
			)
				event.preventDefault();
			return;
		}
		const destination = resolve();
		if (!['http:', 'https:', 'javascript:'].includes(destination.protocol))
			return;
		event.preventDefault();
		if (!aimed) {
			if (destination.protocol !== 'javascript:')
				navigateAcross(client, across!, {
					kind: 'link',
					url: destination.href,
				});
			return;
		}
		aimed.client.callIn(assign, aimed.window.location, [
			// a document is one of that window's own navigations; a
			// javascript: URL's code is rewritten to run there
			destination.protocol === 'javascript:'
				? javascriptIn(client, destination, aimed.client)
				: aimed.client.navigationRoute(destination),
		]);
		return;
	}
	const top = client.proxiedTop;
	if (!(target === '_top' || (target === '_parent' && client.parent === top)))
		return;
	if (top === client.global) return;
	const destination = resolve();
	if (!['http:', 'https:'].includes(destination.protocol)) return;
	// (a deferred part of its own, ./navigateOther.ts: without it the link
	// navigates nothing, the browser's navigation included)
	let may: boolean;
	try {
		may = client.mayNavigate(top);
	} catch (error) {
		event.preventDefault();
		return;
	}
	if (!may) return;
	event.preventDefault();
	const topClient = (top as Record<string, any>)[client.names.client] as
		DocumentClient | undefined;
	if (!topClient) return;
	topClient.callIn(assign, top.location, [
		routeHTML(new StompURL(destination, client.url), client.url, client.config),
	]);
}

/**
 * The Sandbox module's: a form of an unsandboxed document, submitted (by
 * `submitter`; the user's own submission when `user`) with a target (its
 * submitter's, its own or its document's base target: `keyword`, as the
 * page wrote it) that may name another window than its own. Aimed at the
 * proxied parent or top, from a frame under the top: a javascript: action
 * runs in that window. Any other is submitted by that window, from a copy
 * of the form made in its document with the form's entry list (the
 * browser builds it once, here, as it would have for the submission this
 * stands in for), so the action is routed as that window's document and
 * the response lands there; a window of another slot (the site pool) is
 * asked to (navigateAcross). `assign` and `submit`: Location's and
 * HTMLFormElement's own. Returns whether it took the submission.
 */
export function submitAimed(
	client: DocumentClient,
	form: HTMLFormElement,
	submitter: HTMLElement | null,
	keyword: string,
	user: boolean,
	assign: (url: string) => void,
	submit: () => void,
): boolean {
	const aimed = client.targetWindow(keyword);
	// the site pool: a window of another slot (see linkAimed)
	const across =
		aimed || !client.sites ? null : siteWindows().targetAcross(client, keyword);
	// a window by that name the browser would not navigate for this frame
	// (DocumentClient namedWindow): the submission is this document's
	// navigation of it, a GET by its URL, a POST by a copy of the form the
	// window submits (Context navigateWindow, which waits for the window's
	// document to be written in: a copy submitted in its shell was taken
	// out of the document, and its navigation aborted, by the
	// document.open() that writes it)
	const named = aimed || across ? null : client.namedWindow?.(keyword);
	if (!aimed && !across && !named) return false;
	const method = (
		submitter?.getAttribute('formmethod') ??
		form.getAttribute('method') ??
		''
	).toLowerCase();
	// (a dialog's form navigates nothing)
	if (method === 'dialog') return false;
	// a form with no action submits to its document
	const destination = new URL(
		String(
			submitter?.getAttribute('formaction') ??
				form.getAttribute('action') ??
				'',
		),
		client.baseHref,
	);
	// what the form's document's form-action refuses is left to the
	// browser, which refuses it as natively (NavigationHint)
	if (
		client
			.pageRefusals('form-action', destination)
			.some(({ policy }) => policy.disposition === 'enforce')
	)
		return false;
	if (destination.protocol === 'javascript:') {
		// (a named window's javascript: action: the browser's, as before)
		if (named) return false;
		if (aimed)
			aimed.client.callIn(assign, aimed.window.location, [
				javascriptIn(client, destination, aimed.client),
			]);
		return true;
	}
	if (!['http:', 'https:'].includes(destination.protocol)) return false;
	// (what the window's navigate event shows of it: the submitter, else
	// the form)
	const source = submitter ?? form;
	if (named) {
		let submission: OtherSubmission | undefined;
		// (the entry list the browser builds: the URL's query for a GET)
		try {
			if (method === 'post')
				submission = formSubmission(client, form, submitter, submit);
			else
				destination.search = new client.global.URLSearchParams(
					new client.global.FormData(form, submitter ?? undefined) as any,
				).toString();
		} catch (error) {
			return method === 'post';
		}
		return !!client.navigateWindow?.(named, destination.href, 'href', {
			...(submission ? { submission } : {}),
			source,
			user,
		});
	}
	// the copy of the form that window submits, or the ask of a window of
	// another slot
	if (aimed) {
		formSubmission(
			client,
			form,
			submitter,
			submit,
		)(aimed.window, aimed.client, destination.href);
		return true;
	}
	const { attributes, entries } = formParts(client, form, submitter);
	navigateAcross(client, across!, {
		kind: 'form',
		action: destination.href,
		attributes,
		entries,
	});
	return true;
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
			`${voucher.originOf(voucher.global.location)}${voucher.directory}${INITIATOR_ROUTE}`,
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
					`${client.originOf(global.location)}${client.directory}${INITIATOR_ROUTE}`,
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

/**
 * The client of `element`'s window, a frame of `client`'s document still on
 * its initial about:blank (one with a freshTo), else null
 */
function blankClient(
	client: DocumentClient,
	element: Element,
): DocumentClient | null {
	const view = frameWindow(element);
	if (!view) return null;
	try {
		const other = (view as unknown as Record<string, unknown>)[
			client.names.client
		] as DocumentClient | undefined;
		return other?.freshTo ? other : null;
	} catch (error) {
		return null;
	}
}

/**
 * `then`, once the page's own listeners had `event` (one may cancel it),
 * as the browser decides a link or a form aimed at a frame: the frame gets
 * its fresh context, still empty, and the browser goes on with the link or
 * form as natively (its ping, its request)
 */
const afterPage = (client: DocumentClient, event: Event, then: () => unknown) =>
	client.global.addEventListener(
		event.type,
		(late) => {
			if (late === event && !event.defaultPrevented) then();
		},
		{ once: true },
	);

/**
 * The IFrame module's: a click on `link` of `client`'s document, aimed by
 * name at `element`, a frame of it (the one that name finds): when the
 * frame is still on its initial about:blank, its fresh context, for a URL
 * of another origin, once the page had the click
 */
export function blankLink(
	client: DocumentClient,
	event: Event,
	link: HTMLAnchorElement | HTMLAreaElement,
	element: Element,
) {
	const target = blankClient(client, element);
	if (!target) return;
	afterPage(client, event, () => {
		let url: URL;
		try {
			url = client.encodingParse(link.getAttribute('href')!, client.baseHref);
		} catch (error) {
			// no URL: the click navigates nothing, here or in the browser
			return;
		}
		target.freshTo!(url, null, true);
	});
}

/**
 * The IFrame module's: a form of `client`'s document submitted by
 * `submitter` (its submit `event`, or none for submit(), which fires none),
 * aimed by name at `element`, a frame of it: when the frame is still on
 * its initial about:blank, its fresh context, for an action of another
 * origin, at once for submit() and once the page had the event otherwise
 */
export function blankSubmission(
	client: DocumentClient,
	form: HTMLFormElement,
	submitter: HTMLButtonElement | HTMLInputElement | null,
	element: Element,
	event: Event | null,
) {
	const target = blankClient(client, element);
	if (!target) return;
	const own = (name: string) => !!submitter?.hasAttribute(name);
	const method = (
		(own('formmethod') ? submitter!.formMethod : form.method) || 'get'
	).toLowerCase();
	if (method !== 'get' && method !== 'post') return;
	const go = () => {
		try {
			const url = new URL(
				own('formaction') ? submitter!.formAction : form.action,
			);
			const data = new client.global.FormData(form, submitter ?? undefined);
			if (method === 'get')
				url.search = new URLSearchParams(
					data as unknown as Record<string, string>,
				).toString();
			// a submission the page's form-action refuses goes nowhere
			// (NavigationHint sends it to a refusal URL, which the browser
			// refuses): the frame keeps its context, as natively
			if (
				client
					.pageRefusals('form-action', url)
					.some(({ policy }) => policy.disposition === 'enforce')
			)
				return;
			target.freshTo!(url, null, true);
		} catch (error) {
			// no URL, or a form the browser cannot build an entry list of
		}
	};
	if (event) afterPage(client, event, go);
	else go();
}
