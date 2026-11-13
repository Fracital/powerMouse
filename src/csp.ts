import { digest } from './sha';

// A proxied page's own Content-Security-Policy, as Chrome reads it and as
// the proxy hands it to the browser (docs/csp.md).
//
// The browser applies a policy to the proxy's URLs, where every proxied
// origin is one origin: a source that names hosts (`img-src
// cdn.example.com`), a network scheme (`https:`), `*` or 'self' would be
// judged against routed URLs. What the browser can judge as the page wrote
// it is everything else: the local schemes (`data:`, `blob:`,
// `filesystem:`, `mediastream:`) and 'none'. So each fetch directive of the
// page's reaches the browser as the directive it governs, with 'self' (the
// proxy origin: every routed load, and every request of the proxy's own)
// and the page's local schemes: a `data:` image, a `blob:` frame or a
// `fetch('data:,')` is refused, reported and seen by the page exactly as
// natively. The rest of each directive (its hosts) is the proxy's to
// enforce.

/** a policy: its directives as the page wrote them (first of each name) */
export interface Policy {
	/** the policy's text as the page wrote it */
	text: string;
	/** `enforce` (Content-Security-Policy) or `report` (Content-Security-Policy-Report-Only) */
	disposition: 'enforce' | 'report';
	/** where the policy came from: a response header, or a <meta> */
	source: 'header' | 'meta';
	/** directive name (lower case) to its sources */
	directives: Map<string, string[]>;
}

/** the directives a <meta> policy cannot carry: the browser ignores them there */
const NOT_IN_META = ['frame-ancestors', 'report-uri', 'sandbox'];

/**
 * The policies of a header value (comma-separated, each one a policy), or
 * of a <meta>'s content (one policy; Chrome splits it on commas too)
 */
export function parsePolicies(
	value: string | null,
	disposition: Policy['disposition'],
	source: Policy['source'],
): Policy[] {
	if (!value) return [];
	const policies: Policy[] = [];
	for (const text of value.split(',')) {
		const directives = new Map<string, string[]>();
		for (const directive of text.split(';')) {
			const tokens = directive.trim().split(/[\t\n\f\r ]+/);
			const name = tokens[0]?.toLowerCase();
			// the first directive of a name counts; later ones are ignored
			if (!name || directives.has(name)) continue;
			if (source === 'meta' && NOT_IN_META.includes(name)) continue;
			directives.set(name, tokens.slice(1));
		}
		if (directives.size)
			policies.push({ text: text.trim(), disposition, source, directives });
	}
	return policies;
}

/** each fetch directive, and the directives it falls back to (CSP3 §6.8.3) */
export const FALLBACK: Record<string, string[]> = {
	'script-src': ['script-src', 'default-src'],
	'style-src': ['style-src', 'default-src'],
	'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
	'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
	'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
	'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
	'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
	'frame-src': ['frame-src', 'child-src', 'default-src'],
	'fenced-frame-src': [
		'fenced-frame-src',
		'frame-src',
		'child-src',
		'default-src',
	],
	'connect-src': ['connect-src', 'default-src'],
	'img-src': ['img-src', 'default-src'],
	'font-src': ['font-src', 'default-src'],
	'media-src': ['media-src', 'default-src'],
	'object-src': ['object-src', 'default-src'],
	'manifest-src': ['manifest-src', 'default-src'],
};

/**
 * The directives the browser judges loads by that reach it from a page's
 * policy (see the top of this file). Scripts and styles are not among them:
 * the proxy's shell and its rewritten inline scripts would be judged too.
 */
export const BROWSER_DIRECTIVES = [
	'connect-src',
	'img-src',
	'font-src',
	'media-src',
	'object-src',
	'frame-src',
	'fenced-frame-src',
	'worker-src',
	'manifest-src',
];

/**
 * The directives whose hosts the service worker applies to a document's
 * requests (src/server/contentPolicies.ts): those the browser judges loads
 * by, but frames (a navigation the parent's inject judges, which knows the
 * frame's embedder). A request one refuses is sent on to REFUSED_URL.
 */
export const WORKER_DIRECTIVES = [
	...BROWSER_DIRECTIVES.filter((directive) => !directive.includes('frame-src')),
	// where the page's list decides by URL alone (hostsApply)
	'script-src-elem',
	'style-src-elem',
];

