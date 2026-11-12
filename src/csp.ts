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
 * The policy the browser applies for `policy` (its text), or null when it
 * has nothing the browser can apply. Each directive the browser judges
 * loads by is written out for itself (a page's default-src or child-src
 * would otherwise reach directives the proxy relies on), the rest are left
 * out: report-uri and report-to (the browser would post the proxy's URLs),
 * and what the proxy applies another way.
 */
export function browserPolicy(
	policy: Policy,
	code?: CodeOptions,
): string | null {
	const directives: string[] = [];
	for (const effective of BROWSER_DIRECTIVES) {
		const governed = governing(policy, effective);
		if (governed)
			directives.push(
				`${effective} ${browserSources(governed.sources, effective).join(' ')}`,
			);
	}
	if (code)
		for (const effective of CODE_DIRECTIVES) {
			const governed = governing(policy, effective);
			if (!governed) continue;
			// what decides eval is the page's own directive as it wrote it
			// (script-src, or default-src): the browser names it in the
			// EvalError and CompileError it throws, and every other load it
			// would judge is judged by a directive of its own here
			if (effective === 'script-src') {
				directives.push([governed.name, ...governed.sources].join(' '));
				continue;
			}
			directives.push(
				`${effective} ${codeSources(governed.sources, effective, code).join(' ')}`.trim(),
			);
		}
	return directives.length ? directives.join('; ') : null;
}

/** what the browser's script and style directives name of the proxy's own (codeSources) */
export interface CodeOptions {
	/** the nonce the document's shell and the inject's own scripts carry */
	nonce: string;
	/** the URLs a worker of the document imports the inject from (importScripts takes no nonce) */
	assets: string[];
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
	const end = text.indexOf(';');
	return end === -1
		? `${text} ${mark}:`
		: `${text.slice(0, end)} ${mark}:${text.slice(end)}`;
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
	code?: CodeOptions,
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
			const text = browserPolicy(policy, code);
			// a policy the browser gets nothing of is the inject's all the same
			if (text === null) {
				texts.push(['', policy.text, disposition]);
				continue;
			}
			const marked = markedPolicy(text, `${mark}${texts.length}`);
			texts.push([marked, policy.text, disposition]);
			values[disposition].push(marked);
		}
	return {
		enforce: values.enforce.length ? values.enforce.join(', ') : null,
		report: values.report.length ? values.report.join(', ') : null,
		texts,
	};
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
}

/** the script facts of a document whose browser policies are `texts` and whose nonce is `nonce` */
export function scriptFacts(texts: string[], nonce: string): ScriptFacts {
	const named = texts.some((text) => text.includes(`'nonce-${nonce}'`));
	return {
		...(named ? { nonce } : {}),
		...(named &&
		texts.some((text) =>
			parsePolicies(text, 'enforce', 'header').some((policy) =>
				governing(policy, 'script-src-elem')?.sources.some(
					(source) => source.toLowerCase() === "'strict-dynamic'",
				),
			),
		)
			? { loadsByNonce: true }
			: {}),
		evaluates: browserEvaluates(texts),
	};
}
