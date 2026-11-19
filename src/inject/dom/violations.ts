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
import UnrouteModule, {
	unrouteURL,
	type ErrorLocation,
} from '../modules/Unroute';
import { LazyMap, LazyWeakMap, LazyWeakSet } from '../ownCollections';
import { dispatchAsTrusted } from '../violationDispatch';
import type DocumentClient from './Client';
import { parsedBases } from './cloneNode';
import { deferred } from './deferred';

/** where the code that made a violation was, as the page reads it: its sourceFile, lineNumber and columnNumber */
export type Site = [string, number, number];

/**
 * The place each violation names where the browser's named the inject's
 * hook or the shell's markup, and where the inject's own named none
 * (placeViolation)
 */
const violationSites = new LazyWeakMap<object, Site>();
/** the realms whose violations read their place from violationSites */
const placing = new LazyWeakSet<object>();
/**
 * Each client's bases and forms the hooks judged: by the directive and the
 * page's URL (no fragment), where the page's code set, inserted or
 * submitted it, and whether that was the markup (noteBaseSite,
 * noteFormSite)
 */
const notedSites = new LazyWeakMap<object, LazyMap<string, [Site, boolean]>>();

/** `client`'s noted place of `directive`'s judgement of `url` */
const noted = (client: DocumentClient, directive: string, url: string) =>
	notedSites.get(client)?.get(`${directive} ${url.replace(/#.*$/s, '')}`);

/** note a place (notedSites) */
function note(
	client: DocumentClient,
	directive: string,
	url: string,
	place: [Site, boolean],
) {
	let sites = notedSites.get(client);
	if (!sites) notedSites.set(client, (sites = new LazyMap()));
	sites.set(`${directive} ${url.replace(/#.*$/s, '')}`, place);
}

/** a location of Unroute's as a violation names it */
const siteOf = (site: ErrorLocation): Site => [
	sourceName(site.filename),
	site.lineno,
	site.colno,
];
/** the page's URL of each base noted (noteBaseSite), for its insertion */
const notedBases = new LazyWeakMap<Element, string>();
/** where the markup's first base ends, by the parsed base the client read (markupBaseSite) */
const markupSites = new LazyWeakMap<Element, Site>();

/** a script's or a document's URL as a violation names it: no query, no fragment (measured) */
const sourceName = (url: string) => url.replace(/[?#].*$/s, '');

/**
 * The hooks judge a base of the page's URL `url` that the browser may report
 * as refused (a refusal URL, or a route under a base-uri that allows
 * nothing) or the inject reports: natively the violation names the page's
 * code that set its href or inserted it, or, for the markup's, where its
 * start tag ends. The browser's names the hook (or the shell's markup), the
 * inject's nothing, so where it was is noted here for violationShows and
 * dispatchViolation.
 */
export function noteBaseSite(
	client: DocumentClient,
	element: Element,
	url: string,
) {
	const parsed = parsedBases.get(element);
	const markup = parsed && markupSites.get(parsed);
	notedBases.set(element, url);
	// its insertion is where it is judged next (modules/DOMContentHooks.ts)
	client.notesBases ??= (bases) => {
		for (const base of bases) {
			const url = notedBases.get(base);
			if (url !== undefined) noteBaseSite(client, base, url);
		}
	};
	note(
		client,
		'base-uri',
		url,
		markup
			? [markup, true]
			: [siteOf(client.getModule(UnrouteModule)!.callerSite()), false],
	);
}

/**
 * The page submits a form to its URL `url` under a form-action (into the
 * window `target` names, NavigationHint): natively a violation of it, at a
 * redirect's hop too, names the page's code that submitted it (none for a
 * new window, whose navigation is judged later, or for no code), where the
 * browser's names the hook and the inject's nothing
 */
export function noteFormSite(
	client: DocumentClient,
	url: string,
	target: string | null,
) {
	note(client, 'form-action', url, [
		/^_blank$/i.test(target ?? '')
			? ['', 0, 0]
			: siteOf(client.getModule(UnrouteModule)!.callerSite()),
		false,
	]);
}

/**
 * The markup's comments, its raw text elements' contents (where a `<base`
 * is text) and its <base> start tags, in order
 */
const MARKUP_BASES =
	/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1(?=[\s/>])[^>]*>|$)|<base(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/**
 * Where the page's markup's first <base href> ends (the parsed `base` the
 * client read of `markup`): the place Chrome names for its violation, the
 * document's URL and the line and column after its start tag (measured),
 * kept for noteBaseSite
 */
export function markupBaseSite(
	client: DocumentClient,
	markup: string,
	base: Element,
) {
	for (const match of markup.matchAll(MARKUP_BASES)) {
		if (
			match[2] === undefined ||
			!/(?:^|[\s/"'])href(?![^\s/=>])/i.test(match[2])
		)
			continue;
		const lines = markup
			.slice(0, match.index + match[0].length)
			.split(/\r\n?|\n/);
		markupSites.set(base, [
			sourceName(client.url.url.href),
			lines.length,
			lines[lines.length - 1].length + 1,
		]);
		return;
	}
}

/**
 * `event` names `site` as where its code was: its sourceFile, lineNumber
 * and columnNumber read it (their getters hooked in place at a realm's
 * first, as the target's is, ./modules/ContentSecurity.ts)
 */
function placeViolation(client: DocumentClient, event: Event, site: Site) {
	violationSites.set(event, site);
	const global = client.global as typeof globalThis;
	if (placing.has(global)) return;
	placing.add(global);
	const prototype = global.SecurityPolicyViolationEvent.prototype;
	const proxyModule = client.getModule(ProxyModule)!;
	['sourceFile', 'lineNumber', 'columnNumber'].forEach((key, index) => {
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
		if (descriptor?.get)
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const site = violationSites.get(that as object);
					return site ? site[index] : Reflect.apply(target, that, args);
				}),
			});
	});
}

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
	site?: Site,
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
	// (where the page's code set the base or submitted the form)
	const place = site ?? noted(client, directive, blockedURI)?.[0];
	if (place) placeViolation(client, event, place);
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
	source: Function;
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
	const shown = shows(client, natives, event);
	if (shown) {
		try {
			placeNoted(client, natives, event);
		} catch (error) {
			// as the browser names it
		}
		try {
			deliverShown(client, natives, event);
		} catch (error) {
			// the part cannot be had
		}
	}
	return shown;
}