/**
 * A URL the browser's copy of every page policy refuses for each of
 * BROWSER_DIRECTIVES (it allows only the proxy's origin and local schemes
 * there): where the worker sends a request the page's policy refuses, for
 * the browser to refuse and report. A port no browser connects to: nothing
 * leaves the machine even where no policy refused it after all.
 */
export const REFUSED_URL = 'https://refused.invalid:1/';

/** the directive whose sources decide `effective` in `policy`, or null when none does */
export function governing(
	policy: Policy,
	effective: string,
): { name: string; sources: string[] } | null {
	for (const name of FALLBACK[effective] ?? [effective]) {
		const sources = policy.directives.get(name);
		if (sources) return { name, sources };
	}
	return null;
}

/** the directives whose loads the inject copies to blob: URLs in every document (browserSources) */
export const BLOB_COPIES = ['object-src'];

/** the schemes whose URLs name no host: the browser judges their sources as written */
const LOCAL = /^(data|blob|filesystem|mediastream):$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:$/i;
const NETWORK = /^(https?|wss?):$/i;

/**
 * The sources the browser gets for a fetch directive whose page sources
 * are `sources`: 'self' (every routed load is the proxy origin's, and the
 * proxy enforces their hosts) and the local schemes (and any other
 * non-network scheme) the page allows, as written
 */
export function browserSources(
	sources: string[],
	directive?: string,
): string[] {
	const kept = ["'self'"];
	// the inject's copies of the page's loads are blob: URLs (an object's,
	// which no worker sees): the browser lets them through wherever the page
	// lets any load through, and the inject refuses the page's own blob:
	// loads that its policy refuses
	if (
		directive !== undefined &&
		BLOB_COPIES.includes(directive) &&
		sources.some(
			(source) => source.toLowerCase() !== "'none'" && !LOCAL.test(source),
		)
	)
		kept.push('blob:');
	for (const source of sources) {
		const lower = source.toLowerCase();
		if (SCHEME.test(lower) && !NETWORK.test(lower) && !kept.includes(lower))
			kept.push(lower);
	}
	return kept;
}

/**
 * The directives of a document's own navigations that reach the browser
 * as the fetch directives do ('self' and the page's other schemes; no
 * fallback): a <base> and a form submission the page's policy refuses are
 * sent to a refusal URL (DocumentClient.refusalURL), or a form's redirect
 * to REFUSED_URL by the worker, which the browser refuses and reports as
 * natively (a javascript: or mailto: action, which names no host, the
 * browser judges by itself)
 */
export const NAVIGATION_DIRECTIVES = ['base-uri', 'form-action'];

/**
 * The policy the browser applies for `policy` (its text), or null when it
 * has nothing the browser can apply. Each directive the browser judges
 * loads by is written out for itself (a page's default-src or child-src
 * would otherwise reach directives the proxy relies on), the rest are left
 * out: report-uri and report-to (the browser would post the proxy's URLs),
 * and what the proxy applies another way.
 */
export function browserPolicy(policy: Policy): string | null {
	const directives: string[] = [];
	for (const effective of BROWSER_DIRECTIVES) {
		const governed = governing(policy, effective);
		if (governed)
			directives.push(
				`${effective} ${browserSources(governed.sources, effective).join(' ')}`,
			);
	}
	// The browser never enforces the page's script-src, style-src or Trusted
	// Types: every proxied document runs STomp's own inject scripts and its
	// inline bootstrap, and STomp's rewriter and hooks make code from strings
	// and write HTML and script sinks; a browser policy that governs those
	// cannot be told to spare STomp's own code from the page's (a nonce or
	// hash on the real injected element does not hold on the live proxy
	// origin, and a Trusted Types policy refuses STomp's Function and
	// outerHTML). The inject enforces the page's script, style and Trusted
	// Types against the page's code alone (docs/csp.md).
	for (const name of NAVIGATION_DIRECTIVES) {
		const sources = policy.directives.get(name);
		// (one that allows nothing is the browser's as written: it refuses
		// the proxy's own URLs too, and its <base> or form with them)
		if (sources)
			directives.push(
				sources.every((source) => source.toLowerCase() === "'none'")
					? `${name} 'none'`
					: `${name} ${browserSources(sources).join(' ')}`,
			);
	}
	return directives.length ? directives.join('; ') : null;
}

