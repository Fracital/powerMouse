import { escapeText } from 'entities';
import type { AdblockPage } from './blocker/types';
import { Config } from './config';
import type { PolicyText, ScriptFacts } from './csp';
import { helperNames } from './helperNames';
import type { Prewritten } from './prewrite';
import type { ReferrerInfo } from './referrerPolicy';
import { rewriter } from './rewriters';
import {
	createDataURI,
	injectDocumentJS,
	parseDataURI,
	rewriterLibJS,
	routeURL,
} from './routeURL';
import type { ControlInfo } from './serviceWorkerTypes';
import type { SiteFacts } from './siteFacts';
import StompURL from './StompURL';
import {
	CSP_FACTS,
	SHELL_MARKUP,
	SW_CONTROL,
	WORKER_BASE,
} from './transport/messages';
import { dataBody } from './urlShape';
import { LIBRARY_FACTORY, LIGHT_FACTORY } from './version';

/**
 * The route of a document. `form`: a GET form's action, whose query the
 * browser appends (the route redirects). `nested`: the document will be a
 * child frame of a proxied page (an iframe's src, or anything a nested
 * context navigates to): the origin of the top-level proxied page, which the
 * service worker uses as the site for cookies and fetch metadata, the way a
 * browser judges a nested frame's requests by its top, and never treats the
 * navigation as top-level. The kind is decided here, in the page realm, so a
 * hostile embedder holding the codec key could route a child as `html`: the
 * same trust boundary as every rewriting decision.
 */
/**
 * The rewritten expression of a javascript: URL body that is one expression
 * (`'<p>markup'`, `void 0`, `f()`), or null for statements, several
 * expressions or anything that does not parse: those keep their own
 * completion value as written.
 */
function javascriptExpression(body: string, rewritten: string): string | null {
	const single = rewriter('singleExpression');
	if (!single(body)) return null;
	const expression = rewritten.trim().replace(/;$/, '');
	return single(`(${expression})`) ? expression : null;
}

/**
 * In a page: the inline-document route for a navigation to one of the page's
 * own text/html blobs, or null (src/inject/htmlBlobs.ts). Unset in the
 * service worker.
 */
let inlineBlob: ((blobURL: string) => string | null) | null = null;
export function setInlineBlobResolver(
	resolver: (blobURL: string) => string | null,
) {
	inlineBlob = resolver;
}

export function routeHTML(
	resource: StompURL,
	url: StompURL,
	config: Config,
	form = false,
	nested: string | false = false,
) {
	if (resource.url.protocol === 'blob:' && inlineBlob) {
		const inline = inlineBlob(resource.url.href);
		if (inline) return inline;
	}

	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			dataBody(resource.url),
		);
		return createDataURI({
			mime,
			data: modifyHTML(data, url, config),
			attributes,
		});
	}

	// `href="javascript:..."` runs its body as a classic script in the page:
	// rewrite it like one, or it sees the real top and the proxy's location
	if (resource.url.protocol === 'javascript:') {
		const source = resource.url.href.slice('javascript:'.length);
		let body = source;
		try {
			body = decodeURIComponent(source);
		} catch (error) {
			// not percent-encoded
		}
		// its functions' text is never written into a URL: kept by the inject
		// when it rewrites the URL, otherwise they read as rewritten
		const kept = { embed: false };
		const modifyJS = rewriter('modifyJS');
		const rewritten = modifyJS(
			body,
			url,
			config,
			'generic',
			'',
			undefined,
			kept,
		);
		const client = JSON.stringify(helperNames(config).client);
		// The body runs in the window it navigates: in a fresh iframe that is
		// the frame's initial about:blank, which nothing injected, and the
		// rewritten code would throw on the access helper. The parent's client
		// injects the frame first (a page or a frame it already injected has
		// its own client, and nothing happens). A window with no parent is a
		// popup a link or a form opened by its target: its opener's client
		// injects it.
		const creator = `(parent===self?opener:parent)[${client}]`;
		const inject = `self[${client}]||(()=>{try{${creator}.injectChild(self)}catch(e){}})()`;
		// A javascript: URL whose value is a string replaces the document with
		// that markup, which nothing would inject: the frame or page would run
		// its scripts raw. For a single-expression body the string goes through
		// the client (the frame's own, else its parent's), which wraps it in
		// the shell like a blob document; other values pass through untouched.
		const expression = javascriptExpression(body, rewritten);
		if (expression === null)
			// statements: injected after their directive prologue, so a
			// 'use strict' stays one
			return `javascript:${modifyJS(body, url, config, 'generic', `void (${inject});`, undefined, kept)}`;
		return `javascript:((r,c)=>typeof r==='string'&&c?c.javascriptDocument(r,document.URL):r)((${inject},(${expression})),self[${client}]||(()=>{try{return ${creator}}catch(e){}})())`;
	}

	return routeURL(
		`html${form ? ':form' : ''}${
			nested ? `:nested:${encodeURIComponent(nested)}` : ''
		}`,
		resource,
	);
}

