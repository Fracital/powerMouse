// :visited through the proxy (docs/same-origin-policy.md, "Visited links").
//
// Chrome keeps a link's visited state per link URL, top-level site and
// frame origin (since 136), and a navigation is recorded under the site and
// origin of the document that started it. Through the proxy every link is a
// URL of the proxy's origin in a frame of the proxy's origin under the
// host's page, so to the browser all proxied sites are one partition. The
// link route puts the partition where the browser does look, in the URL:
//
//   <scope>~/<codec(context + ' ' + url)>#fragment
//
// `context` is the frame origin of the document that holds the link, and
// `^<top-level site>` after it when that site is not the origin's own. It
// names no controller and no route kind, so a link reads the same in every
// tab, in a frame and at the top, today and after a restart, exactly when
// Chrome's own key is the same. No document ever lives at a link route: the
// service worker answers it with a redirect to the document's address
// (`<scope><id>/html/<codec(url)>`), and the browser's history, which
// records every URL of a redirect chain under the navigation's own key,
// keeps the link route that a later link of that context will match.
import type GenericCodec from './Codecs';
import { siteOf, type PublicSuffix } from './partition';

/** the segment under the scope that link routes live in: no controller id can be it */
export const LINK_SEGMENT = '~';

export interface VisitedContext {
	/** the origin of the document that holds the link, 'null' for an opaque one */
	frame: string;
	/** its top-level document's site (scheme and registrable domain); the whole context of an opaque document, as opaqueContext made it */
	top: string;
}

const OPAQUE_CONTEXT = /^null:[a-z0-9]+$/;

/**
 * The context of a document of an opaque origin (a sandboxed frame), as
 * the link route spells it: Chrome never shows such a document's link
 * visited and records nothing it visits, so each has a context of its own
 * (`nonce`: a few letters and digits), which no other document's link
 * names.
 */
export const opaqueContext = (nonce: string): string => `null:${nonce}`;

/** a context as the link route spells it: the frame origin, then `^<site>` when the top-level site is not its own */
export function contextText(
	context: VisitedContext,
	publicSuffix: PublicSuffix,
): string {
	if (context.frame === 'null') return context.top;
	return siteOf(context.frame, publicSuffix) === context.top
		? context.frame
		: `${context.frame}^${context.top}`;
}

function parseContext(
	text: string,
	publicSuffix: PublicSuffix,
): VisitedContext | null {
	if (OPAQUE_CONTEXT.test(text)) return { frame: 'null', top: text };
	const split = text.indexOf('^');
	const frame = split === -1 ? text : text.slice(0, split);
	try {
		const origin = new URL(frame);
		if (!/^https?:$/.test(origin.protocol) || origin.origin !== frame)
			return null;
		if (split === -1) return { frame, top: siteOf(origin, publicSuffix) };
		const top = text.slice(split + 1);
		return /^https?:\/\/[^/?#\s^]+$/.test(top) ? { frame, top } : null;
	} catch {
		return null;
	}
}

/**
 * The link route of `url` for a link in a document of `context` (as
 * contextText spells it), under `scope` (a path, or an origin and a path)
 */
export function linkRoute(
	scope: string,
	codec: GenericCodec,
	context: string,
	url: URL,
): string {
	return `${scope}${LINK_SEGMENT}/${codec.encodeStable(
		`${context} ${url.origin}${url.pathname}${url.search}`,
	)}${url.hash}`;
}

/** whether `routed` (a path, or a whole URL) is a link route under `scope` */
export function isLinkRoute(routed: string, scope: string): boolean {
	return routed.startsWith(`${scope}${LINK_SEGMENT}/`);
}

/**
 * The context text and real URL (with the route's fragment) of a link
 * route's part after `<scope>~/`; null when it does not decode with `codec`
 * to one. With linkRoute, the one place a link route meets the codec.
 */
export function decodeLinkRoute(
	rest: string,
	codec: GenericCodec,
): { context: string; url: URL } | null {
	const hashIndex = rest.indexOf('#');
	const encoded = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
	// every codec escapes `?` and `/`: a literal one is not the codec's
	if (/[?/]/.test(encoded)) return null;
	try {
		const decoded = codec.decode(encoded);
		const split = decoded.indexOf(' ');
		if (split === -1) return null;
		const url = new URL(decoded.slice(split + 1));
		if (!/^https?:$/.test(url.protocol)) return null;
		url.hash = hashIndex === -1 ? '' : rest.slice(hashIndex);
		return { context: decoded.slice(0, split), url };
	} catch {
		return null;
	}
}

/**
 * What a link route under `scope` stands for: the context of the link and
 * the real URL, with the route's fragment. Null when `routed` is no link
 * route or does not decode with `codec` to one.
 */
export function parseLinkRoute(
	routed: string,
	codec: GenericCodec,
	scope: string,
	publicSuffix: PublicSuffix,
): { context: VisitedContext; url: URL } | null {
	if (!isLinkRoute(routed, scope)) return null;
	const link = decodeLinkRoute(
		routed.slice(scope.length + LINK_SEGMENT.length + 1),
		codec,
	);
	const context = link && parseContext(link.context, publicSuffix);
	return context ? { context, url: link.url } : null;
}

/** the context a document of `url` has at the top level of its own site */
export function selfContext(
	url: URL,
	publicSuffix: PublicSuffix,
): VisitedContext {
	return { frame: url.origin, top: siteOf(url, publicSuffix) };
}

/**
 * Whether a visit from `context` also counts for the visited URL's own site
 * (Chrome's self-links, components/visitedlink/core/visited_link.cc): the
 * frame origin has to be the origin of the top-level site's own URL, which
 * is the scheme and the registrable domain on the default port. So a click
 * on https://example.com does, one on https://www.example.com or on a port
 * of its own does not (measured, Chrome 152 and 156).
 */
export function makesSelfLink(context: VisitedContext): boolean {
	return context.frame === context.top;
}

export const sameContext = (a: VisitedContext, b: VisitedContext): boolean =>
	a.frame === b.frame && a.top === b.top;
