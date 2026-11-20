// An extension's emulated origin (docs/extensions.md): STomp routes http(s)
// only, and every layer above the transport keys on an http(s) origin, so
// `chrome-extension://<id>/` is served as `https://<id>.invalid/`, a site of
// its own per extension that no real host can be. The service worker answers
// that host from the package store; these map between the two forms.
import { EXTENSION_HOST_SUFFIX } from './types';

const HOST = /^([a-p]{32})\.invalid$/;
const CHROME_URL = /^chrome-extension:\/\/([a-p]{32})(?:\/(.*))?$/i;

/** `https://<id>.invalid` */
export function extensionOrigin(id: string): string {
	return `https://${id}${EXTENSION_HOST_SUFFIX}`;
}

/** the URL of a file of the extension */
export function extensionURL(id: string, path = ''): string {
	const clean = String(path).replace(/^\/+/, '');
	return `${extensionOrigin(id)}/${clean}`;
}

/**
 * The header the worker gives a request to an extension's origin: the
 * origin of the document that asked, which web_accessible_resources'
 * `matches` judge (Chrome judges the request's initiator, which a page's
 * referrer policy does not hide; the transport never sends it on)
 */
export const EXTENSION_INITIATOR = 'x-stomp-extension-initiator';

/** the extension a host is the origin of, or null */
export function extensionOfHost(host: string): string | null {
	return HOST.exec(host)?.[1] ?? null;
}

/** the extension a URL (emulated or chrome-extension:) belongs to, or null */
export function extensionOfURL(url: string): string | null {
	const chrome = CHROME_URL.exec(url);
	if (chrome) return chrome[1].toLowerCase();
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.port === ''
			? extensionOfHost(parsed.hostname)
			: null;
	} catch (error) {
		return null;
	}
}

/** `chrome-extension://<id>/<path>` as the emulated URL; anything else as it is */
export function resolveExtensionURL(url: string): string {
	const chrome = CHROME_URL.exec(url);
	return chrome ? extensionURL(chrome[1].toLowerCase(), chrome[2] ?? '') : url;
}

/** the emulated URL as `chrome-extension://<id>/<path>`, for an address bar; anything else as it is */
export function displayExtensionURL(url: string): string {
	try {
		const parsed = new URL(url);
		const id =
			parsed.protocol === 'https:' ? extensionOfHost(parsed.hostname) : null;
		if (!id) return url;
		return `chrome-extension://${id}${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch (error) {
		return url;
	}
}

/** a path of the extension's, clean: no leading slash, no `..` past the root */
export function cleanPath(path: string): string {
	const parts: string[] = [];
	for (const part of String(path).split(/[?#]/)[0].split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}