/** the Trusted Types directives (browserPolicy) */
const TRUSTED_TYPES = ['require-trusted-types-for', 'trusted-types'];

/**
 * How the page's `policies` require Trusted Types of a sink: `enforce`
 * where one enforced policy does, `report` where only report-only ones
 * do, else null
 */
export function trustedTypesRequired(
	policies: Policy[],
): Policy['disposition'] | null {
	let found: Policy['disposition'] | null = null;
	for (const policy of policies)
		if (
			policy.directives
				.get('require-trusted-types-for')
				?.some((source) => source.toLowerCase() === "'script'")
		) {
			if (policy.disposition === 'enforce') return 'enforce';
			found = 'report';
		}
	return found;
}

/** what the browser's script and style directives name of the proxy's own (codeSources) */
export interface CodeOptions {
	/** the nonce the document's shell and the inject's own scripts carry */
	nonce: string;
	/** the URLs a worker of the document imports the inject from (importScripts takes no nonce) */
	assets: string[];
	/** the name of the inject's own Trusted Types policy (ScriptFacts.tt) */
	tt?: string;
}

/**
 * The directives the browser judges scripts and styles by, each written
 * out for itself; script-src stands for what only it decides of them
 * (eval, WebAssembly compilation), as the page wrote it
 */
export const CODE_DIRECTIVES = [
	'script-src-elem',
	'script-src-attr',
	'style-src-elem',
	'style-src-attr',
	'script-src',
];

const NONCE_OR_HASH = /^'(nonce-|sha(256|384|512)-)/i;
const KEPT_KEYWORDS: Record<string, RegExp> = {
	attr: /^'(unsafe-inline|unsafe-hashes|report-sample|sha(256|384|512)-[^']+)'$/i,
	elem: /^'(unsafe-inline|strict-dynamic|report-sample|inline-speculation-rules|nonce-[^']+|sha(256|384|512)-[^']+)'$/i,
};

/** whether a script or style directive's `sources` lets the page's inline code run without a nonce or hash */
export function inlineAllowed(sources: string[], directive: string): boolean {
	const lower = sources.map((source) => source.toLowerCase());
	return (
		lower.includes("'unsafe-inline'") &&
		!sources.some((source) => NONCE_OR_HASH.test(source)) &&
		!(directive.startsWith('script') && lower.includes("'strict-dynamic'"))
	);
}

/** whether `sources` names anything by its URL ('self', a host, a network scheme, `*`) */
function namesURLs(sources: string[]): boolean {
	return sources.some((source) => {
		const lower = source.toLowerCase();
		return (
			lower === "'self'" ||
			lower === '*' ||
			NETWORK.test(lower) ||
			(!lower.startsWith("'") && !SCHEME.test(lower))
		);
	});
}

/**
 * Whether the hosts of a script or style directive's `sources` are the
 * worker's to apply to the document's requests: a list that lets a load
 * through by a nonce, a hash or 'strict-dynamic' judges it by its element,
 * which the worker never sees (the inject gives a load the page's policy
 * allows by its host the document's nonce, codeSources)
 */
export function hostsApply(sources: string[]): boolean {
	return (
		!sources.some((source) => NONCE_OR_HASH.test(source)) &&
		!sources.some((source) => source.toLowerCase() === "'strict-dynamic'")
	);
}

/** what `codeAllows` is asked of a piece of the page's own code */
export interface CodeItem {
	/** the real URL of an external script or style, or null for inline code */
	url?: URL | null;
	/** the page's own text of an inline script, style, handler or eval (for a hash) */
	text?: string | null;
	/** a script or style element's nonce attribute, as the page set it */
	nonce?: string | null;
	/** an external script's integrity attribute */
	integrity?: string | null;
	/** what 'self' means (the real URL of the document whose policy it is) */
	self?: URL;
	/** code made from a string that WebAssembly compilation allows under 'wasm-unsafe-eval' */
	wasm?: boolean;
	/** the element is the parser's or a document.write's (not DOM-inserted): 'strict-dynamic' does not propagate to it */
	parser?: boolean;
}

