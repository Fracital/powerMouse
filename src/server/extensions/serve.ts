// What an extension's origin answers (docs/extensions.md "Extension
// pages"): `https://<id>.invalid/<path>` is served from the package store by
// a wrapper around the controller's transport, so an extension page, its
// scripts and its images are proxied loads like any site's and pass through
// the same rewriter, caches and inject; nothing but the bytes' source
// differs. The background of a manifest that lists scripts gets the page
// Chrome generates for it, and an MV3 service worker a page that runs it
// (its importScripts read ahead, as the runtime cannot block on a load).
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import {
	cleanPath,
	EXTENSION_INITIATOR,
	extensionOfHost,
	extensionURL,
} from '../../extensions/origin';
import {
	BACKGROUND_PAGE,
	IMPORTED_META,
	serviceWorkerPage,
} from '../../extensions/types';
import type { ExtensionRegistry, Loaded } from './registry';
import { files, mimeOf } from './store';

const header = (headers: RawHeaders, name: string) =>
	headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

function answer(
	status: number,
	body: BodyInit | null,
	type = 'text/plain; charset=utf-8',
	more: RawHeaders = [],
): TransferrableResponse {
	return {
		status,
		statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : '',
		headers: [['content-type', type], ['cache-control', 'no-cache'], ...more],
		body: (body ?? '') as TransferrableResponse['body'],
	};
}

const escapeAttribute = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** the page Chrome generates for `background.scripts` */
export function backgroundPage(scripts: string[]): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${scripts
		.map(
			(script) =>
				`<script src="/${escapeAttribute(cleanPath(script))}"></script>`,
		)
		.join('')}</body></html>`;
}

/** one importScripts argument a page can load ahead: a literal, or `chrome.runtime.getURL(<literal>)` (from the root) */
const STATIC_IMPORT =
	/^(?:(['"`])([^'"`$\\]+)\1|(?:chrome|browser)\.runtime\.getURL\(\s*(['"`])([^'"`$\\]+)\3\s*\))$/;

/**
 * The `importScripts('a.js', chrome.runtime.getURL('b.js'))` calls of a
 * classic service worker's source whose every argument is a literal (or a
 * literal getURL, which names a path from the extension's root): the page
 * that emulates it loads them ahead of it, in order. A call with a computed
 * argument is left to the runtime's importScripts, which fetches it then.
 */
export function staticImports(source: string): string[] {
	const found: string[] = [];
	const opening = /\bimportScripts\s*\(/g;
	while (opening.exec(source)) {
		// the call's arguments, to its closing parenthesis
		let depth = 1;
		let at = opening.lastIndex;
		let quote = '';
		const args: string[] = [];
		let start = at;
		for (; at < source.length && depth; at++) {
			const char = source[at];
			if (quote) {
				if (char === '\\') at++;
				else if (char === quote) quote = '';
			} else if (char === '"' || char === "'" || char === '`') quote = char;
			else if (char === '(') depth++;
			else if (char === ')') depth--;
			else if (char === ',' && depth === 1) {
				args.push(source.slice(start, at));
				start = at + 1;
			}
		}
		if (depth) break;
		args.push(source.slice(start, at - 1));
		const paths = args
			.map((arg) => arg.trim())
			.filter(Boolean)
			.map((arg) => {
				const literal = STATIC_IMPORT.exec(arg);
				return literal
					? (literal[2] ?? `/${literal[4].replace(/^\/+/, '')}`)
					: null;
			});
		if (paths.some((path) => path === null)) continue;
		for (const path of paths as string[])
			if (!found.includes(path)) found.push(path);
	}
	return found;
}