/**
 * The top-level origin a routed document URL's kind names when it is a
 * nested document, else null. Works on any routed path (a request's own, or
 * its referrer's).
 */
export function nestedTopOf(
	pathname: string,
	directory: string,
): string | null {
	const mark = nestedMarkOf(pathname, directory);
	if (mark === null) return null;
	try {
		return new URL(mark).origin;
	} catch (error) {
		return null;
	}
}

/**
 * A nested route kind's marker as routeHTML was given it (src/partition.ts
 * nestedMark: the top origin, and whether a frame above the document is of
 * another site), or null for any other kind. A route the worker makes for
 * the same document (a redirect, a form's) passes it on.
 */
export function nestedMarkOfKind(kind: string): string | null {
	const match = /^html(?::form)?:nested:(.*)$/.exec(kind);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch (error) {
		return null;
	}
}

/** nestedMarkOfKind of a routed path's kind */
export function nestedMarkOf(
	pathname: string,
	directory: string,
): string | null {
	if (!pathname.startsWith(directory)) return null;
	return nestedMarkOfKind(pathname.slice(directory.length).split('/')[0]);
}

/** the shell's statement that hands the client its document's referrer (none without one) */
function referred(client: string, referrer: ReferrerInfo | undefined): string {
	if (!referrer) return '';
	// a URL's query may hold `<`: never let it close the shell's script
	const info = JSON.stringify(referrer).replace(/</g, '\\u003c');
	return `\t${client}.setReferrer(document, ${info});`;
}

/** what a shell written on this thread says of its document's script policy when its caller says nothing: the inject's client's */
let shellFacts: (() => ScriptFacts | undefined) | null = null;
export function provideShellFacts(provider: () => ScriptFacts | undefined) {
	shellFacts = provider;
}

/**
 * The shell's statement that names its document's script policy for the
 * client it makes (src/csp.ts ScriptFacts), when it has one
 */
