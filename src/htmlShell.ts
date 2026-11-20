// The HTML shell (modifyHTML), apart from src/rewriteHTML.ts: the worker
// serves it for every document it rewrites, and in a page it is a deferred
// part (src/inject/dom/deferredParts.ts), since a document bundle writes a
// shell itself only for a document the page makes that no worker serves
// (an srcdoc, an object's copy, a javascript: URL's markup, a data: frame).
// The statements the shells write for their client are here too, which the
// XML shell (src/xmlShell.ts) writes as well.
import { escapeText } from 'entities/escape';
import type { AdblockPage } from './blocker/types';
import { Config } from './config';
import type { PolicyText, ScriptFacts } from './csp';
import { helperNames } from './helperNames';
import { CACHE_MARK_SHAPE, realmCacheMark } from './memoryMark';
import type { Prewritten } from './prewrite';
import type { ReferrerInfo } from './referrerPolicy';
import { providedShell } from './rewriteHTML';
import { BUNDLE_CLIENT, injectDocumentJS, rewriterLibJS } from './routeURL';
import type { ControlInfo } from './serviceWorkerTypes';
import type { SiteFacts } from './siteFacts';
import StompURL from './StompURL';
import {
	CSP_FACTS,
	SHELL_END,
	SHELL_MARKUP,
	SW_CONTROL,
	WORKER_BASE,
} from './transport/messages';
import {
	ACTIVATION_FACTORY,
	DEFERRED_FACTORY,
	LIGHT_FACTORY,
	PASSKEYS_FACTORY,
} from './version';

/**
 * The shell's first script (src/gapView.ts), for a document of `url` (its
 * real URL) whose referrer is `referrer` ('' for none, and for one its
 * client works out from its parent): its URL keeps the route's fragment,
 * which is the page's
 */
