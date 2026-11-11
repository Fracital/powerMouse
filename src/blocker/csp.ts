// The `$csp=` directives a list adds to a document, as the proxy can carry
// them. The browser applies a policy to the proxy's URLs, where every
// proxied origin is one origin: a directive that names hosts (`script-src
// example.com`) would be judged against routed URLs and block everything, or
// nothing, so only directives whose every source is a keyword, a scheme, a
// nonce, a hash or a wildcard are kept (`worker-src 'none'`, `img-src
// 'none'`, the common shapes in the lists); the rest are dropped.
//
// The proxy runs inside the document it would restrict. Its shell is an
// inline script that loads the inject bundle from the proxy origin, every
// rewritten inline script is inline too, and the inject evaluates its
// rewriter library and the host's hooks from text, so a directive that
// governs scripts is kept only when it still allows all of that
// (`'unsafe-inline'` and `'unsafe-eval'` with no nonce or hash beside them,
// and `*` or `'self'`); the inject's own requests go to the proxy origin, so
// `connect-src` must reach it; and `sandbox` is never carried (a sandboxed
// document has an opaque origin, which no service worker controls). A
// list's policy against workers, frames or images holds; one that would
// stop the page's inline scripts cannot be told apart from one that stops
// the proxy, and is dropped.

const KEYWORD =
	/^'(none|self|unsafe-inline|unsafe-eval|wasm-unsafe-eval|unsafe-hashes|strict-dynamic|report-sample|inline-speculation-rules|nonce-[^']+|sha(256|384|512)-[^']+)'$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:$/i;
/** directives whose values are not source lists */
const PLAIN = new Set([
	'upgrade-insecure-requests',
	'block-all-mixed-content',
	'require-trusted-types-for',
	'trusted-types',
]);
/** directives the proxy itself relies on, or that would refuse its frame or its worker */
const REFUSED = new Set([
	'frame-ancestors',
	'report-uri',
	'report-to',
	'sandbox',
]);
/** the inject's own requests (the sync bridge, its questions to the worker) go to the proxy origin */
const CONNECTS = new Set(['default-src', 'connect-src']);
const reachesSelf = (sources: string[]) =>
	sources.some((source) => ['*', "'self'"].includes(source.toLowerCase()));
/** directives that decide whether the shell and the inject bundle run */
const SCRIPTS = new Set([
	'default-src',
	'script-src',
	'script-src-elem',
	'script-src-attr',
]);
/** sources that turn `'unsafe-inline'` off */
const STRICT = /^'(nonce-|sha(256|384|512)-|strict-dynamic')/i;

/** whether a script directive's sources still let the proxy's shell and bundle run */
function shellRuns(sources: string[]): boolean {
	const lower = sources.map((source) => source.toLowerCase());
	return (
		lower.includes("'unsafe-inline'") &&
		lower.includes("'unsafe-eval'") &&
		!lower.some((source) => STRICT.test(source)) &&
		reachesSelf(lower)
	);
}

/** `directives` (the crate's comma-joined policies) reduced to what the proxy can apply, or null */
export function carriedCsp(directives: string): string | null {
	const kept: string[] = [];
	for (const policy of directives.split(',')) {
		const safe: string[] = [];
		for (const directive of policy.split(';')) {
			const parts = directive.trim().split(/\s+/);
			const name = parts[0]?.toLowerCase();
			if (!name) continue;
			if (REFUSED.has(name)) continue;
			if (PLAIN.has(name)) {
				safe.push(parts.join(' '));
				continue;
			}
			const sources = parts.slice(1);
			if (
				sources.every(
					(source) =>
						source === '*' || KEYWORD.test(source) || SCHEME.test(source),
				) &&
				(!SCRIPTS.has(name) || shellRuns(sources)) &&
				(!CONNECTS.has(name) || reachesSelf(sources))
			)
				safe.push(parts.join(' '));
		}
		if (safe.length) kept.push(safe.join('; '));
	}
	return kept.length ? kept.join(', ') : null;
}