/**
 * Whether a script or style directive's `sources` let a specific piece of
 * the page's own code run, refuse or report, as Chrome judges it (measured,
 * Chrome 152 and 156). The browser never gets the page's script-src,
 * style-src or Trusted Types (browserPolicy); the inject enforces them
 * against the page's own code with this. `directive` is the effective
 * directive (CODE_DIRECTIVES); `script-src`/`style-src` stand for code made
 * from a string (eval, the Function constructor, a string timer, WebAssembly
 * compilation).
 */
export function codeAllows(
	sources: string[],
	directive: string,
	item: CodeItem = {},
): boolean {
	const lower = sources.map((source) => source.toLowerCase());
	// code made from a string: only 'unsafe-eval' (and 'wasm-unsafe-eval' for
	// WebAssembly compilation) lets it run
	if (directive === 'script-src' || directive === 'style-src') {
		if (lower.includes("'unsafe-eval'")) return true;
		return !!item.wasm && lower.includes("'wasm-unsafe-eval'");
	}
	const attr = directive.endsWith('-attr');
	const script = directive.startsWith('script');
	const { url = null, text = null, nonce = null, self } = item;
	// 'strict-dynamic' (script-src-elem only): a script the page inserts
	// through the DOM is let through whether inline or external (trust
	// propagates from the running script), host sources and 'unsafe-inline'
	// are ignored, and the parser's and document.write's need a nonce or hash
	if (script && !attr && lower.includes("'strict-dynamic'")) {
		if (!item.parser) return true;
		if (nonce && sources.includes(`'nonce-${nonce}'`)) return true;
		if (url === null) return text !== null && hashMatches(sources, text);
		return !!item.integrity && integrityMatches(sources, item.integrity);
	}
	if (url === null) {
		// inline: a <script>/<style>'s text, or a handler/style attribute
		if (!attr && nonce && sources.includes(`'nonce-${nonce}'`)) return true;
		if (inlineAllowed(sources, directive)) return true;
		if (text === null) return false;
		// a handler or style attribute is let through by its hash only with
		// 'unsafe-hashes'; a script or style element's by its hash alone
		if (attr)
			return lower.includes("'unsafe-hashes'") && hashMatches(sources, text);
		return hashMatches(sources, text);
	}
	// an external script or style, named by its URL
	if (nonce && sources.includes(`'nonce-${nonce}'`)) return true;
	if (script && item.integrity && integrityMatches(sources, item.integrity))
		return true;
	return sourcesMatch(sources, url, self ?? url);
}

/** whether any of `policies` governs scripts or styles (the inject enforces those against the page's code) */
export function enforcesCode(policies: Policy[]): boolean {
	return policies.some((policy) =>
		CODE_DIRECTIVES.some((directive) => governing(policy, directive) !== null),
	);
}

/**
 * The sources the browser gets for a script or style directive whose page
 * sources are `sources`. The page's keywords, nonces, hashes and local
 * schemes are kept as written, so the browser judges the page's inline
 * code, its nonces, 'strict-dynamic' and eval itself. The proxy's own
 * scripts (the shell, the inject's) carry the document's nonce, given
 * wherever the page's inline code does not run without one (a nonce would
 * turn 'unsafe-inline' off). 'self' (every routed load) is given where the
 * page names URLs and nothing else decides by the element (the worker
 * applies the hosts), or where inline code runs (the inject bundle loads
 * by URL); elsewhere a load the page's policy allows by its host carries
 * the nonce (the inject gives it). A worker of the document imports the
 * inject by URL, which takes no nonce.
 */
