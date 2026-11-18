// The parts of the CSS rewriter that need no parser: the route of a
// stylesheet and the url() routing a regex can do. The inject's core uses
// these on every style it touches; modifyCSS (rewriteCSS.ts, with css-tree)
// is reached through src/rewriters.ts.
import { cssURLValue, isLocalURL, serializeCSSURL } from './cssURL';
import { rewriter } from './rewriters';
import { createDataURI, parseDataURI, routeBinary, routeURL } from './routeURL';
import StompURL from './StompURL';
import { dataBody } from './urlShape';

export function routeCSS(resource: StompURL, url: StompURL) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			dataBody(resource.url),
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

/**
 * The page's url() token kept after '#', serialised as the browser does a
 * property's value, or (`asWritten`, a value the browser keeps as the page
 * wrote it) as the page wrote it
 */
function restoreValue(url: string, asWritten = false) {
	// (the kept token always starts `url(`: a url() the rewriter left, such
	// as a local `url(#gradient)` (isLocalURL), has a `#` of its own)
	const hashi = url.indexOf('#url(');

	if (hashi === -1) {
		throw new Error('Invalid value URL');
	}

	// the browser percent-encodes the quotes of a serialised url() token
	const token = url.slice(hashi + 1);
	let decoded = token;
	try {
		decoded = decodeURIComponent(token);
	} catch (error) {
		// not percent-encoded
	}
	return asWritten ? decoded : serializeCSSURL(decoded);
}

/**
 * One letter of `url` as a page may spell it so that the browser still
 * reads the name (CSS Syntax resolves a name's escapes before comparing
 * it): the letter in either case, a backslash and the letter, or a
 * backslash, up to four zeros and the letter's two hex digits in either
 * case, with the one white space that may end that escape. rust/rwcss
 * (`url_letter_at` in css.rs) matches the same.
 */
const letter = (char: string, hex: string) => {
	const both = `${char}${char.toUpperCase()}`;
	return String.raw`(?:[${both}]|\\[${both}]|\\0{0,4}${hex}(?:\r\n|[ \t\r\n\f])?)`;
};
/** a `url(` however it is spelled (`URL(`, `u\72l(`, `\55RL(`) */
export const URL_NAME = `${letter('u', '[57]5')}${letter('r', '[57]2')}${letter('l', '[46][cC]')}\\(`;
// A quoted target runs to the first same quote a `)` follows, a backslash
// escaping the character after it (the routed value's kept token is a
// JSON string, `#url(\"a.png\")`, so text routed already is found whole);
// failing that, the target runs unquoted to the first `)`.
const LINE = String.raw`\n\r\u2028\u2029`;
const RAW_URL = new RegExp(
	`${URL_NAME}\\s*(?:(['"])((?:\\\\[^${LINE}]|[^\\\\${LINE}])*?)\\1|(.*?))\\s*\\)`,
	'g',
);
/** a quoted target's escapes resolved, as the routed check reads it */
const unescapeTarget = (target: string) =>
	target.replace(/\\([^\n\r\u2028\u2029])/g, '$1');

/** the page's url() token as it is kept after `#`: its name written `url` */
const keptToken = (token: string) =>
	`url(${token.slice(token.indexOf('(') + 1)}`;

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
	return value.replace(
		RAW_URL,
		(match, quote?: string, quoted?: string, bare?: string) => {
			try {
				const target = quoted ?? bare!;
				const routed = originalOf(
					quote && target.includes('\\') ? unescapeTarget(target) : target,
				);
				const original = routed?.url ?? target;
				if (isLocalURL(original)) return match;
				const resolved = new StompURL(new URL(original, url.toString()), url);
				// routed already: the page's token as it was kept, so text routed
				// twice still reads back as the page wrote it
				match = routed ? routed.token : keptToken(match);
				// keep the page's own token after '#', so reads can give it back
				return `url(${JSON.stringify(
					preserveValue(routeBinary(resolved), match),
				)})`;
			} catch (error) {
				return match;
			}
		},
	);
}

// a url() token whose target may hold escapes: a Typed OM value serialises
// the routed URL as a CSS string, the quotes of the page's token after '#'
// escaped with backslashes, and a value the browser keeps as written (an
// @function's `result`) keeps an unquoted url() whose page token has its
// parentheses escaped (`url(route#url\(page\))`)
const QUOTED_URL =
	/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\\]|\\.)*?))\s*\)/gs;

/**
 * inverse of rewriteCSSValueURLs for values the page reads back: the CSSOM's
 * serialization of the url() the page wrote. A computed value's url() is
 * the absolute URL instead, which `resolve` gives for a routed one (its
 * route stands for it, the token after `#url(` keeps its fragment).
 */
export function restoreCSSValueURLs(
	value: string,
	resolve?: (routed: string) => string | null,
	/** every url() as the page wrote it (a custom property's value) */
	asWritten = false,
): string {
	return value.replace(
		QUOTED_URL,
		(match, double?: string, single?: string, bare?: string) => {
			try {
				const text = (double ?? single ?? bare!).replace(/\\(.)/gs, '$1');
				const real = resolve?.(text);
				if (real) return cssURLValue(real);
				// the browser serialises a property's url() quoted; one left
				// bare is in a value it keeps as written
				return restoreValue(text, asWritten || bare !== undefined);
			} catch (error) {
				return match;
			}
		},
	);
}
