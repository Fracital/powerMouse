// The site pool's navigations across slots (docs/site-pool.md, "Windows and
// messages"): a link, a form or window.open() a frame aims at `_top` or
// `_parent` when that window shows a document of another slot, and the copy
// of a form a frame submits to its proxied parent or top (of its slot or
// another). A deferred part of the document bundle (./deferredParts.ts): it
// runs only once a page aims a navigation there, or once a frame under this
// window asks it to navigate, never before the page's first script, so its
// top level reads no global.
import type DocumentClient from './Client';
import type { AcrossNavigation } from './Client';
import { siteWindows } from './siteWindows';

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
	if (!aimed) {
		navigateAcross(client, across!, {
			kind: 'form',
			action: destination.href,
			attributes,
			entries,
		});
		return;
	}
	const document = aimed.window.document;
	const copy = copyOf(
		document,
		client.global,
		attributes,
		destination.href,
		entries,
	);
	document.documentElement.append(copy);
	try {
		aimed.client.callIn(submit, copy, []);
	} finally {
		copy.remove();
	}
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