function scriptFacts(facts: ScriptFacts | undefined): string {
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
function keptFacts(client: string, facts: ScriptFacts | undefined): string {
	if (!facts) return '';
	const key = JSON.stringify(CSP_FACTS);
	return `\n\tif (${key} in globalThis) { ${client}.scriptFacts = globalThis[${key}]; delete globalThis[${key}]; }`;
}

/**
 * The shell's statement that hands the client the policies of its
 * document's headers the browser applies, each with the page's text it
 * stands for (none without any)
 */
function policyTexts(
	client: string,
	policies: PolicyText[] | undefined,
): string {
	if (!policies?.length) return '';
	return `\t${client}.policyTexts = ${JSON.stringify(policies).replace(/</g, '\\u003c')};\n`;
}

/**
 * What a shell written on this thread says of sites when its caller names
 * none: the inject bundle hands on what it was told (src/inject/sites.ts),
 * the service worker names them with each document it serves
 */
let shellSites: (() => SiteFacts[]) | null = null;
export function provideShellSites(provider: () => SiteFacts[]): void {
	shellSites = provider;
}

/**
 * The shell's statements that tell the client its host's site and its
 * top's (src/siteFacts.ts), before anything asks: none without facts. A
 * host name is letters, digits, dots and hyphens, but the text is in a
 * script: `<` never closes it. A bundle from before the client took them
 * (one the browser kept across an update) goes on asking the list.
 */
function sited(client: string, sites: SiteFacts[] | undefined): string {
	let text = '';
	for (const facts of sites ?? shellSites?.() ?? [])
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
): { head: string; tail: (prewritten?: Prewritten | null) => string } {
	// if(fragment) return '<script>document.currentScript.replaceWith(globalstomp.cloneIntoNewNode())
	// a shell the page realm builds is of a document that inherits the
	// builder's policy, and its facts with it
	facts ??= shellFacts?.();
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
	) => `if (typeof globalThis.createClient !== 'function') {
	document.write("Stomp bundle did not load. See devtools output for more information.");
} else {
	${controlled}if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
	else delete globalThis.createClient;${keptFacts(names.client, facts)}

${sited(names.client, sites)}${referred(names.client, referrer)}${policyTexts(names.client, policies)}${
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
		${names.client}.loadHTML(${
			streamed
				? `(() => { const markup = globalThis[${markupKey}]; delete globalThis[${markupKey}]; return markup; })()`
				: markup()
		}${
			prewritten && (prewritten.scripts.length || prewritten.styles.length)
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
	const kept = streamed
		? `<script${attribute}>globalThis[${markupKey}] = ${markup()};</script>`
		: '';
	const library = top ? libraryScripts(url, config, attribute, loading) : '';
	return {
		head: `<!DOCTYPE HTML><html><head><meta charset="utf-8" /></head><body>${baseScript}${library}<script${loading} src="${injectDocumentJS(url, config)}"></script>${kept}`,
		tail: (prewritten) =>
			`<script${attribute}>${inject(prewritten)}</script></body></html>`,
	};
}

/**
 * The scripts that load the rewriter library in a proxied top's shell,
 * before the inject bundle (the parser fetches the two together, from the
 * HTTP cache: the controller fetched the file when it started). The library
 * is in no bundle. With `rewriter: 'js'` a top needs it for its first
 * script; with `'wasm'` it is what answers a rewrite the page asks for
 * before its module has arrived, which a page's first task often does.
 * Either costs the top what it paid when the bundle carried the library,
 * and a page that had to fetch the file when a rewrite asked would wait for
 * a synchronous request, which the browser reports to the page as
 * deprecated. The file assigns its factory to a name, made here so that it
 * is never enumerable; the bundle takes it and deletes the name as it loads
 * (src/inject/rewriter.ts). A frame shares its top's library and gets none
 * of this. `attribute`: what the shell's own scripts carry (a nonce, the
 * XHTML namespace).
 */
function libraryScripts(
	url: StompURL,
	config: Config,
	attribute: string,
	/** what the script that loads the file carries */
	loading = attribute,
) {
	// the file assigns two names: the library's and the document's light
	// library's (build.js)
	const names = [LIBRARY_FACTORY, LIGHT_FACTORY]
		.map(
			(name) =>
				`Reflect.defineProperty(globalThis, ${JSON.stringify(name)}, { writable: true, configurable: true });`,
		)
		.join(' ');
	return `<script${attribute}>${names}</script><script${loading} src="${rewriterLibJS(url, config)}"></script>`;
}

/** the mimes an XML document is served under and parsed with */
export const XML_DOCUMENT_MIMES = ['image/svg+xml', 'application/xhtml+xml'];

/**
 * The shell of an XML document (a standalone SVG, an XHTML page): the same
 * root element with its namespace declarations, holding the inject bundle
 * and the client call as XHTML script elements (which an XML parser runs),
 * the original markup in a CDATA section. The client parses it with the
 * document's own mime and replaces the root in place: an XML document has
 * no document.write.
 */
export function modifyXML(
	script: string,
	url: StompURL,
	config: Config,
	mime: string,
	referrer?: ReferrerInfo,
	sites?: SiteFacts[],
	/** as modifyHTML's */
	top = false,
	/** as modifyHTML's */
	policies?: PolicyText[],
	/** as modifyHTML's */
	facts?: ScriptFacts,
): string {
	facts ??= shellFacts?.();
	// the root start tag, after the prolog, comments and doctype
	const tags =
		/<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<([A-Za-z_][\w.:-]*)(\s[^>]*?)?(\/?)>/g;
	let root = `<svg xmlns="http://www.w3.org/2000/svg">`;
	let name = 'svg';
	let match: RegExpExecArray | null;
	while ((match = tags.exec(script)) !== null) {
		if (match[1]) {
			name = match[1];
			root = `<${name}${match[2] ?? ''}>`;
			break;
		}
	}
	if (mime === 'application/xhtml+xml' && !match?.[1])
		root = `<html xmlns="http://www.w3.org/1999/xhtml">`;
	const cdata = (text: string) =>
		`<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
	const names = helperNames(config);
	const inject = `if (typeof globalThis.createClient !== 'function') {
	document.documentElement.textContent = "Stomp bundle did not load. See devtools output for more information.";
} else {
	${scriptFacts(facts)}if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
	else delete globalThis.createClient;${keptFacts(names.client, facts)}
${sited(names.client, sites)}${referred(names.client, referrer)}${policyTexts(names.client, policies)}
	if (!${names.client}.applied) ${names.client}.apply();
	${names.client}.loadXML(${JSON.stringify(script)}, ${JSON.stringify(mime)});
}`;
	const xhtml = 'http://www.w3.org/1999/xhtml';
	const own = ` xmlns="${xhtml}"${facts?.nonce ? ` nonce="${facts.nonce.replace(/[^\w+/=-]/g, '')}"` : ''}`;
	const loading = facts?.loadsByNonce ? own : ` xmlns="${xhtml}"`;
	return `<?xml version="1.0" encoding="UTF-8"?>${root}${top ? libraryScripts(url, config, own, loading) : ''}<script${loading} src="${injectDocumentJS(url, config)}"></script><script${own}>${cdata(inject)}</script></${name}>`;
}

