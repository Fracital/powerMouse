// The parts of the CSS rewriter that need no parser: the route of a
// stylesheet and the url() routing a regex can do. The inject's core uses
// these on every style it touches; modifyCSS (rewriteCSS.ts, with css-tree)
// is reached through src/rewriters.ts.
import { rewriter } from './rewriters';
import { createDataURI, parseDataURI, routeBinary, routeURL } from './routeURL';
import StompURL from './StompURL';

export function routeCSS(resource: StompURL, url: StompURL) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			resource.url.pathname + resource.url.search,
		);
		return createDataURI({
			mime,
			data: rewriter('modifyCSS')(data, url),
			attributes,
		});
	}

	return routeURL('css', resource);
}

export function preserveValue(url: string, value: string) {
	{
		const hashi = url.indexOf('#');
		if (hashi !== -1) {
			url = url.slice(0, hashi);
		}
	}

	return `${url}#${value}`;
}

function restoreValue(url: string) {
	const hashi = url.indexOf('#');

	if (hashi === -1) {
		throw new Error('Invalid value URL');
	}

	// the browser percent-encodes the quotes of a serialised url() token
	const token = url.slice(hashi + 1);
	try {
		return decodeURIComponent(token);
	} catch (error) {
		return token;
	}
}

const RAW_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

/**
 * The page's URL from a value that may already be routed: a routed url()
 * keeps the original token after '#', which the browser serialises with
 * percent-encoded quotes. Rewriting is idempotent because of this, so text
 * rewritten before parsing and rules rewritten again in the CSSOM agree.
 */
export function originalOf(
	target: string,
): { url: string; token: string } | null {
	const hash = target.indexOf('#url(');
	if (hash === -1) return null;
	let token = target.slice(hash + 1);
	try {
		token = decodeURIComponent(token);
	} catch (error) {
		// not percent-encoded
	}
	const match = /^url\(\s*(['"]?)(.*?)\1\s*\)$/s.exec(token);
	return match ? { url: match[2], token } : null;
}

/**
 * Route every url() in a raw CSS value (a single declaration value, a custom
 * property, or anything css-tree can't parse) through the binary route.
 */
export function rewriteCSSValueURLs(value: string, url: StompURL): string {
	return value.replace(RAW_URL, (match, quote, target) => {
		try {
			const routed = originalOf(target);
			const original = routed?.url ?? target;
			const resolved = new StompURL(new URL(original, url.toString()), url);
			// routed already: the page's token as it was kept, so text routed
			// twice still reads back as the page wrote it
			if (routed) match = routed.token;
			// keep the page's own token after '#', so reads can give it back
			return `url(${JSON.stringify(
				preserveValue(routeBinary(resolved), match),
			)})`;
		} catch (error) {
			return match;
		}
	});
}

// a url() token whose quoted target may hold escapes: a Typed OM value
// serialises the routed URL as a CSS string, the quotes of the page's token
// after '#' escaped with backslashes
const QUOTED_URL =
	/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/gs;

/** inverse of rewriteCSSValueURLs for values the page reads back */
export function restoreCSSValueURLs(value: string): string {
	return value.replace(
		QUOTED_URL,
		(match, double?: string, single?: string, bare?: string) => {
			try {
				const quoted = double ?? single;
				return restoreValue(
					quoted === undefined ? bare! : quoted.replace(/\\(.)/gs, '$1'),
				);
			} catch (error) {
				return match;
			}
		},
	);
}