/**
 * A violation of the browser's the page sees goes to its policy's
 * report-uri as the page reads it (the browser has none of the page's,
 * src/csp.ts): its members' getters are hooked (./modules/ContentSecurity.ts)
 */
function deliverShown(
	client: DocumentClient,
	natives: ViolationNatives,
	event: Event,
) {
	const text = Reflect.apply(natives.policy, event, []) as string;
	const entry = client.pagePolicies().find(({ browser }) => browser === text);
	if (
		!entry ||
		(!entry.policy.directives.has('report-uri') &&
			!entry.policy.directives.has('report-to'))
	)
		return;
	const read = event as SecurityPolicyViolationEvent;
	deferred('deliverReport')(client, entry.policy, {
		sourceFile: read.sourceFile,
		lineNumber: read.lineNumber,
		columnNumber: read.columnNumber,
		documentURL: read.documentURI,
		referrer: read.referrer,
		blockedURL: read.blockedURI,
		effectiveDirective: read.effectiveDirective,
		originalPolicy: read.originalPolicy,
		sample: read.sample,
		disposition: read.disposition,
		statusCode: read.statusCode,
	});
}

/**
 * A base-uri or form-action violation of the browser's that names the
 * inject's hook (no script of the page's) or the shell's markup (the
 * document's own route) names where the page's code or markup set the base
 * or submitted the form (noteBaseSite, noteFormSite), as natively; one the
 * page's own code made (an unhooked call) names it as the browser does
 */
function placeNoted(
	client: DocumentClient,
	natives: ViolationNatives,
	event: Event,
) {
	const directive = Reflect.apply(natives.directive, event, []) as string;
	if (directive !== 'base-uri' && directive !== 'form-action') return;
	const source = Reflect.apply(natives.source, event, []) as string;
	const page = source.includes(':') ? unrouteURL(client, source) : null;
	const shell =
		page !== null && sourceName(page) === sourceName(client.url.url.href);
	if (page !== null && !shell) return;
	const blocked = Reflect.apply(natives.blocked, event, []) as string;
	const url = client.refusedURI(blocked)?.url ?? unrouteURL(client, blocked);
	const place = url && noted(client, directive, url);
	if (place && (!shell || place[1])) placeViolation(client, event, place[0]);
}

/** whether one of the browser's violations reaches the page (violationShows) */
function shows(
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
	// the document's referrer as the page reads it (the browser's is the
	// proxy's: the host's page, or a route)
	if (key === 'referrer')
		return client.referrerOf(client.global.document as Document) ?? '';
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