/**
 * The HTML spec's parse of a refresh value (`<meta http-equiv=refresh>`, the
 * `Refresh` header): whitespace, the time (digits, then anything up to the
 * separator), an optional `;` or `,`, whitespace, an optional `url`
 * (any case) with `=`, whitespace, then the URL, which drops a matching pair
 * of quotes around it. Null when there is no URL (a reload after `time`).
 */
export function parseRefresh(value: string): {
	time: string;
	url: string | null;
} {
	let i = 0;
	const space = () => {
		while (i < value.length && /[\t\n\f\r ]/.test(value[i])) i++;
	};
	space();
	const timeStart = i;
	while (i < value.length && /[0-9]/.test(value[i])) i++;
	// anything else before the separator belongs to the time (the browser
	// ignores it; "5.5" or "5abc" are both 5 seconds)
	while (i < value.length && !/[;,\t\n\f\r ]/.test(value[i])) i++;
	const time = value.slice(timeStart, i);
	space();
	if (i >= value.length) return { time, url: null };
	if (value[i] === ';' || value[i] === ',') i++;
	space();
	if (i >= value.length) return { time, url: null };
	if (/^url/i.test(value.slice(i, i + 3))) {
		let j = i + 3;
		while (j < value.length && /[\t\n\f\r ]/.test(value[j])) j++;
		if (value[j] === '=') {
			i = j + 1;
			space();
		}
		// `url` without `=`: the browser takes what follows as the URL
	}
	let url = value.slice(i);
	const quote = url[0];
	if (quote === '"' || quote === "'") {
		const close = url.indexOf(quote, 1);
		url = close === -1 ? url.slice(1) : url.slice(1, close);
	}
	url = url.trim();
	return { time, url: url === '' ? null : url };
}

// excellent resource
// https://web.archive.org/web/20210514140514/https://www.otsukare.info/2015/03/26/refresh-http-header
export function modifyRefresh(
	script: string,
	url: StompURL,
	config: Config,
	nested: string | false = false,
) {
	const { time, url: target } = parseRefresh(script);
	if (target === null) return script;
	let resolved: URL;
	try {
		resolved = new URL(target, url.toString());
	} catch (error) {
		return script;
	}
	if (!/^https?:$/.test(resolved.protocol)) return script;
	return `${time}; url=${routeHTML(
		new StompURL(resolved, url),
		url,
		config,
		false,
		nested,
	)}`;
}
