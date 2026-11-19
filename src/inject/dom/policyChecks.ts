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
import { keptText, sourceKey } from '../../functionSource';
import { routeHTML } from '../../rewriteHTML';
import { proxyBlobURL } from '../../routeURL';
import { digest } from '../../sha';
import StompURL from '../../StompURL';
import ProxyModule from '../modules/Proxy';
import UnrouteModule from '../modules/Unroute';
import { LazySet, LazyWeakMap } from '../ownCollections';
import type DocumentClient from './Client';
import type { JsNote } from './Client';
import {
	nativeGetAttribute,
	nativeQuerySelectorAll,
	nativeRemoveAttribute,
	nativeSetTimeout,
	nonceOf,
} from './Client';
import { nativeGetAttributeNames, nativeNodeType } from './cloneNode';
import { deferred } from './deferred';
import { nativeContentWindow, nativeFrameElement } from './longEntryNatives';
import { nativeConsoleError, nativeConsoleInfo } from './modules/Context';
import { appliedAttribute, nativeElement } from './modules/DOMHooks';
import { hiddenMutation, markerPrefix } from './modules/MutationObserver';
import type { Site } from './violations';

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
	site?: Site,
	once?: string,
) {
	const global = client.global as typeof globalThis;
	const Event = global.SecurityPolicyViolationEvent;
	if (typeof Event !== 'function') return;
	const document = global.document;
	makeReport(
		client,
		policy,
		directive,
		blocked,
		sample,
		documentURI,
		statusCode,
		site,
		once,
	);
	later(() => {
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
				site,
			);
		} catch (error) {
			// the document is gone, or the part cannot be had
		}
	});
}

/**
 * The violations' reports and events the inject has yet to hand the page,
 * in order (later): a javascript: URL that runs before its first check's
 * timer has them first (runRefused), as Chrome had them as the navigation
 * started
 */
const pendingTasks: (() => void)[] = [];

/** `task` in a timer, unless a flush (runRefused) runs it first */
function later(task: () => void) {
	const run = () => {
		const index = pendingTasks.indexOf(run);
		if (index === -1) return;
		pendingTasks.splice(index, 1);
		task();
	};
	pendingTasks.push(run);
	nativeSetTimeout(run);
}

/**
 * The csp-violation report of a violation the inject makes, which the
 * page's ReportingObservers have before its event (takeRecords at once):
 * where its code was is `site`'s, or none (null, as Chrome's report names
 * no place: measured). A document reports each report once: one that reads
 * as one it made before (the same code refused again at the same place, a
 * script file run twice) is not made again, though its event fires
 * (measured). One with no place is always made, where natively it has a
 * place of its own; one whose report names none natively either is made
 * once (`once`).
 */
