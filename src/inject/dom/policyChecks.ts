// The page's own Content-Security-Policy as the inject applies it in a
// document (./Client.ts): to the page's own code (its scripts and styles,
// handlers and style attributes, code made from a string, with the nonces
// the browser's copy of the policy needs), to the loads no worker sees (a
// frame, an object), and the violations the browser cannot fire itself (a
// report-only refusal of a load that went out, a Trusted Types refusal). A
// deferred part of the document bundle (./deferred.ts), made the first time
// a document with a policy of the page's needs one of them: a document with
// none never makes it (one whose policy governs code, at its first script
// or style). The
// client's members are what is left in the bundle: each says what it does
// when the part cannot be had (it refuses, or a report is lost).
import {
	BLOB_COPIES,
	governing,
	governsWorkerRequests,
	sourcesMatch,
	trustedTypesRequired,
	type Policy,
	type WorkerPolicies,
} from '../../csp';
import {
	codeAllows,
	hashMatches,
	hostsApply,
	inlineAllowed,
	integrityMatches,
	type CodeItem,
} from '../../cspJudge';
import { proxyBlobURL } from '../../routeURL';
import { digest } from '../../sha';
import ProxyModule from '../modules/Proxy';
import UnrouteModule from '../modules/Unroute';
import type DocumentClient from './Client';
import { nativeSetTimeout, nonceOf } from './Client';
import { deferred } from './deferred';
import { nativeConsoleError, nativeConsoleInfo } from './modules/Context';

