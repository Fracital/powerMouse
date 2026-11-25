// Whether a URL matches a source list of a page's own policy
// (src/csp.ts), as Chrome matches it: its schemes, hosts, ports, paths and
// 'self'. A file apart from src/csp.ts because the document bundle matches
// only where one of the page's policies governs a load or a navigation the
// inject judges itself: there this file is a deferred part
// (src/inject/dom/deferredParts.ts, made at the first such check,
// DocumentClient pageRefusals), and its 1.3 KB are in no document that
// makes none. The service worker and the worker bundles import it as any
// module.
import { LOCAL, NETWORK, SCHEME, type HopPolicy } from './csp';

/** whether `url` is refused by the enforced (`enforce`) or report-only policies of `policies` for `directive`, after a redirect */
export function hopRefusals(
	policies: HopPolicy[],
	directive: string,
	url: URL,
): HopPolicy[] {
	return policies.filter(([name, sources, , self]) => {
		if (name !== directive) return false;
		try {
			return !sourcesMatch(sources, url, new URL(self), true);
		} catch (error) {
			return false;
		}
	});
}

/**
 * Whether a frame-ancestors source list lets a document be framed by an
 * ancestor of `origin` ("null" for an opaque one, which matches nothing);
 * `self`: the framed document's real URL
 */
export function ancestorAllowed(
	sources: string[],
	origin: string,
	self: URL,
): boolean {
	if (origin === 'null') return false;
	try {
		// (an extension's page as the ancestor is judged as any origin)
		const ancestor = new URL(`${origin}/`);
		return sources.some((source) => sourceMatches(source, ancestor, self));
	} catch (error) {
		return false;
	}
}

/** the URL's port, or its scheme's default port (null for a scheme without one) */
function portOf(url: URL): number | null {
	if (url.port) return Number(url.port);
	return (
		{ 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 }[
			url.protocol
		] ?? null
	);
}

/**
 * Whether a source's scheme (`allowed`, no colon) lets a URL of `scheme`
 * through: itself and its secure form (an http: source matches no ws: URL,
 * measured)
 */
function schemeMatches(allowed: string, scheme: string): boolean {
	if (allowed === scheme) return true;
	if (allowed === 'http') return scheme === 'https';
	if (allowed === 'ws') return scheme === 'wss';
	return false;
}

const HOST_SOURCE =
	/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|[^*:/]+)(?::(\*|\d+))?(\/[^?#]*)?$/i;

/**
 * Whether `url` matches the source expression `source` of a policy whose
 * own origin is `self` (the page's real URL), as Chrome matches it; paths
 * are not compared after a redirect. Keywords that are not about URLs
 * (nonces, hashes, 'unsafe-*') match nothing.
 */
export function sourceMatches(
	source: string,
	url: URL,
	self: URL,
	redirected = false,
): boolean {
	const lower = source.toLowerCase();
	const scheme = url.protocol.slice(0, -1);
	if (lower === '*')
		// any network URL, or one of the page's own scheme
		return (
			NETWORK.test(url.protocol) ||
			(scheme === self.protocol.slice(0, -1) && !LOCAL.test(url.protocol))
		);
	if (lower === "'self'") {
		if (self.origin === 'null') return false;
		// the page's own host and port by WebSocket too (CSP3 §6.7.2.6)
		if (
			/^wss?:$/.test(url.protocol) &&
			url.hostname === self.hostname &&
			portOf(url) === portOf(new URL(self.href.replace(/^ws/, 'http'))) &&
			(url.protocol === 'wss:' || self.protocol === 'http:')
		)
			return true;
		return hostSourceMatches(
			self.protocol.slice(0, -1),
			self.hostname,
			self.port || null,
			null,
			url,
			self,
			redirected,
		);
	}
	if (lower.startsWith("'")) return false;
	if (SCHEME.test(lower)) return schemeMatches(lower.slice(0, -1), scheme);
	const match = HOST_SOURCE.exec(source);
	if (!match) return false;
	return hostSourceMatches(
		match[1]?.toLowerCase() ?? null,
		match[2].toLowerCase(),
		match[3] ?? null,
		match[4] ?? null,
		url,
		self,
		redirected,
	);
}

function hostSourceMatches(
	sourceScheme: string | null,
	host: string,
	port: string | null,
	path: string | null,
	url: URL,
	self: URL,
	redirected: boolean,
): boolean {
	const scheme = url.protocol.slice(0, -1);
	// no scheme: the page's own, with its upgrades
	const allowed = sourceScheme ?? self.protocol.slice(0, -1);
	if (!allowed || !schemeMatches(allowed, scheme)) return false;
	const urlHost = url.hostname.toLowerCase();
	if (!urlHost) return false;
	if (host === '*') {
		// any host
	} else if (host.startsWith('*.')) {
		if (!urlHost.endsWith(host.slice(1))) return false;
	} else if (host !== urlHost) return false;
	// no port: the URL's scheme's default; a source's port 80 lets 443 through
	if (port !== '*') {
		const urlPort = portOf(url);
		if (
			port === null
				? urlPort !== portOf(new URL(`${scheme}://x`))
				: urlPort !== Number(port) && !(port === '80' && urlPort === 443)
		)
			return false;
	}
	if (path && !redirected) {
		const decode = (text: string) => {
			try {
				return decodeURIComponent(text);
			} catch (error) {
				return text;
			}
		};
		const wanted = decode(path);
		const actual = decode(url.pathname);
		if (wanted.endsWith('/') ? !actual.startsWith(wanted) : actual !== wanted)
			return false;
	}
	return true;
}

/**
 * An extension's resource (`chrome-extension:` as the page wrote it, or its
 * emulated origin, `https://<id>.invalid`,
 * src/extensions/origin.ts): Chrome lets `chrome-extension:` loads
 * through every page's policy (the scheme bypasses Content Security
 * Policy), so an extension's script a content script adds to a page runs
 * under the page's script-src (measured, Chrome 157)
 */
const EXTENSION_RESOURCE = /^[a-p]{32}\.invalid$/;

/** whether `url` matches a directive's `sources` ('none' alone, or nothing, matches nothing; an extension's resource, everything) */
export function sourcesMatch(
	sources: string[],
	url: URL,
	self: URL,
	redirected = false,
): boolean {
	if (
		url.protocol === 'chrome-extension:' ||
		(url.protocol === 'https:' && EXTENSION_RESOURCE.test(url.hostname))
	)
		return true;
	return sources.some((source) => sourceMatches(source, url, self, redirected));
}