export function codeSources(
	sources: string[],
	directive: string,
	{ nonce, assets }: CodeOptions,
): string[] {
	const kind = directive.endsWith('-attr') ? 'attr' : 'elem';
	const kept: string[] = [];
	for (const source of sources) {
		const lower = source.toLowerCase();
		if (KEPT_KEYWORDS[kind].test(source)) kept.push(source);
		else if (
			kind === 'elem' &&
			SCHEME.test(lower) &&
			!NETWORK.test(lower) &&
			!kept.includes(lower)
		)
			kept.push(lower);
	}
	if (kind === 'attr') return kept;
	const inline = inlineAllowed(sources, directive);
	const byURL = inline || (namesURLs(sources) && hostsApply(sources));
	if (!inline) kept.push(`'nonce-${nonce}'`);
	if (byURL) kept.push("'self'");
	else if (directive === 'script-src-elem') kept.push(...assets);
	return kept;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const NAMED_REFUSAL = '.u.refused.invalid';

/**
 * A URL like REFUSED_URL whose host names `url` (its origin alone when the
 * whole does not fit in a host name): where the worker sends a frame's
 * redirect its parent's frame-src refuses. Chrome names a refused
 * navigation by the URL it refused, its origin only when it is another
 * origin than the policy's document's, and the inject reads the host back
 * (refusalNamed) as the page's URL.
 */
export function namedRefusal(url: string): string {
	const encode = (text: string) => {
		let bits = 0;
		let value = 0;
		let out = '';
		for (const byte of new TextEncoder().encode(text)) {
			value = (value << 8) | byte;
			bits += 8;
			while (bits >= 5) {
				out += BASE32[(value >>> (bits - 5)) & 31];
				bits -= 5;
			}
		}
		if (bits) out += BASE32[(value << (5 - bits)) & 31];
		return out;
	};
	let name = encode(url.replace(/#.*$/s, ''));
	if (name.length > 220) name = encode(new URL(url).origin);
	return `https://${name.replace(/.{1,60}/g, '$&.').slice(0, -1)}${NAMED_REFUSAL}:1/`;
}

/** the URL a host of namedRefusal's names, or null for another host */
export function refusalNamed(host: string): string | null {
	if (!host.endsWith(NAMED_REFUSAL)) return null;
	const name = host.slice(0, -NAMED_REFUSAL.length).replace(/\./g, '');
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of name) {
		const index = BASE32.indexOf(char);
		if (index === -1) return null;
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	try {
		return new URL(new TextDecoder().decode(new Uint8Array(bytes))).href;
	} catch (error) {
		return null;
	}
}

/**
 * A policy of a document's that judges the later hops of a navigation it
 * started (a form's form-action, a frame's parent's frame-src), as the
 * worker is told it (NavigationHintMessage `csp`): the directive, its
 * sources, the disposition, and the real URL of the document whose policy
 * it is ('self')
 */
export type HopPolicy = [string, string[], Policy['disposition'], string];

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
		return sourcesMatch(sources, new URL(`${origin}/`), self);
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

/** whether `url` matches a directive's `sources` ('none' alone, or nothing, matches nothing) */
export function sourcesMatch(
	sources: string[],
	url: URL,
	self: URL,
	redirected = false,
): boolean {
	return sources.some((source) => sourceMatches(source, url, self, redirected));
}

/**
 * `text` (a browser policy) with a mark of its own: an unused scheme
 * source in its first directive, which matches nothing and makes the text
 * one the inject can name the page's policy by when the browser reports it
 * (two page policies can come out the same for the browser)
 */
export function markedPolicy(text: string, mark: string): string {
	// (in a directive of 'none' the mark would void it, and Chrome says so:
	// one of sources takes it where there is one)
	const directives = text.split('; ');
	const index = Math.max(
		0,
		directives.findIndex((directive) => !directive.endsWith(" 'none'")),
	);
	directives[index] += ` ${mark}:`;
	return directives.join('; ');
}

/**
 * A policy the browser applies (its marked text, empty when it gets
 * nothing of it), the page's text it stands for, and its disposition
 */
export type PolicyText = [string, string, Policy['disposition']];

/**
 * Whether the browser refuses a URL of `scheme` (`data:`) for
 * `directive` under any of `texts` (browser policies, each refusing or
 * reporting it)
 */
export function browserRefuses(
	texts: string[],
	directive: string,
	scheme: string,
): boolean {
	return texts.some((text) =>
		parsePolicies(text, 'enforce', 'header').some((policy) => {
			const governed = governing(policy, directive);
			return governed !== null && !governed.sources.includes(scheme);
		}),
	);
}

/**
 * The page's policies of a response's `headers` as the browser gets them:
 * the header values (null for none), and each browser policy's text with
 * the page's text it stands for. `mark`: a prefix the policies' marks
 * share (markedPolicy), unique to the document.
 */
export function browserHeaders(
	headers: Headers,
	mark: string,
): {
	enforce: string | null;
	report: string | null;
	texts: PolicyText[];
} {
	const texts: PolicyText[] = [];
	const values = { enforce: [] as string[], report: [] as string[] };
	for (const [name, disposition] of [
		['content-security-policy', 'enforce'],
		['content-security-policy-report-only', 'report'],
	] as const)
		for (const policy of parsePolicies(
			headers.get(name),
			disposition,
			'header',
		)) {
			const text = browserPolicy(policy);
			// a policy the browser gets nothing of is the inject's all the same
			if (text === null) {
				texts.push(['', policy.text, disposition]);
				continue;
			}
			const marked = markedPolicy(text, `${mark}${texts.length}`);
			texts.push([marked, policy.text, disposition]);
			values[disposition].push(marked);
		}
	// A policy's sandbox reaches the browser as a frame's attribute does
	// (realSandbox): what it can enforce while the worker still serves the
	// document and the inject runs in it (modal dialogs, forms, popups,
	// downloads, pointer lock...), each as a policy of its own, which the
	// browser never reports against. The inject emulates the rest
	// (DocumentClient.sandboxFlags).
	for (const policy of parsePolicies(
		headers.get('content-security-policy'),
		'enforce',
		'header',
	)) {
		const tokens = policy.directives.get('sandbox');
		if (tokens) values.enforce.push(`sandbox ${realSandbox(tokens.join(' '))}`);
	}
	return {
		enforce: values.enforce.length ? values.enforce.join(', ') : null,
		report: values.report.length ? values.report.join(', ') : null,
		texts,
	};
}

/**
 * The sandbox flags of `policies`' `sandbox` directives (lower case), each
 * narrowing the others, or null when none has one. Only an enforced header
 * policy sandboxes its document: Chrome ignores the directive in a meta and
 * in a report-only policy.
 */
export function policySandbox(policies: Policy[]): Set<string> | null {
	let flags: Set<string> | null = null;
	for (const policy of policies) {
		if (policy.disposition !== 'enforce' || policy.source !== 'header')
			continue;
		const tokens = policy.directives.get('sandbox');
		if (!tokens) continue;
		const own = sandboxTokens(tokens.join(' '));
		const known: Set<string> | null = flags;
		flags = known
			? new Set([...known].filter((token: string) => own.has(token)))
			: own;
	}
	return flags;
}

/** the tokens of a sandbox value, as the browser parses them (ASCII case-insensitive) */
export function sandboxTokens(value: string): Set<string> {
	return new Set(
		value
			.split(/[\t\n\f\r ]+/)
			.filter((token) => token !== '')
			.map((token) => token.toLowerCase()),
	);
}

/** the flags the inject enforces itself, never left to the browser (src/inject/dom/sandbox.ts) */
const EMULATED = [
	'allow-top-navigation',
	'allow-top-navigation-by-user-activation',
	'allow-top-navigation-to-custom-protocols',
];
/** the flags the browser's sandbox always has, so the worker serves the document and the inject runs */
const NEEDED = ['allow-same-origin', 'allow-scripts'];

/**
 * The sandbox the browser applies for a page's `value` (a frame's
 * attribute, a policy's directive): the page's flags but the top
 * navigation ones, with allow-same-origin and allow-scripts
 * (src/inject/dom/sandbox.ts)
 */
export function realSandbox(value: string): string {
	const tokens = [...sandboxTokens(value)].filter(
		(token) => !EMULATED.includes(token) && !NEEDED.includes(token),
	);
	return [...tokens, ...NEEDED].join(' ');
}

/** a prefix for the marks of one document's policies (markedPolicy): a scheme name no page uses */
export function policyMark(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return `p${[...bytes].map((byte) => byte.toString(36)).join('')}-`;
}

/** whether one of `sources` is a hash of `text` (its UTF-8 bytes; base64 or base64url) */
export function hashMatches(sources: string[], text: string): boolean {
	const hashes = sources.filter((source) =>
		/^'sha(256|384|512)-/i.test(source),
	);
	if (!hashes.length) return false;
	const made = new Map<string, string>();
	return hashes.some((source) => {
		const [, algorithm, value] = /^'(sha256|sha384|sha512)-([^']*)'$/i.exec(
			source,
		) ?? ['', '', ''];
		if (!algorithm) return false;
		const name = algorithm.toLowerCase() as 'sha256' | 'sha384' | 'sha512';
		if (!made.has(name)) made.set(name, digest(name, text));
		return made.get(name) === base64Standard(value);
	});
}