export function gapView(url: URL, referrer: string): string {
	const href = url.href.split('#')[0];
	const text = (value: string) =>
		JSON.stringify(value).replace(
			/[<\u007f-￿]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
	return `(()=>{const d=document,u=${text(href)},r=${text(referrer)},h=${text(url.hostname)},g=(v)=>({get:v,configurable:true}),f=()=>{const l=location.href,i=l.indexOf("#");return i<0?u:u+l.slice(i)},n=Object.getOwnPropertyDescriptor(Document.prototype,"domain");Object.defineProperties(d,{URL:g(f),documentURI:g(f),baseURI:g(f),referrer:g(()=>r),domain:{get:()=>h,set:(v)=>n.set.call(d,v),configurable:true}})})()`;
}

/**
 * The shell's branch for a window the browser kept from an initial
 * about:blank that a client of another origin than the document's was
 * made for (DocumentClient keptFor): the document leaves it, before any of
 * it runs, for a window of its own (leaveKept), as natively it never shows
 * in that one. Comes before the branch that takes a kept client. (A client
 * that cannot leave throws here, and the document stays empty.) Between
 * real origins only: under an opaque one (a sandbox) every navigation is
 * to another origin, which its maker never injects (ContextModule
 * pendingForeign).
 */
export function leftKept(client: string, url: StompURL): string {
	const { origin } = url.url;
	if (origin === 'null') return '';
	return `} else if (${JSON.stringify(client)} in globalThis && typeof ${client}.keptFor === 'string' && ${client}.keptFor !== ${JSON.stringify(origin)}) {
	${client}.leaveKept();
`;
}

/** the shell's statement that hands the client its document's referrer (none without one) */
export function referred(
	client: string,
	referrer: ReferrerInfo | undefined,
): string {
	if (!referrer) return '';
	// a URL's query may hold `<`: never let it close the shell's script
	const info = JSON.stringify(referrer).replace(/</g, '\\u003c');
	return `\t${client}.setReferrer(document, ${info});`;
}

/**
 * The shell's statement that gives the client its site's cache mark
 * (src/memoryMark.ts): the one the service worker set on the document's URL,
 * else the one of the realm that builds the shell (a blob: or javascript:
 * document is its builder's site's). Always made, with '' for none: a
 * window the browser kept from its initial document takes the mark of the
 * document it shows now.
 */
export function marked(client: string, url: StompURL): string {
	const mark = url.mark ?? realmCacheMark();
	return `\n\t${client}.cacheMark = ${JSON.stringify(CACHE_MARK_SHAPE.test(mark) ? mark : '')};`;
}

/**
 * The shell's statement that names its document's script policy for the
 * client it makes (src/csp.ts ScriptFacts), when it has one
 */
export function scriptFacts(facts: ScriptFacts | undefined): string {
	if (!facts) return '';
	return `Reflect.defineProperty(globalThis, ${JSON.stringify(CSP_FACTS)}, { value: ${JSON.stringify(facts)}, configurable: true });\n\t`;
}

/**
 * The shell's statement that hands the facts to a client the window kept
 * from its initial document (a frame the parent injected before it
 * navigated, whose Window the browser keeps for a document of its origin):
 * the document's own policy is the one its headers name, and the global
 * goes (the client took it otherwise)
 */
export function keptFacts(
	client: string,
	facts: ScriptFacts | undefined,
): string {
	if (!facts) return '';
	const key = JSON.stringify(CSP_FACTS);
	return `\n\tif (${key} in globalThis) { ${client}.scriptFacts = globalThis[${key}]; delete globalThis[${key}]; }`;
}

/**
 * The shell's statement that hands the client the policies of its
 * document's headers the browser applies, each with the page's text it
 * stands for (none without any)
 */
export function policyTexts(
	client: string,
	policies: PolicyText[] | undefined,
): string {
	if (!policies?.length) return '';
	return `\t${client}.policyTexts = ${JSON.stringify(policies).replace(/</g, '\\u003c')};\n`;
}

/**
 * The shell's statement that tells the client its document's real permissions
 * policy blocks a synchronous XMLHttpRequest (src/server/clientHints.ts
 * syncXHRBlocked): the inject throws for the guest's synchronous requests as
 * the browser would, though the served Permissions-Policy no longer disables
 * the feature (STomp's own inject needs it). Nothing when it is allowed.
 */
export function syncXHR(client: string, blocked: boolean | undefined): string {
	if (!blocked) return '';
	return `\t${client}.syncXHRBlocked = true;\n`;
}

/**
 * The shell's statements that tell the client its host's site and its
 * top's (src/siteFacts.ts), before anything asks: none without facts. A
 * host name is letters, digits, dots and hyphens, but the text is in a
 * script: `<` never closes it. A bundle from before the client took them
 * (one the browser kept across an update) goes on asking the list.
 */
export function sited(client: string, sites: SiteFacts[] | undefined): string {
	let text = '';
	for (const facts of sites ?? providedShell().sites ?? [])
		text += `	${client}.learnSites?.(${JSON.stringify(facts).replace(/</g, '\\u003c')});\n`;
	return text;
}

/**
 * The shell that stands in for a document: loads the inject bundle, creates
 * the client and hands it the real markup. A document whose own URL cannot
 * carry the page URL (a blob: document the page built) gets `base`: the
 * shell names the page URL for the client first. `referrer` is what the
 * service worker decided the document's referrer is (a document it served);
 * a shell the page realm builds has none and keeps the browser's. `nonce`:
 * the script policy's nonce of the document that builds the shell, when it
 * runs no script of the page (a sandbox without allow-scripts): an
 * about:srcdoc, about:blank, blob: or data: document inherits that policy,
 * and only the shell's own scripts carry the nonce. `upgradeInsecure`: the
 * document's policy upgrades insecure requests (src/mixedContent.ts).
 * `sites`: what the service worker's list says of the document's host and
 * its top's (src/siteFacts.ts); a shell the page realm builds hands on what
 * its bundle was told.
 * `isolation`: what the document is by its headers, when the host's page is
 * cross-origin isolated (src/isolation.ts isolationFacts).
 */
export function modifyHTML(
	script: string,
	url: StompURL,
	config: Config,
	base = false,
	referrer?: ReferrerInfo,
	nonce?: string | null,
	/** the emulated service worker registration that controls the document (docs/service-workers.md) */
	control?: ControlInfo,
	/** the document's inline scripts and styles, rewritten already (src/prewrite.ts) */
	prewritten?: Prewritten | null,
	upgradeInsecure = false,
	/** the blocker's cosmetic rules and scriptlets for the document (docs/adblock.md) */
	adblock?: AdblockPage | null,
	sites?: SiteFacts[],
	/** the document is a proxied top the service worker serves: its shell loads the rewriter library */
	top = false,
	isolation?: string,
	/** what the document's Origin-Agent-Cluster asked for (DocumentClient.agentCluster) */
	agentCluster?: 'site' | 'origin',
	/** the policies of its headers the browser applies, with the page's texts (src/csp.ts browserHeaders) */
	policies?: PolicyText[],
	/** its script policy, for the client (src/csp.ts ScriptFacts); its nonce is the shell's scripts' */
	facts?: ScriptFacts,
	/** its real permissions policy blocks a synchronous XHR (src/server/clientHints.ts syncXHRBlocked) */
	syncXHRBlocked?: boolean,
	/** the service worker serves the document: its shell answers for it in the gap (src/gapView.ts) */
	served = false,
	/** the client the document's navigation makes, as the worker that serves it knows (DocumentClient.servedClient) */
	clientId?: string,
): string {
	const { head, tail } = shell(
		script,
		url,
		config,
		base,
		referrer,
		nonce,
		control,
		upgradeInsecure,
		false,
		adblock,
		sites,
		top,
		isolation,
		agentCluster,
		policies,
		facts,
		syncXHRBlocked,
		served,
		undefined,
		clientId,
	);
	return head + tail(prewritten);
}

/**
 * The shell of modifyHTML for a document the service worker serves, in two
 * pieces: `head`, which the page can have at once (the inject bundle's
 * script, and the markup, kept in a global of the shell), and `tail`, which
 * creates the client and hands it the markup and the prewritten table once
 * the rewrite workers are done with it. The browser loads and runs the
 * inject bundle while they work.
 */
export function modifyHTMLStreamed(
	script: string,
	url: StompURL,
	config: Config,
	referrer?: ReferrerInfo,
	control?: ControlInfo,
	upgradeInsecure = false,
	adblock?: AdblockPage | null,
	sites?: SiteFacts[],
	/** as modifyHTML's */
	top = false,
	isolation?: string,
	/** what the document's Origin-Agent-Cluster asked for (DocumentClient.agentCluster) */
	agentCluster?: 'site' | 'origin',
	/** as modifyHTML's */
	policies?: PolicyText[],
	/** as modifyHTML's */
	facts?: ScriptFacts,
	/** as modifyHTML's */
	syncXHRBlocked?: boolean,
	/**
	 * where the client reads the markup from, as it comes (the worker's
	 * MARKUP_ROUTE): the shell holds none of it, and `script` is not read
	 */
	stream?: string,
	/** as modifyHTML's */
	clientId?: string,
): { head: string; tail: (prewritten: Prewritten | null) => string } {
	return shell(
		script,
		url,
		config,
		false,
		referrer,
		undefined,
		control,
		upgradeInsecure,
		true,
		adblock,
		sites,
		top,
		isolation,
		agentCluster,
		policies,
		facts,
		syncXHRBlocked,
		true,
		stream,
		clientId,
	);
}

function shell(
	script: string,
	url: StompURL,
	config: Config,
	base: boolean,
	referrer: ReferrerInfo | undefined,
	nonce: string | null | undefined,
	control: ControlInfo | undefined,
	upgradeInsecure: boolean,
	/** the markup goes in the head, the client takes it from the global */
	streamed: boolean,
	adblock?: AdblockPage | null,
	sites?: SiteFacts[],
	top = false,
	isolation?: string,
	/** what the document's Origin-Agent-Cluster asked for (DocumentClient.agentCluster) */
	agentCluster?: 'site' | 'origin',
	policies?: PolicyText[],
	facts?: ScriptFacts,
	syncXHRBlocked?: boolean,
	served = false,
	stream?: string,
	clientId?: string,
): { head: string; tail: (prewritten?: Prewritten | null) => string } {
	// if(fragment) return '<script>document.currentScript.replaceWith(globalstomp.cloneIntoNewNode())
	// a shell the page realm builds is of a document that inherits the
	// builder's policy, and its facts (and its sync-xhr state) with it
	const provided = providedShell();
	facts ??= provided.facts;
	syncXHRBlocked ??= provided.syncXHRBlocked;
	nonce ??= facts?.nonce;
	const names = helperNames(config);
	const markupKey = JSON.stringify(SHELL_MARKUP);
	const markup = () => escapeText(JSON.stringify(script));
	const controlled =
		(control
			? `globalThis[${JSON.stringify(SW_CONTROL)}] = ${JSON.stringify(control).replace(/</g, '\\u003c')};\n\t`
			: '') + scriptFacts(facts);
	// the blocker's cosmetic rules and scriptlets, handed to the client before
	// the markup: the scriptlets run before the page's first script, the
	// rules apply as the markup lands (docs/adblock.md)
	const blocked =
		adblock &&
		(adblock.hide.length ||
			adblock.procedural.length ||
			adblock.script ||
			!adblock.generichide)
			? `\n\t${names.client}.adblock(${JSON.stringify(adblock).replace(/</g, '\\u003c')});\n`
			: '';
	const inject = (
		prewritten?: Prewritten | null,
	) => `if (!(${JSON.stringify(names.client)} in globalThis) && typeof globalThis.createClient !== 'function') {
	document.write("Stomp bundle did not load. See devtools output for more information.");
${leftKept(names.client, url)}} else {
	${controlled}if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
	else {
		delete globalThis.createClient;
		${names.client}.takeNamedBase();${
			served
				? `
		delete document.URL; delete document.documentURI; delete document.baseURI; delete document.referrer; delete document.domain;`
				: ''
		}
	}${keptFacts(names.client, facts)}${marked(names.client, url)}${
		clientId
			? `
	${names.client}.servedClient = ${JSON.stringify(clientId).replace(/</g, '\\u003c')};`
			: ''
	}

${sited(names.client, sites)}${referred(names.client, referrer)}${policyTexts(names.client, policies)}${syncXHR(names.client, syncXHRBlocked)}${
		upgradeInsecure
			? `
	${names.client}.upgradeInsecureRequests = true;`
			: ''
	}${
		isolation === undefined
			? ''
			: `
	${names.client}.isolation = ${JSON.stringify(isolation)};`
	}${
		agentCluster === undefined
			? ''
			: `
	${names.client}.agentCluster = ${JSON.stringify(agentCluster)};`
	}
	if (!${names.client}.applied) try {
		${names.client}.apply(true);
	} catch(error) {
		document.write("Failure applying Stomp hooks. See devtools output for more information.");
		throw error;
	}

${blocked}
	try {
		${
			stream !== undefined
				? `${names.client}.loadHTMLStream(${JSON.stringify(stream).replace(/</g, '\\u003c')}`
				: `${names.client}.loadHTML(${
						streamed
							? `(() => { const markup = globalThis[${markupKey}]; delete globalThis[${markupKey}]; return markup; })()`
							: markup()
					}`
		}${
			prewritten &&
			(prewritten.scripts.length ||
				prewritten.styles.length ||
				prewritten.handlers?.length)
				? `, ${escapeText(JSON.stringify(JSON.stringify(prewritten)))}`
				: ''
		});
	} catch(error) {
		document.write("Failure loading Stomp HTML. See devtools output for more information.");
		throw error;
	}
}`;

	const attribute = nonce ? ` nonce="${nonce.replace(/[^\w+/=-]/g, '')}"` : '';
	// the scripts that load by URL carry the nonce only where no policy lets
	// them through by it (ScriptFacts.loadsByNonce), or where the nonce is a
	// sandbox's (no allow-scripts), which lets nothing else through
	const loading =
		facts?.nonce === nonce && !facts?.loadsByNonce ? '' : attribute;
	const baseScript = base
		? `<script${attribute}>globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(url.toString()).replace(/</g, '\\u003c')};</script>`
		: '';
	const kept =
		streamed && stream === undefined
			? `<script${attribute}>globalThis[${markupKey}] = ${markup()};</script>`
			: '';
	const library = top ? libraryScripts(url, config, attribute, loading) : '';
	// what another document reads of this one until its bundle runs: first,
	// as the parser may wait on the library's script (its file only assigns
	// functions, read once the bundle runs)
	const gap = served
		? `<script${attribute}>${gapView(url.url, referrer && 'referrer' in referrer ? referrer.referrer : '')}</script>`
		: '';
	return {
		head: `<!DOCTYPE HTML><html><head><meta charset="utf-8" /></head><body>${gap}${baseScript}${library}<script${loading} src="${injectDocumentJS(url, config)}" ${BUNDLE_CLIENT}="${names.client}"></script>${kept}`,
		// the empty script after the one that loads the page: the client
		// writes the page at its end tag (DocumentClient.loadHTML), before the
		// shell's parse could end; a type no script runs as, so no policy
		// judges it
		tail: (prewritten) =>
			`<script${attribute}>${inject(prewritten)}</script><script type="${SHELL_END}"></script></body></html>`,
	};
}

/**
 * The scripts that load the light rewriter library in a proxied top's shell,
 * before the inject bundle (the parser fetches the two together, from the
 * HTTP cache: the controller fetched the file when it started). The library
 * is the wasm glue; no document bundle carries it. The top evaluates it in a
 * realm of its own and the frames under it share that copy. It is what
 * rewrites what a page's first task does (eval, new Function, an inline
 * script or style) in the module the controller compiled, which the copy
 * compiles from its bytes itself (src/inject/rewriter.ts provideModule) if
 * the rewrite comes before the compiled module has arrived. The file assigns
 * its factory to a name, made here so that it is never enumerable; the bundle
 * takes it and deletes the name as it loads. A frame shares its top's library
 * and gets none of this. `attribute`: what the shell's own scripts carry (a
 * nonce, the XHTML namespace).
 */
export function libraryScripts(
	url: StompURL,
	config: Config,
	attribute: string,
	/** what the script that loads the file carries */
	loading = attribute,
) {
	// the file assigns the light library's factory, and the document bundle's
	// deferred statements' functions, to these names (build.js)
	const name = [
		LIGHT_FACTORY,
		DEFERRED_FACTORY,
		PASSKEYS_FACTORY,
		ACTIVATION_FACTORY,
	]
		.map(
			(factory) =>
				`Reflect.defineProperty(globalThis, ${JSON.stringify(factory)}, { writable: true, configurable: true });`,
		)
		.join('');
	return `<script${attribute}>${name}</script><script${loading} src="${rewriterLibJS(url, config)}"></script>`;
}
