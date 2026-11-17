// The violations and errors a document's client makes for the page's own
// policy (./Client.ts): the securitypolicyviolation events the inject fires
// itself (the browser never gets the page's script-src, style-src or Trusted
// Types directives, src/csp.ts), the Trusted Types refusals of a
// createPolicy and the errors Chrome throws at a refused sink, eval or
// WebAssembly compile. A deferred part of the document bundle
// (./deferredParts.ts): only a page whose policy refuses something reaches
// it, and an event's part is made in the timer that fires it, never while a
// document boots. The decisions stay in the client, so a refusal is made
// whether or not the part can be had.
import type { Policy } from '../../csp';
import type DocumentClient from './Client';

/**
 * Fire a violation of `policy` on `document` as the browser would. Without
 * `documentURI` it is one the page's code or a load makes (named by the
 * page's URL, with its referrer and status 200, its target `node`); with it,
 * a Trusted Types one, named as the client measured it when it was refused.
 * An enforced one reads back trusted (ContentSecurity).
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
	// isTrusted is an own, non-configurable accessor Chrome puts on every
	// event, so it cannot be set here; ContentSecurity hands the page's
	// listeners a view that reads it true for a tagged event
	if (policy.disposition === 'enforce') client.trustedViolations.add(event);
	Reflect.apply(
		(client.global as typeof globalThis).EventTarget.prototype.dispatchEvent,
		document,
		[event],
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