/** whether one of `sources` is a hash an `integrity` attribute's metadata names */
export function integrityMatches(
	sources: string[],
	integrity: string,
): boolean {
	const wanted = new Set(
		sources
			.map((source) => /^'(sha256|sha384|sha512)-([^']*)'$/i.exec(source))
			.filter((match) => match !== null)
			.map(
				(match) => `${match![1].toLowerCase()}-${base64Standard(match![2])}`,
			),
	);
	return integrity
		.split(/\s+/)
		.map((part) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)/i.exec(part))
		.some(
			(match) =>
				match !== null &&
				wanted.has(`${match[1].toLowerCase()}-${base64Standard(match[2])}`),
		);
}

/** a base64url value as base64, padded */
function base64Standard(value: string): string {
	const plain = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	return plain + '='.repeat((4 - (plain.length % 4)) % 4);
}

/** a nonce for the proxy's own scripts in one document (codeSources) */
export function policyNonce(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

/**
 * Whether code made from a string runs under all of `texts` (browser
 * policies): none refuses (or reports) it. Where one does, the inject makes
 * its own code with a script that carries the document's nonce.
 */
export function browserEvaluates(texts: string[]): boolean {
	return !texts.some((text) =>
		parsePolicies(text, 'enforce', 'header').some((policy) => {
			const governed = governing(policy, 'script-src');
			return (
				governed !== null &&
				!governed.sources.some((source) => /^'unsafe-eval'$/i.test(source))
			);
		}),
	);
}

/** what the shell tells the client of its document's script policy (CSP_FACTS) */
export interface ScriptFacts {
	/** the nonce the proxy's own inline scripts carry, when a browser policy names one */
	nonce?: string;
	/**
	 * Whether the shell's scripts that load by URL (the inject bundle, the
	 * rewriter library) carry it too: only where a policy lets no script
	 * through by URL ('strict-dynamic'), since a script's nonce is part of
	 * what V8 keys its compiled code by, and every frame would compile its
	 * own copy of the bundle (measured, frame-cost)
	 */
	loadsByNonce?: boolean;
	/** false when a policy refuses code made from a string (browserEvaluates) */
	evaluates: boolean;
	/**
	 * Whether the page's own policy governs scripts or styles, so the inject
	 * enforces it against the page's code (the browser never gets those
	 * directives, browserPolicy). A hint from the shell; the inject's live
	 * check of pagePolicies() (metas included) is what decides.
	 */
	code?: boolean;
	/**
	 * The name of the inject's own Trusted Types policy. Never set in stage 2:
	 * the inject's own writes carry no trusted value (the browser enforces no
	 * Trusted Types of the page's, so STomp is never judged), so this would
	 * only activate the inject's own policy needlessly (src/inject/trusted.ts).
	 */
	tt?: string;
	/**
	 * Whether the page's own policy has any Trusted Types directive, so the
	 * inject enforces it against the page's own sinks and policy names
	 * (src/inject/modules/TrustedTypes.ts); the live pagePolicies() check
	 * (metas included) is what decides each case.
	 */
	ttActive?: boolean;
	/** how the page's policy requires Trusted Types of a sink (enforce/report), from its require-trusted-types-for */
	rtt?: Policy['disposition'];
	/** a worker's: the policy of that name its bootstrap made (src/inject/trusted.ts) */
	policy?: unknown;
}

/**
 * The script facts of a document whose browser policies are `texts`, whose
 * nonce is `nonce`, and whose own policies (headers' and the head's metas')
 * are `pagePolicies`
 */
export function scriptFacts(
	_texts: string[],
	_nonce: string,
	pagePolicies: Policy[] = [],
): ScriptFacts {
	// the browser enforces no script policy of the page's (browserPolicy), so
	// STomp's own scripts carry no nonce and its code always evaluates; the
	// inject enforces the page's script, style and Trusted Types directives
	// against the page's own code and sinks (dom/Client.ts), where its policy
	// governs them. `tt` is never set: the inject's own writes carry no
	// trusted value (STomp is never judged), so its own policy stays dormant.
	const facts: ScriptFacts = { evaluates: true };
	if (enforcesCode(pagePolicies)) facts.code = true;
	if (
		pagePolicies.some((policy) =>
			TRUSTED_TYPES.some((name) => policy.directives.has(name)),
		)
	) {
		facts.ttActive = true;
		const rtt = trustedTypesRequired(pagePolicies);
		if (rtt) facts.rtt = rtt;
	}
	return facts;
}
