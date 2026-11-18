// The violations and errors a document's client makes for the page's own
// policy (./Client.ts): the securitypolicyviolation events the inject fires
// itself (the browser never gets the page's script-src, style-src or Trusted
// Types directives, src/csp.ts), the Trusted Types refusals of a
// createPolicy and the errors Chrome throws at a refused sink, eval or
// WebAssembly compile. A deferred part of the document bundle
// (./deferredParts.ts): only a page whose policy refuses something reaches
// it, and an event's part is made in the timer that fires it, never while a
// document boots. The decisions stay in the client, so a refusal is made
// whether or not the part can be had. The part also reads the browser's own
// violations back as the page sees them (./modules/ContentSecurity.ts), from
// the first one that reaches the page.
import { governing, sourcesMatch, type Policy } from '../../csp';
import ProxyModule from '../modules/Proxy';
import { unrouteURL } from '../modules/Unroute';
import { dispatchAsTrusted } from '../violationDispatch';
import type DocumentClient from './Client';
import { deferred } from './deferred';

/**
 * Fire a violation of `policy` on `document` as the browser would. Without
 * `documentURI` it is one the page's code or a load makes (named by the
 * page's URL, with its referrer and status 200, its target `node`); with it,
 * a Trusted Types one, named as the client measured it when it was refused.
 * It reads back trusted, an enforced or a report-only one, as the browser's
 * does (ContentSecurity).
 */