/** what Chrome names a refused load of `url` by (a script's, a style's) */
function blockedOf(url: URL): string {
	return url.protocol === 'data:'
		? 'data'
		: url.protocol === 'blob:'
			? 'blob'
			: url.href.replace(/#.*$/s, '');
}

/**
 * A synthesised script/style violation of `policy`, dispatched where the
 * browser would fire it, in a timer, so it does not re-enter the page
 * mid-mutation, its part made there (./violations.ts): the browser never
 * gets the page's script-src/style-src (src/csp.ts browserPolicy), so the
 * inject reports the page's own code itself, read as trusted (csp-scripts
 * compares no isTrusted; the fields it compares are the browser's). A code
 * one without `documentURI`, a Trusted Types one with it.
 */
function dispatchViolation(
	client: DocumentClient,
	policy: Policy,
	directive: string,
	blocked: string,
	sample: string,
	node: Node | null,
	documentURI?: string,
	statusCode?: number,
) {
	const global = client.global as typeof globalThis;
	const Event = global.SecurityPolicyViolationEvent;
	if (typeof Event !== 'function') return;
	const document = global.document;
	// its report, which the page's ReportingObservers have before the event
	// (takeRecords at once)
	const made = client.getModule(UnrouteModule)?.madeReports;
	const proxyModule = client.getModule(ProxyModule);
	if (made && proxyModule)
		try {
			deferred('madeReport').report(
				global,
				proxyModule,
				made,
				{
					sourceFile: null,
					lineNumber: 0,
					columnNumber: 0,
					documentURL: documentURI ?? client.url.url.href.replace(/#.*$/s, ''),
					referrer:
						documentURI === undefined
							? (client.referrerOf(document) ?? '')
							: '',
					blockedURL: blocked,
					effectiveDirective: directive,
					originalPolicy: policy.text,
					sample,
					disposition: policy.disposition,
					statusCode: statusCode ?? 200,
				},
				nativeSetTimeout,
			);
		} catch (error) {
			// the part cannot be had
		}
	nativeSetTimeout(() => {
		try {
			deferred('dispatchViolation')(
				client,
				Event,
				document,
				policy,
				directive,
				blocked,
				sample,
				node,
				documentURI,
				statusCode,
			);
		} catch (error) {
			// the document is gone, or the part cannot be had
		}
	});
}

/**
 * How a violation names the document it is reported from. A loaded http(s)
 * document is named by the page's URL with status 200; a document the
 * browser made of its creator's (about:blank, srcdoc) is named, as Chrome's
 * report strips it, by its bare scheme (e.g. `about`) with status 0.
 */
function violationDocument(client: DocumentClient): {
	documentURI: string;
	statusCode: number;
} {
	try {
		const protocol = client.global.location.protocol;
		if (!/^https?:$/.test(protocol))
			return { documentURI: protocol.replace(/:$/, ''), statusCode: 0 };
	} catch (error) {
		// location unreadable
	}
	return {
		documentURI: client.url.url.href.replace(/#.*$/s, ''),
		statusCode: 200,
	};
}

function dispatchTrusted(
	client: DocumentClient,
	policy: Policy,
	effectiveDirective: string,
	blockedURI: string,
	sample: string,
) {
	const { documentURI, statusCode } = violationDocument(client);
	dispatchViolation(
		client,
		policy,
		effectiveDirective,
		blockedURI,
		sample,
		null,
		documentURI,
		statusCode,
	);
}

/** the page's value at a sink as a violation's sample (Function's without the source's head, measured) */
function sinkSample(sink: string, value: string): string {
	return `${sink}|${value.replace(/^\([^(]*anonymous/, '').slice(0, 40)}`;
}

/** the nonce the page gave a script or style element of its own (not the document's, which the inject gives: ContentSecurity's nonce getter) */
function elementNonce(client: DocumentClient, element: Element): string | null {
	try {
		const own = nonceOf(element);
		return (
			(own !== client.scriptNonce ? own : '') || element.getAttribute('nonce')
		);
	} catch (error) {
		return null;
	}
}

/** the page's integrity of a script (which the browser never gets: the rewritten body is not the one it names) */
function elementIntegrity(element: Element): string | null {
	return (
		(
			element as Element & {
				getAttributeOG?: (name: string) => string | null;
			}
		).getAttributeOG?.('integrity') ?? element.getAttribute('integrity')
	);
}

/**
 * Chrome's console message for a script element `policy` refuses at
 * script-src-elem (`governed`: the directive that governs it), printed by
 * the console's native method, which no page hook sees, as the browser's
 * own (measured, Chrome 157): an inline one's names the hash of the page's
 * text, an external one's its URL
 */
function logScriptRefusal(
	policy: Policy,
	governed: { name: string; sources: string[] },
	item: CodeItem,
) {
	const { name, sources } = governed;
	const directive = sources.length ? `${name} ${sources.join(' ')}` : name;
	const enforced = policy.disposition === 'enforce';
	const action = enforced
		? ' The action has been blocked.'
		: ' The policy is report-only, so the violation has been logged but no further action has been taken.';
	let message: string;
	if (item.url) {
		message = `Loading the script '${item.url.href}' violates the following Content Security Policy directive: "${directive}".${name === 'script-src-elem' ? '' : ` Note that 'script-src-elem' was not explicitly set, so '${name}' is used as a fallback.`}`;
	} else {
		const lower = sources.map((source) => source.toLowerCase());
		message = `Executing inline script violates the following Content Security Policy directive '${directive}'.${
			lower.includes("'unsafe-inline'") &&
			sources.some((source) => /^'(nonce-|sha(256|384|512)-)/i.test(source))
				? " Note that 'unsafe-inline' is ignored if either a hash or nonce value is present in the source list."
				: ` Either the 'unsafe-inline' keyword, a hash ('sha256-${digest('sha256', item.text ?? '')}'), or a nonce ('nonce-...') is required to enable inline execution.${name === 'default-src' ? " Note also that 'script-src' was not explicitly set, so 'default-src' is used as a fallback." : ''}`
		}`;
	}
	try {
		Reflect.apply(
			enforced ? nativeConsoleError : nativeConsoleInfo,
			undefined,
			[message + action],
		);
	} catch (error) {
		// no console
	}
}

/**
 * Whether the page's own policy refuses a piece of its code at `directive`
 * (a script or style element, a handler or style attribute), firing the
 * violation(s) the browser would: true where an enforced policy refuses it,
 * so the caller must not run, load or apply it. `node` is the element the
 * violation's target is (null for the document). `blocked` is the
 * blockedURI Chrome names ('inline', a URL, 'data', 'blob'). `item`'s
 * `sample` is the page's own code, shown where the directive has
 * 'report-sample'.
 */
function codeRefused(
	client: DocumentClient,
	directive: string,
	blocked: string,
	node: Node | null,
	item: CodeItem & { sample?: string | null },
	/**
	 * The load reaches the service worker (an http(s) external script or
	 * style), which reports a report-only refusal itself (reportRefusal): the
	 * inject reports only the enforced ones, so the page sees each once
	 */
	workerReports: boolean,
): boolean {
	let refused = false;
	for (const { policy, self } of client.pagePolicies()) {
		const governed = governing(policy, directive);
		if (!governed) continue;
		if (codeAllows(governed.sources, directive, { ...item, self })) continue;
		if (policy.disposition === 'report' && workerReports) continue;
		const sample =
			item.sample &&
			governed.sources.some(
				(source) => source.toLowerCase() === "'report-sample'",
			)
				? item.sample.slice(0, 40)
				: '';
		dispatchViolation(client, policy, directive, blocked, sample, node);
		if (directive === 'script-src-elem')
			logScriptRefusal(policy, governed, item);
		if (policy.disposition === 'enforce') refused = true;
	}
	return refused;
}

export const policyChecks = {
	/**
	 * Where a load of the document that no worker sees goes instead of `url`
	 * when the page's enforced policy refuses it for `directive`, or null
	 * when it may load (DocumentClient.loadRefusal)
	 */
	loadRefusal(
		client: DocumentClient,
		directive: string,
		url: URL,
		navigation: boolean,
	): string | null {
		const refusing = client
			.pageRefusals(directive, url)
			.some(({ policy }) => policy.disposition === 'enforce');
		if (!refusing) {
			// (a data: or blob: URL's scheme is the browser's to report; a
			// frame's refusal is reported twice, measured)
			client.reportRefusal(directive, url, navigation, navigation ? 2 : 1);
			return null;
		}
		if (url.protocol === 'data:') return url.href;
		if (url.protocol === 'blob:' && !BLOB_COPIES.includes(directive))
			return proxyBlobURL(url.href);
		const blocked =
			url.protocol === 'blob:'
				? 'blob'
				: navigation && url.origin !== client.url.url.origin
					? url.origin
					: url.href.replace(/#.*$/s, '');
		return client.refusalURL('https', url.href, blocked);
	},
	/** what a blob: or data: worker the document makes inherits of its policies (DocumentClient.connectInheritance) */
	connectInheritance(client: DocumentClient): WorkerPolicies | null {
		const policies = client
			.pagePolicies()
			.filter(({ policy }) => governsWorkerRequests(policy))
			.map(({ policy, self }): WorkerPolicies['policies'][number] => [
				policy.text,
				policy.disposition,
				self.href,
			]);
		return policies.length
			? { policies, named: 'blob', browser: client.browserPolicies() }
			: null;
	},
	/** the report-only refusal of an http(s) or ws(s) load that went out (DocumentClient.reportRefusal) */
	reportRefusal(
		client: DocumentClient,
		directive: string,
		url: URL,
		navigation: boolean,
		times: number,
		hop: string | undefined,
	) {
		const refusals = client.pageRefusals(directive, url, hop !== undefined);
		// an enforced refusal is the browser's to report, every policy's
		if (refusals.some(({ policy }) => policy.disposition === 'enforce')) return;
		const reporting = refusals.filter(
			({ policy }) =>
				policy.disposition === 'report' &&
				// a base-uri that allows nothing is the browser's as written
				// (src/csp.ts browserPolicy): its report-only copy refuses the
				// base's route as well, and reports it itself, trusted, as
				// natively (a second event here was one too many)
				!(
					directive === 'base-uri' &&
					policy.directives
						.get('base-uri')!
						.every((source) => source.toLowerCase() === "'none'")
				),
		);
		if (!reporting.length) return;
		const global = client.global as typeof globalThis;
		const Event = global.SecurityPolicyViolationEvent;
		if (typeof Event !== 'function') return;
		const blocked =
			hop ??
			(navigation && url.origin !== client.url.url.origin
				? url.origin
				: url.href.replace(/#.*$/s, ''));
		const document = global.document;
		try {
			const dispatch = deferred('dispatchViolation');
			for (const { policy } of reporting)
				for (let time = 0; time < times; time++)
					dispatch(
						client,
						Event,
						document,
						policy,
						directive,
						blocked,
						'',
						null,
					);
		} catch (error) {
			// the part cannot be had: the load went out all the same
		}
	},
	/** a sink's refusal only report-only policies make: the inject's event (the browser judges its own value) */
	reportTrustedTypes(client: DocumentClient, sink: string, value: string) {
		const sample = sinkSample(sink, value);
		for (const { policy } of client.pagePolicies())
			if (policy.disposition === 'report' && trustedTypesRequired([policy]))
				dispatchTrusted(
					client,
					policy,
					'require-trusted-types-for',
					'trusted-types-sink',
					sample,
				);
	},
	/** a sink's refusal an enforced require-trusted-types-for makes: a trusted violation, as the browser's */
	reportTrustedSink(client: DocumentClient, sink: string, value: string) {
		const sample = sinkSample(sink, value);
		for (const { policy } of client.pagePolicies())
			if (policy.disposition === 'enforce' && trustedTypesRequired([policy])) {
				dispatchTrusted(
					client,
					policy,
					'require-trusted-types-for',
					'trusted-types-sink',
					sample,
				);
				return;
			}
	},
	/** a createPolicy the page's `trusted-types` directive refuses (`policy` is the one that refuses it) */
	reportTrustedPolicy(client: DocumentClient, policy: Policy, name: string) {
		dispatchTrusted(
			client,
			policy,
			'trusted-types',
			'trusted-types-policy',
			name,
		);
	},
	/**
	 * Whether the page's `directive` (script-src-elem, script-src-attr,
	 * style-src-elem or style-src-attr) refuses `element`'s code: its own
	 * text (`code`, inline: a script's or a style's, a handler, a style
	 * attribute) or its real URL (external), firing the violations
	 * (DocumentClient's refuse members). `parser`: the element is the
	 * parser's (the page's markup, a document.write)
	 */
	codeRefused(
		client: DocumentClient,
		element: Element,
		directive: string,
		code: string | URL,
		parser?: boolean,
	): boolean {
		const elem = directive.endsWith('-elem');
		const script = directive.startsWith('script');
		const nonce = elem ? elementNonce(client, element) : undefined;
		if (typeof code === 'string')
			return codeRefused(
				client,
				directive,
				'inline',
				// a script's violation targets it; a style's (and a style
				// attribute's) the document, as Chrome's do
				script ? element : null,
				{ text: code, nonce, parser, sample: code },
				false,
			);
		return codeRefused(
			client,
			directive,
			blockedOf(code),
			null,
			{
				url: code,
				nonce,
				integrity: script ? elementIntegrity(element) : undefined,
				parser,
			},
			// an http(s) load the service worker sees and reports itself
			/^https?:$/.test(code.protocol),
		);
	},
	/**
	 * Whether a script by `url` the page gives a src to before it connects
	 * is refused for now only by enforced policies that take nonces
	 * (DocumentClient.scriptAwaitsNonce); nothing is fired
	 */
	awaitsNonce(client: DocumentClient, element: Element, url: URL): boolean {
		const item = {
			url,
			nonce: elementNonce(client, element),
			integrity: elementIntegrity(element),
			parser: false,
		};
		let refused = false;
		for (const { policy, self } of client.pagePolicies()) {
			if (policy.disposition !== 'enforce') continue;
			const governed = governing(policy, 'script-src-elem');
			if (!governed) continue;
			if (codeAllows(governed.sources, 'script-src-elem', { ...item, self }))
				continue;
			if (!governed.sources.some((source) => /^'nonce-/i.test(source)))
				return false;
			refused = true;
		}
		return refused;
	},
	/**
	 * How the page's own script-src refuses code made from a string, as
	 * Chrome does (measured): fires the violation(s) and returns the error to
	 * throw (DocumentClient.codeEval)
	 */
	codeEval(
		client: DocumentClient,
		kind: 'eval' | 'Function' | 'timer' | 'wasm-compile' | 'wasm-module',
		sample: string,
	): { error: Error | null } | null {
		const wasm = kind === 'wasm-compile' || kind === 'wasm-module';
		const blocked = wasm ? 'wasm-eval' : 'eval';
		let directive: string | null = null;
		for (const { policy } of client.pagePolicies()) {
			const governed = governing(policy, 'script-src');
			if (!governed) continue;
			if (codeAllows(governed.sources, 'script-src', { wasm })) continue;
			const shown =
				sample &&
				governed.sources.some(
					(source) => source.toLowerCase() === "'report-sample'",
				)
					? sample.slice(0, 40)
					: '';
			dispatchViolation(client, policy, 'script-src', blocked, shown, null);
			// the first enforced policy that refuses it names the thrown error
			if (policy.disposition === 'enforce' && directive === null)
				directive = `${governed.name} ${governed.sources.join(' ')}`;
		}
		if (directive === null) return null;
		if (kind === 'timer') return { error: null };
		try {
			return {
				error: deferred('evalError')(
					client.global as typeof globalThis,
					kind,
					directive,
				),
			};
		} catch (error) {
			// the part cannot be had: the code is refused all the same
			return { error: error as Error };
		}
	},
	/**
	 * The nonce (the document's, `nonce`) a script or style element of the
	 * page's gets to be let through by the browser where every enforced
	 * policy of the page's allows it natively but the browser's copy of one
	 * would not: an inline one by the hash of its text (`text`, the page's,
	 * which the rewrite changed), an external one (`url`, the real URL) by
	 * its host where the policy also takes nonces, or by its integrity. Null
	 * where the browser decides as natively. `parser`: the element is the
	 * parser's (the page's markup, a document.write), which 'strict-dynamic'
	 * does not let through (DocumentClient.giveCodeNonce).
	 */
	codeNonce(
		client: DocumentClient,
		element: Element,
		url: URL | null,
		text: string | null,
		parser: boolean,
		nonce: string,
	): string | null {
		const directive =
			(element.localName || '').toLowerCase() === 'script'
				? 'script-src-elem'
				: 'style-src-elem';
		const enforced = client
			.pagePolicies()
			.filter(({ policy }) => policy.disposition === 'enforce');
		if (!enforced.length) return null;
		const own = elementNonce(client, element);
		// (the page's integrity, which the browser never gets: the rewritten
		// body is not the one it names)
		const integrity = url && elementIntegrity(element);
		let needed = false;
		for (const { policy, self } of enforced) {
			const governed = governing(policy, directive);
			if (!governed) continue;
			const { sources } = governed;
			const lower = sources.map((source) => source.toLowerCase());
			const dynamic =
				directive === 'script-src-elem' && lower.includes("'strict-dynamic'");
			if (own && sources.includes(`'nonce-${own}'`)) continue;
			if (dynamic && !parser) continue;
			if (url === null) {
				if (inlineAllowed(sources, directive)) continue;
				if (text !== null && hashMatches(sources, text)) {
					needed = true;
					continue;
				}
				return null;
			}
			if (integrity && integrityMatches(sources, integrity)) {
				needed = true;
				continue;
			}
			if (!dynamic && sourcesMatch(sources, url, self)) {
				// the browser lets it through by 'self', and the worker applies the hosts
				if (!hostsApply(sources)) needed = true;
				continue;
			}
			return null;
		}
		return needed ? nonce : null;
	},
};

export type PolicyChecks = typeof policyChecks;