const madeBodies = new LazyWeakMap<DocumentClient, LazySet<string>>();
function makeReport(
	client: DocumentClient,
	policy: Policy,
	directive: string,
	blocked: string,
	sample: string,
	documentURI?: string,
	statusCode?: number,
	site?: Site,
	/**
	 * reported once though it has no place, as Chrome's is: a handler's as
	 * the parser inserts it, whose report names none (every one that reads
	 * the same is one), measured
	 */
	once?: string,
) {
	const global = client.global as typeof globalThis;
	const made = client.getModule(UnrouteModule)?.madeReports;
	const proxyModule = client.getModule(ProxyModule);
	if (!made || !proxyModule) return;
	const body = {
		sourceFile: site?.[0] ?? null,
		lineNumber: site?.[1] ?? null,
		columnNumber: site?.[2] ?? null,
		documentURL: documentURI ?? client.url.url.href.replace(/#.*$/s, ''),
		referrer:
			documentURI === undefined
				? (client.referrerOf(global.document) ?? '')
				: '',
		blockedURL: blocked,
		effectiveDirective: directive,
		originalPolicy: policy.text,
		sample,
		disposition: policy.disposition,
		statusCode: statusCode ?? 200,
	};
	if (site || once !== undefined) {
		let bodies = madeBodies.get(client);
		if (!bodies) madeBodies.set(client, (bodies = new LazySet()));
		// (no global of the page's makes the key)
		const key = `${site ?? once}\n${body.documentURL}\n${body.referrer}\n${blocked}\n${directive}\n${policy.text}\n${sample}\n${policy.disposition}\n${body.statusCode}`;
		if (bodies.has(key)) return;
		bodies.add(key);
	}
	try {
		deferred('madeReport').report(
			global,
			proxyModule,
			made,
			body,
			later as typeof setTimeout,
		);
	} catch (error) {
		// the part cannot be had
	}
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
 * The console methods of a window this bundle opened (open()), taken as it
 * opened, before the page had it, with its initial document: that document
 * runs this bundle, and a message of its own is its console's, as natively
 * (openedConsole)
 */
const openedConsoles = new LazyWeakMap<
	object,
	[Function, Function, Document]
>();

/** the native console method a message of `client`'s document is printed with (error where enforced, else info) */
function consoleOf(client: DocumentClient, enforced: boolean): Function {
	const own = openedConsoles.get(client.global);
	return own && own[2] === client.global.document
		? own[enforced ? 0 : 1]
		: enforced
			? nativeConsoleError
			: nativeConsoleInfo;
}

/**
 * Chrome's console message for a script element `policy` refuses at
 * script-src-elem (`governed`: the directive that governs it), a handler at
 * script-src-attr or a javascript: URL (`lead`), printed by the console's
 * native method, which no page hook sees, as the browser's own (measured,
 * Chrome 157): an inline script's names the hash of the page's text, an
 * external one's its URL; a handler's and a URL's no hash, and that a hash
 * takes 'unsafe-hashes'
 */
function logScriptRefusal(
	client: DocumentClient,
	policy: Policy,
	governed: { name: string; sources: string[] },
	item: CodeItem & { lead?: string },
	attr: boolean,
) {
	const lead =
		item.lead ?? (attr ? 'Executing inline event handler' : undefined);
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
		message = `${lead ?? 'Executing inline script'} violates the following Content Security Policy directive '${directive}'.${
			lower.includes("'unsafe-inline'") &&
			sources.some((source) => /^'(nonce-|sha(256|384|512)-)/i.test(source))
				? " Note that 'unsafe-inline' is ignored if either a hash or nonce value is present in the source list."
				: ` Either the 'unsafe-inline' keyword, a hash ('sha256-${lead ? '...' : digest('sha256', item.text ?? '')}'), or a nonce ('nonce-...') is required to enable inline execution.${lead ? " Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present." : ''}${name === 'default-src' ? " Note also that 'script-src' was not explicitly set, so 'default-src' is used as a fallback." : ''}`
		}`;
	}
	try {
		Reflect.apply(consoleOf(client, enforced), undefined, [message + action]);
	} catch (error) {
		// no console
	}
}

/**
 * Where the page's code that called the hook is, as a violation names it
 * (the URL with no query or fragment, measured: ./violations.ts), or none
 * where no script of the page's called it; with `skip`, the code `skip`
 * frames of the page's under it, where there is one
 */
function callerSite(client: DocumentClient, skip?: number): Site | undefined {
	const at = client.getModule(UnrouteModule)!.callerSite(skip);
	return at.filename === ''
		? undefined
		: [at.filename.replace(/[?#].*$/s, ''), at.lineno, at.colno];
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
	item: CodeItem & { sample?: string | null; lead?: string; once?: string },
	/**
	 * The load reaches the service worker (an http(s) external script or
	 * style), which reports a report-only refusal itself (reportRefusal): the
	 * inject reports only the enforced ones, so the page sees each once
	 */
	workerReports: boolean,
	/** where the code is (a script of the markup's) */
	site?: Site,
): boolean {
	let refused = false;
	for (const { policy, self } of client.pagePolicies()) {
		const governed = governing(policy, directive);
		if (!governed) continue;
		if (codeAllows(governed.sources, directive, { ...item, self })) continue;
		if (policy.disposition === 'enforce') refused = true;
		// (the worker judges only a list of hosts: ./cspJudge.ts hostsApply)
		if (
			(policy.disposition === 'report' &&
				workerReports &&
				hostsApply(governed.sources)) ||
			client.quietRefusal
		)
			continue;
		const sample =
			item.sample &&
			governed.sources.some(
				(source) => source.toLowerCase() === "'report-sample'",
			)
				? item.sample.slice(0, 40)
				: '';
		dispatchViolation(
			client,
			policy,
			directive,
			blocked,
			sample,
			node,
			undefined,
			undefined,
			site,
			item.once,
		);
		if (directive.startsWith('script-src-'))
			logScriptRefusal(
				client,
				policy,
				governed,
				item,
				directive.endsWith('-attr'),
			);
	}
	return refused;
}

/** the attribute that marks an element of the page's whose handlers wait to be judged as parsed (DocumentClient refuseHandler) */
const parsedMark = () => `${markerPrefix()}parsed`;

/** where a javascript: URL's code runs, as its violation names it: the document's first line (a frame's initial about:blank, `about`) */
function violationSite(client: DocumentClient): Site {
	const uri = violationDocument(client).documentURI;
	const global = client.global as Record<string, unknown>;
	return [
		uri === 'about' && global.parent === global
			? ''
			: uri.replace(/[?#].*$/s, ''),
		1,
		0,
	];
}

/** `note` kept in `notes`, at most 8 (the oldest, a navigation that never ran, let go) */
function keepNote(notes: JsNote[], note: JsNote) {
	if (notes.length >= 8) notes.shift();
	notes.push(note);
}

/** the first of `notes` of a javascript: URL whose sample is `sample`, taken */
function takeNote(
	notes: JsNote[] | undefined,
	sample: string,
): JsNote | undefined {
	const index = notes?.findIndex((note) => note.sample === sample) ?? -1;
	return index === -1 ? undefined : notes!.splice(index, 1)[0];
}

/** a javascript: URL's sample, as its rewrite hands it to the access API's `csp` (src/rewriteHTML.ts) */
function jsSample(url: string): string {
	// (as the URL parser keeps it: no tab or line break, nothing of C0 or a
	// space around it)
	let code = url
		.replace(/^[\0- ]+|[\0- ]+$|[\t\n\r]/g, '')
		.slice('javascript:'.length);
	try {
		code = decodeURIComponent(code);
	} catch (error) {
		// not percent-encoded
	}
	return `javascript:${code}`.slice(0, 40);
}

/** the window a navigation of `client`'s document aims at by `target` (a window, or a name), where one of this tab's proxied ones */
function windowNamed(
	client: DocumentClient,
	target: unknown,
): typeof globalThis | null {
	if (typeof target !== 'string') return target as typeof globalThis | null;
	const keyword = target.toLowerCase();
	if (!target || keyword === '_self') return client.global;
	if (keyword === '_parent' || keyword === '_top')
		return client.targetWindow(keyword)?.window ?? client.global;
	const frame = client.frameNamed(target);
	return frame
		? ((frame as HTMLIFrameElement).contentWindow as typeof globalThis | null)
		: (client.namedWindow?.(target) ?? null);
}

export const policyChecks = {
	/**
	 * Whether an enforced policy of the page's refuses a javascript: URL
	 * now (its code counts for no source: no hash takes it), firing nothing
	 * (DocumentClient: src/rewriteHTML.ts refusedNow)
	 */
	refusedNow(client: DocumentClient): boolean {
		for (const { policy, self } of client.pagePolicies()) {
			if (policy.disposition !== 'enforce') continue;
			const governed = governing(policy, 'script-src-elem');
			if (
				governed &&
				!codeAllows(governed.sources, 'script-src-elem', { parser: true, self })
			)
				return true;
		}
		return false;
	},
	/** a window open(), a link or a form of this document opened, which this bundle runs in (consoleOf) */
	openedConsole(window: typeof globalThis) {
		try {
			const console = window.console;
			openedConsoles.set(window, [
				console.error,
				console.info,
				window.document,
			]);
		} catch (error) {
			// a window of another origin
		}
	},
	/**
	 * Judge each handler of `element`, of the page's markup, as the parser
	 * inserts it in the written page (DocumentClient judgeParsed), as Chrome
	 * judges a handler attribute as it is set: by the policies in force then.
	 * A refused one keeps no attribute for the browser, which compiles
	 * nothing; the page reads its own back
	 */
	parsedHandlers(
		client: DocumentClient,
		element: Element,
		/** written by a document.write, judged at the write (it names its place) */
		written?: boolean,
	): string[] {
		const prefix = markerPrefix();
		const site = written ? callerSite(client) : undefined;
		const refused: string[] = [];
		for (const name of Reflect.apply(nativeGetAttributeNames, element, [])) {
			if (!name.startsWith(`${prefix}on`)) continue;
			const text = Reflect.apply(nativeGetAttribute, element, [name]);
			if (
				codeRefused(
					client,
					'script-src-attr',
					'inline',
					element,
					{ text, sample: text, once: site ? undefined : '' },
					false,
					site,
				)
			) {
				refused.push(sourceKey(text ?? ''));
				Reflect.apply(nativeRemoveAttribute, element, [
					name.slice(prefix.length),
				]);
			}
		}
		return refused;
	},
	/** the handlers a document.write of the page's just wrote in `document` (DocumentClient.writtenHandlers), as the parser inserted them */
	writtenHandlers(client: DocumentClient, document: Document) {
		const mark = parsedMark();
		const root = document.documentElement;
		if (!root) return;
		for (const element of Reflect.apply(nativeQuerySelectorAll, root, [
			`[${mark.replace(/:/g, '\\:')}=w]`,
		]) as Iterable<Element>) {
			Reflect.apply(nativeRemoveAttribute, element, [mark]);
			policyChecks.parsedHandlers(client, element, true);
		}
	},
	/**
	 * The page's code (`client`'s) starts a navigation of `target` (a window,
	 * a name, a frame's element) to the javascript: URL `url`
	 * (DocumentClient.jsStarts): the check Chrome makes as the navigation
	 * starts, by this document's policies, at the place of that code (a
	 * frame's targets the frame's element; a frame of the markup's, or a
	 * window open() makes, is checked twice, measured), is made a moment
	 * later, if the navigation started (`event`: a link's click, which a
	 * listener may cancel), or as the URL runs if that is sooner. The window
	 * it runs in takes it as a note (runRefused); one with no client yet (a
	 * new window, a fresh frame) finds it here, by the URL's sample
	 */
	jsStarts(
		client: DocumentClient,
		target: unknown,
		url: string,
		event?: Event,
		/** the link, form or submitter whose attribute (href, action, formaction) holds the URL */
		owner?: Element,
		/** open()'s, of a new window where none has the name */
		opens?: boolean,
	): string | undefined {
		// Refused by this document's policies now, the navigation goes to a
		// route that only judges the code (src/rewriteHTML.ts routeHTML
		// `judged`), so none of its declarations is made: the caller's, or
		// the attribute's of `owner`, which may be routed before the
		// markup's meta was in force (a policy only grows: every navigation
		// this document starts to it is refused from now)
		let judged: string | undefined;
		if (client.codeEnforced && policyChecks.refusedNow(client))
			try {
				judged = routeHTML(
					client.atBase(client.encodingParse(url, client.baseHref)),
					client.url,
					client.config,
					false,
					client.nestedRoute,
					true,
				);
				const name =
					owner?.localName === 'form'
						? 'action'
						: /^(?:a|area)$/.test(owner?.localName ?? '')
							? 'href'
							: 'formaction';
				if (
					owner &&
					Reflect.apply(nativeGetAttribute, owner, [name]) !== judged
				)
					hiddenMutation(() => {
						Reflect.apply(nativeElement.setAttribute, owner, [name, judged]);
						appliedAttribute(owner, name, judged!);
					});
			} catch (error) {
				// no URL
			}
		let window: typeof globalThis | null = null;
		let targetClient: DocumentClient | undefined;
		let frame: Element | null = null;
		try {
			try {
				// (a frame's element: a window or a name is no node)
				if (Reflect.apply(nativeNodeType, target, []) === 1)
					frame = target as Element;
			} catch (error) {
				// no node
			}
			window = frame
				? (Reflect.apply(nativeContentWindow!, frame, []) as
						typeof globalThis | null)
				: windowNamed(client, target);
			targetClient = (window as Record<string, any> | null)?.[
				client.names.client
			];
		} catch (error) {
			// a window of another origin
		}
		const sample = jsSample(url);
		const own = window === client.global;
		// its own location set through another's (Sandbox gateLocation): that
		// one noted it
		const noted = targetClient?.jsNotes?.at(-1);
		if (own && noted && !noted.own && noted.sample === sample) return judged;
		// (a frame of the markup's: the parser started it, at no code: the
		// document's first line, measured)
		const site = client.markupCopy ? violationSite(client) : callerSite(client);
		if (!own && !frame)
			try {
				frame = window ? Reflect.apply(nativeFrameElement!, window, []) : null;
				if (frame?.ownerDocument !== client.global.document) frame = null;
			} catch (error) {
				// none
			}
		const twice = client.markupCopy || (!!opens && !window);
		let verdict: boolean | undefined;
		let checked = false;
		const judge = () => {
			if (event?.defaultPrevented) {
				// no navigation: nothing runs to take the note
				const index = notes.indexOf(note);
				if (index !== -1) notes.splice(index, 1);
				return;
			}
			const refuses = () =>
				codeRefused(
					client,
					'script-src-elem',
					'inline',
					frame,
					{ parser: true, sample, lead: 'Running the JavaScript URL' },
					false,
					site,
				);
			verdict = client.codeEnforced && refuses();
			if (twice && client.codeEnforced && !verdict) refuses();
		};
		const check = (runs?: boolean) => {
			if (!checked) {
				checked = true;
				judge();
			}
			// (as the URL runs: this document's events and reports of it before
			// its code, as natively; this document's queue, which may be
			// another realm's than the one the URL runs in)
			if (runs) for (const run of pendingTasks.slice()) run();
			return verdict;
		};
		const notes = targetClient
			? (targetClient.jsNotes ??= [])
			: (client.jsPending ??= []);
		const note: JsNote = { sample, own, check };
		keepNote(notes, note);
		nativeSetTimeout(check);
		return judged;
	},
	/**
	 * Whether the page's policy refuses, as it runs, a handler of `that` (its
	 * element, or the window of a body's handler) whose text is kept by
	 * `code`, or (`that` 0) the javascript: URL `code` (decoded), firing
	 * the violations (DocumentClient.codeRuns). Chrome judges a handler as
	 * it compiles it, at its first run, by the policies in force then, which
	 * holds for every later run; a javascript: URL as the navigation starts
	 * (by the document whose code started it) and again as it runs, and its
	 * code by the page's Trusted Types before it runs (the default policy's
	 * `Location href`), measured
	 */
	runRefused(client: DocumentClient, that: unknown, code: string): boolean {
		const global = client.global as typeof globalThis;
		if (that === 0) {
			const sample = code.slice(0, 40);
			// as the navigation started: by the document whose code started it,
			// which noted it here (jsStarts), or for a window with no client
			// then (a new window, a fresh frame) its creator
			let note = takeNote(client.jsNotes, sample);
			if (!note)
				try {
					const creator = (
						((global as Record<string, any>).parent === global
							? (global as Record<string, any>).opener
							: (global as Record<string, any>).parent) as Record<
							string,
							any
						> | null
					)?.[client.names.client] as DocumentClient | undefined;
					note = takeNote(creator?.jsPending, sample);
				} catch (error) {
					// a creator of another origin
				}
			// (the inject's own run of the code a default policy made)
			if (note?.made) return false;
			const first = note?.check(true);
			const judged = (site?: Site) =>
				codeRefused(
					client,
					'script-src-elem',
					'inline',
					null,
					{
						parser: true,
						sample,
						lead: 'Running the JavaScript URL',
					},
					false,
					site,
				);
			if (first || (client.codeEnforced && first === undefined && judged()))
				return true;
			// (that check's events before the code too)
			if (!note) for (const run of pendingTasks.slice()) run();
			// the page's Trusted Types, by the code it wrote: its default
			// policy's, for `Location href`, runs instead; none made, the
			// navigation is refused (report-only: reported), measured
			const page = code.slice('javascript:'.length);
			const required = client.trustedTypesRequired();
			let trusted = page;
			if (required) {
				const sink = 'Location href';
				const callback = client.defaultScript?.();
				let made: unknown = null;
				if (typeof callback === 'function')
					try {
						made = Reflect.apply(callback, undefined, [
							page,
							'TrustedScript',
							sink,
						]);
					} catch (error) {
						// failed
					}
				if (made !== null && made !== undefined) trusted = `${made}`;
				else {
					const enforced = required === 'enforce';
					if (enforced) client.reportTrustedSink(sink, page);
					else client.reportTrustedTypes(sink, page);
					try {
						Reflect.apply(consoleOf(client, enforced), undefined, [
							`This document requires 'TrustedScript' assignment. Navigating to a javascript:-URL is equivalent to a 'TrustedScript' assignment${typeof callback === 'function' ? " and the 'default' policy failed toexecute" : ''}.${enforced ? ' The action has been blocked.' : ' The policy is report-only, so the violation has been logged but no further action has been taken.'}`,
						]);
					} catch (error) {
						// no console
					}
					if (enforced) return true;
				}
			}
			// as it runs: the document's first line
			if (client.codeEnforced && judged(violationSite(client))) return true;
			if (trusted === page) return false;
			// the default policy made other code: it runs instead, through a
			// javascript: URL of its rewrite, judged now
			const made = `javascript:${trusted}`;
			keepNote((client.jsNotes ??= []), {
				sample: made.slice(0, 40),
				own: true,
				check: () => false,
				made: true,
			});
			const location = global.location;
			Reflect.apply(location.assign, location, [
				routeHTML(
					new StompURL(made, client.url),
					client.url,
					client.config,
					false,
					client.nestedRoute,
				),
			]);
			return true;
		}
		// (a body's handler of the window's runs with the window as this, and
		// its violation targets the document)
		let element: Element | null = null;
		try {
			if (Reflect.apply(nativeNodeType, that, []) === 1)
				element = that as Element;
		} catch (error) {
			// the window
		}
		const owner = element ?? global.document.body;
		// one the parser inserted that runs before the parse was judged (an
		// iframe's load as it is inserted): judged as parsed first
		const mark = parsedMark();
		const pending = owner && Reflect.apply(nativeGetAttribute, owner, [mark]);
		if (pending === 'h' || pending === 'w') {
			Reflect.apply(nativeRemoveAttribute, owner, [mark]);
			if (
				policyChecks
					.parsedHandlers(client, owner, pending === 'w')
					.includes(code)
			)
				return true;
		}
		const text = keptText(code)?.[0] ?? '';
		// where the code that compiles it is: the code that dispatched its
		// event (under the handler's own frame), else the handler's place in
		// the markup (where V8 counts its own frame from: ./violations.ts
		// handlerPlace); the code that read its property
		return codeRefused(
			client,
			'script-src-attr',
			'inline',
			element,
			{ text, sample: text },
			false,
			callerSite(client, client.handlerRead ? 0 : 1),
		);
	},
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
			for (const { policy } of reporting) {
				// (one report, however many events: measured)
				makeReport(client, policy, directive, blocked, '');
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
			}
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
				// a script of the markup's names where its text starts, one the
				// page's code inserts the inserting call (in a script file, its
				// place in the file's text: ../positionParts.ts), and so does a
				// handler the page's code sets (one of the markup's names none:
				// measured, Chrome 157)
				client.parsedSource === code
					? deferred('markupScriptSite')(client, code)
					: script && (elem || !client.markupCopy)
						? callerSite(client)
						: undefined,
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
		// the violation names the page's call (of eval, Function, the timer),
		// placed in the page's text (measured, Chrome 157)
		let site: Site | undefined | null = null;
		for (const { policy } of client.pagePolicies()) {
			const governed = governing(policy, 'script-src');
			if (!governed) continue;
			if (codeAllows(governed.sources, 'script-src', { wasm })) continue;
			if (site === null) site = callerSite(client);
			const shown =
				sample &&
				governed.sources.some(
					(source) => source.toLowerCase() === "'report-sample'",
				)
					? sample.slice(0, 40)
					: '';
			dispatchViolation(
				client,
				policy,
				'script-src',
				blocked,
				shown,
				null,
				undefined,
				undefined,
				site,
			);
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