export function dispatchViolation(
	client: DocumentClient,
	Event: typeof SecurityPolicyViolationEvent,
	document: Document,
	policy: Policy,
	directive: string,
	blockedURI: string,
	sample: string,
	node: Node | null,
	documentURI?: string,
	statusCode = 200,
) {
	const event = new Event('securitypolicyviolation', {
		bubbles: true,
		composed: true,
		blockedURI,
		documentURI: documentURI ?? client.url.url.href.replace(/#.*$/s, ''),
		referrer:
			documentURI === undefined ? (client.referrerOf(document) ?? '') : '',
		violatedDirective: directive,
		effectiveDirective: directive,
		originalPolicy: policy.text,
		disposition: policy.disposition,
		statusCode,
		sample,
	});
	// the browser names an element (an inline script, a handler's element, a
	// style); fire on the document all the same, where the page's listener
	// always hears it, and read the target back there
	if (node && node !== document) {
		client.namesViolationTargets?.();
		client.codeViolationTarget.set(event, node);
	}
	// it reads trusted (../violationDispatch.ts): each listener of the
	// document and its window is handed one view of it, as window.event is
	const global = client.global as typeof globalThis;
	dispatchAsTrusted(
		global,
		client.getModule(ProxyModule)!,
		client.violationViews,
		global.EventTarget.prototype.dispatchEvent,
		document,
		[document, global],
		event,
	);
}

/**
 * How the `trusted-types` directives of `policies` refuse a `createPolicy`
 * of `name` (`made`: the names already created): a refusal for each policy
 * that refuses it, with Chrome's message, or an empty list where every one
 * allows it.
 */
export function refusedTrustedPolicy(
	policies: Policy[],
	name: string,
	made: ReadonlySet<string>,
): { policy: Policy; message: string }[] {
	const factory = "'createPolicy' on 'TrustedTypePolicyFactory'";
	const disallowed = `Failed to execute ${factory}: Policy "${name}" disallowed.`;
	const exists = `Failed to execute ${factory}: Policy with name "${name}" already exists.`;
	const refusals: { policy: Policy; message: string }[] = [];
	for (const policy of policies) {
		const tokens = policy.directives.get('trusted-types')!;
		const lower = tokens.map((token) => token.toLowerCase());
		const names = tokens.filter(
			(token) => !token.startsWith("'") && token !== '*',
		);
		if (
			lower.includes("'none'") ||
			(!tokens.includes('*') && !names.includes(name))
		)
			refusals.push({ policy, message: disallowed });
	}
	if (refusals.length) return refusals;
	// allowed by every policy by name: a duplicate is refused by each policy
	// that does not allow them
	if (made.has(name))
		for (const policy of policies) {
			const lower = policy.directives
				.get('trusted-types')!
				.map((token) => token.toLowerCase());
			if (!lower.includes("'allow-duplicates'"))
				refusals.push({ policy, message: exists });
		}
	return refusals;
}

/** the Trusted Types sink members Chrome names with "execute '<member>'" (not a property set) */
const METHOD_SINKS = [
	'insertAdjacentHTML',
	'setHTMLUnsafe',
	'parseHTMLUnsafe',
	'parseFromString',
	'createContextualFragment',
	'write',
	'writeln',
	'setTimeout',
	'setInterval',
];

/** the exact error Chrome throws at a refused Trusted Types `sink` (src/inject/modules/TrustedTypes.ts) */
export function trustedTypeError(
	global: typeof globalThis,
	sink: string,
	type: string,
	tail: string,
	attribute: boolean,
): Error {
	if (sink === 'eval' || sink === 'Function')
		return new global.EvalError(
			"Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.",
		);
	const space = sink.indexOf(' ');
	const iface = sink.slice(0, space);
	const member = sink.slice(space + 1);
	const operation = attribute
		? "execute 'setAttribute' on 'Element'"
		: sink === 'Worker constructor'
			? "construct 'Worker'"
			: METHOD_SINKS.includes(member)
				? `execute '${member}' on '${iface}'`
				: `set the '${member}' property on '${iface}'`;
	return new global.TypeError(
		`Failed to ${operation}: This document requires '${type}' assignment${tail}`,
	);
}

/**
 * The error Chrome throws at code made from a string that the page's
 * script-src refuses (`directive`: the refusing directive as Chrome quotes
 * it): a CompileError for WebAssembly, an EvalError otherwise (measured).
 */
export function evalError(
	global: typeof globalThis,
	kind: 'eval' | 'Function' | 'wasm-compile' | 'wasm-module',
	directive: string,
): Error {
	if (kind === 'wasm-compile' || kind === 'wasm-module') {
		const CompileError = (
			global as unknown as { WebAssembly: { CompileError: ErrorConstructor } }
		).WebAssembly.CompileError;
		const fn = kind === 'wasm-compile' ? 'compile' : 'Module';
		return new CompileError(
			`WebAssembly.${fn}(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: "${directive}".`,
		);
	}
	return new global.EvalError(
		`Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: ${directive}".\n`,
	);
}

/** the natives ContentSecurity takes at load that reading a violation needs */
export interface ViolationNatives {
	policy: Function;
	blocked: Function;
	directive: Function;
	localName: Function;
	attributeNames: Function;
	getAttribute: Function;
}

/** how much of the code a violation's sample shows (measured) */
const SAMPLE_LENGTH = 40;

/**
 * Whether a trusted violation `event` of the browser's reaches the page
 * (ContentSecurity's capture listener stops it where not). The browser
 * reports a refusal against each of its policies that refuses the URL it
 * was given (a refusal URL, the proxy origin's route of a refused hop): one
 * of the page's that allows the page's URL natively reports nothing.
 */
export function violationShows(
	client: DocumentClient,
	natives: ViolationNatives,
	event: Event,
): boolean {
	try {
		const text = Reflect.apply(natives.policy, event, []) as string;
		const entry = client.pagePolicies().find(({ browser }) => browser === text);
		if (!entry) return true;
		const blocked = Reflect.apply(natives.blocked, event, []) as string;
		const refused = client.refusedURI(blocked);
		const directive = Reflect.apply(natives.directive, event, []) as string;
		// a <base> the hooks write for a moment with the page's own URL
		// (before its route or refusal URL) is none the page made
		if (
			directive === 'base-uri' &&
			!refused &&
			/^https?:/.test(blocked) &&
			unrouteURL(client, blocked) === blocked
		)
			return false;
		const page =
			refused?.url ??
			(blocked.includes(':')
				? unrouteURL(
						client,
						// (the site pool: read on this document's own slot,
						// ../siteEvents.ts onOwnSlot)
						client.sites
							? deferred('onOwnSlot')(client, blocked).value
							: blocked,
					)
				: null);
		if (!page || page === blocked) return true;
		const url = new URL(page);
		const governed = governing(entry.policy, directive);
		if (!governed || !sourcesMatch(governed.sources, url, entry.self))
			return true;
		// allowed here: a refusal URL is this policy's to report only where it
		// refuses the load; a refused route is shown for a refusal no policy
		// explains (a later hop of a redirect, which names the first URL)
		return (
			!refused &&
			!client
				.pageRefusals(directive, url)
				.some(({ policy }) => policy.disposition === 'enforce')
		);
	} catch (error) {
		return true;
	}
}

/** what a violation's URL field `key` that the browser read as `value` (a URL) reads as to the page */
export function violationURL(
	client: DocumentClient,
	value: string,
	key: string,
): string {
	if (key === 'blockedURI') {
		const refused = client.refusedURI(value);
		if (refused !== null) return refused.blocked;
	}
	// (the site pool: a route of another slot is read as this one's, and
	// what is no route there names no URL of the page's)
	const slotted = client.sites
		? deferred('onOwnSlot')(client, value)
		: { value, slot: false };
	const page = unrouteURL(client, slotted.value);
	if (page === null || (slotted.slot && page === slotted.value)) return '';
	// a report names no fragment
	return key === 'blockedURI' ? page.replace(/#.*$/s, '') : page;
}

/**
 * The page's code an inline violation's `sample` (the browser's, of the
 * rewritten code) stands for: the text the page reads back of the script
 * or the style element, or of the attribute of `element` whose rewritten
 * value starts with it (a handler, a style attribute); null for none
 */
export function violationPageCode(
	natives: ViolationNatives,
	target: unknown,
	sample: string,
): string | null {
	const element = target as Element;
	let local: unknown;
	try {
		local = Reflect.apply(natives.localName, element, []);
	} catch (error) {
		// the document, or no node at all
		return null;
	}
	if (local === 'script' || local === 'style')
		return (element.textContent ?? '').slice(0, SAMPLE_LENGTH);
	for (const name of Reflect.apply(
		natives.attributeNames,
		element,
		[],
	) as string[])
		if (
			(name === 'style' || name.startsWith('on')) &&
			(
				(Reflect.apply(natives.getAttribute, element, [name]) as
					string | null) ?? ''
			).startsWith(sample)
		)
			return (element.getAttribute(name) ?? '').slice(0, SAMPLE_LENGTH);
	return null;
}