/** the page an MV3 service worker runs in: its imports, then itself */
export async function serviceWorkerDocument(loaded: Loaded): Promise<string> {
	const background = loaded.record.manifest.background ?? {};
	const script = cleanPath(background.service_worker ?? '');
	const module = background.type === 'module';
	const imports = module
		? []
		: staticImports((await files.text(loaded.record.id, script)) ?? '')
				.map((path) => {
					try {
						return cleanPath(
							new URL(path, extensionURL(loaded.record.id, script)).pathname,
						);
					} catch (error) {
						return '';
					}
				})
				.filter(Boolean);
	// the imports it loaded, which the runtime's importScripts skips
	const imported = escapeAttribute(JSON.stringify(imports));
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="${IMPORTED_META}" content="${imported}"></head><body>${[
		...imports,
	]
		.map((path) => `<script src="/${escapeAttribute(path)}"></script>`)
		.join(
			'',
		)}<script${module ? ' type="module"' : ''} src="/${escapeAttribute(script)}"></script></body></html>`;
}

/** the origin of the document that asked, from the headers the proxy sends for it */
function initiatorOf(headers: RawHeaders): string | null {
	const told = header(headers, EXTENSION_INITIATOR);
	if (told) return told;
	const origin = header(headers, 'origin');
	if (origin && origin !== 'null') return origin;
	const referer = header(headers, 'referer');
	if (referer)
		try {
			return new URL(referer).origin;
		} catch (error) {
			// no origin to name
		}
	return null;
}

/** answer a request to an extension's origin */
export async function serveExtension(
	registry: ExtensionRegistry,
	url: URL,
	method: string,
	headers: RawHeaders,
): Promise<TransferrableResponse> {
	await registry.ready();
	const id = extensionOfHost(url.hostname)!;
	const loaded = registry.get(id);
	if (!loaded || !loaded.record.enabled)
		return answer(
			404,
			`The extension ${id} is not installed or is turned off.`,
		);
	if (method !== 'GET' && method !== 'HEAD')
		return answer(405, 'An extension serves its files to GET only.');
	const path = cleanPath(decodeURIComponent(url.pathname));
	// a theme runs nothing (themes.ts): its pictures (no SVG, which can
	// script) and its manifest only. Chrome shows a navigation to any of
	// its files and a page's fetch none, as below
	if (
		loaded.theme &&
		!/^(?:image\/(?!svg)|application\/json)/.test(mimeOf(path))
	)
		return answer(404, 'A theme has no pages or scripts.');
	const site = header(headers, 'sec-fetch-site');
	const initiator = initiatorOf(headers);
	const own =
		site === 'same-origin' ||
		(initiator !== null && initiator === url.origin) ||
		// a navigation the user (the host) made: no initiator at all
		site === 'none' ||
		(site === null && initiator === null);
	if (!own && !registry.accessible(loaded, path, initiator))
		// Chrome refuses a page's load of a resource the extension did not
		// expose (ERR_BLOCKED_BY_CLIENT), and the page sees a network error
		return answer(
			404,
			`${path} is not listed in the extension's web_accessible_resources.`,
		);
	const exposed: RawHeaders = own
		? []
		: [
				['access-control-allow-origin', '*'],
				['cross-origin-resource-policy', 'cross-origin'],
			];
	if (path === BACKGROUND_PAGE) {
		const scripts = loaded.record.manifest.background?.scripts ?? [];
		return answer(
			200,
			backgroundPage(scripts),
			'text/html; charset=utf-8',
			exposed,
		);
	}
	const worker = loaded.record.manifest.background?.service_worker;
	if (worker && path === serviceWorkerPage(worker))
		return answer(
			200,
			await serviceWorkerDocument(loaded),
			'text/html; charset=utf-8',
			exposed,
		);
	const file = path ? await files.read(id, path) : null;
	if (!file) return answer(404, `The extension has no file ${path || '/'}.`);
	return answer(
		200,
		method === 'HEAD' ? null : await file.arrayBuffer(),
		file.headers.get('content-type') ?? mimeOf(path),
		exposed,
	);
}

/**
 * The controller's transport, with the extensions' origins answered from the
 * store. Everything else goes to `inner` as it would have; a WebSocket to an
 * extension origin fails, as no server is there.
 */
export function extensionTransport(
	inner: ProxyTransport,
	registry: ExtensionRegistry,
): ProxyTransport {
	const queue = inner as {
		requeue?: (id: string, op: 'cancel' | 'raise') => void;
	};
	const wrapped: ProxyTransport & {
		requeue(id: string, op: 'cancel' | 'raise'): void;
	} = {
		// the request queue's moves (rewrites.ts requeue) are the inner one's
		requeue: (id: string, op: 'cancel' | 'raise') => queue.requeue?.(id, op),
		init: () => inner.init(),
		get ready() {
			return inner.ready;
		},
		set ready(value: boolean) {
			inner.ready = value;
		},
		connect: (
			url,
			protocols,
			requestHeaders,
			onopen,
			onmessage,
			onclose,
			onerror,
		) => {
			if (extensionOfHost(url.hostname)) {
				setTimeout(() => {
					onerror('An extension origin has no WebSocket server.');
					onclose(1006, '');
				});
				return [() => {}, () => {}];
			}
			return inner.connect(
				url,
				protocols,
				requestHeaders,
				onopen,
				onmessage,
				onclose,
				onerror,
			);
		},
		// (an extension origin's request never reaches the transport, whatever
		// its scheme: only https:// is the extension's, the rest fails)
		request: (remote, method, body, headers, signal) =>
			extensionOfHost(remote.hostname)
				? remote.protocol === 'https:'
					? serveExtension(registry, remote, method, headers)
					: Promise.reject(
							new TypeError('An extension origin is served over https only.'),
						)
				: inner.request(remote, method, body, headers, signal),
	};
	return wrapped;
}
