import type GenericCodec from './Codecs';
import { Config } from './config';
import type { ScriptFacts } from './csp';
import { helperNames } from './helperNames';
import type { modifyHTML } from './htmlShell';
import { rewriter } from './rewriters';
import { createDataURI, parseDataURI, routeURL } from './routeURL';
import type { SiteFacts } from './siteFacts';
import StompURL from './StompURL';
import { dataBody } from './urlShape';
import type { modifyXML } from './xmlShell';

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
 * The shells of a data: document routeHTML writes, by name: the HTML one
 * (src/htmlShell.ts modifyHTML) and the XML one (src/xmlShell.ts
 * modifyXML), the worker's own, deferred parts in a page (no document
 * bundle carries them), made at the first such document. An XML document
 * with no XML shell goes as it is; an HTML one with no HTML shell, or one
 * that cannot be had, is refused: an empty document in its place, never its
 * markup unrewritten.
 */
let documentShell:
	| ((
			name: 'modifyHTML' | 'modifyXML',
	  ) => typeof modifyHTML | typeof modifyXML | undefined)
	| null = null;
export function setDocumentShells(shell: typeof documentShell) {
	documentShell = shell;
}

export function routeHTML(
	resource: StompURL,
	url: StompURL,
	config: Config,
	form = false,
	nested: string | false = false,
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			dataBody(resource.url),
		);
		// a document of its mime: an XML one gets the XML shell (the HTML one
		// is no well-formed XML), one that is no document (an image, text)
		// runs nothing and goes as it is (no type is text/plain)
		const essence = mime.trim().toLowerCase();
		const xml = isXMLDocumentMime(essence)
			? (documentShell?.('modifyXML') as typeof modifyXML | undefined)
			: undefined;
		if (!xml && essence !== 'text/html') return resource.url.href;
		if (xml)
			return createDataURI({
				mime,
				data: xml(data, url, config, essence),
				attributes,
			});
		let html: typeof modifyHTML | undefined;
		try {
			html = documentShell?.('modifyHTML') as typeof modifyHTML | undefined;
		} catch (error) {
			// (the part cannot be had: refused, below)
		}
		return createDataURI({
			mime,
			data: html ? html(data, url, config) : '',
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
		const rewritten = modifyJS(body, url, config, 'generic', '', kept);
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
			return `javascript:${modifyJS(body, url, config, 'generic', `void (${inject});`, kept)}`;
		return `javascript:((r,c)=>typeof r==='string'&&c?c.javascriptDocument(r,document.URL):r)((${inject},(${expression})),self[${client}]||(()=>{try{return ${creator}}catch(e){}})())`;
	}

	return routeURL(
		`html${form ? ':form' : ''}${
			nested ? `:nested:${resource.codec.encode(nested)}` : ''
		}`,
		resource,
	);
}

/**
 * The top-level origin a routed document URL's kind names when it is a
 * nested document, else null. Works on any routed path (a request's own, or
 * its referrer's) of the controller whose codec is `codec`.
 */
export function nestedTopOf(
	pathname: string,
	directory: string,
	codec: GenericCodec,
): string | null {
	const mark = nestedMarkOf(pathname, directory, codec);
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
 * the same document (a redirect, a form's) passes it on. The kind holds it
 * as the codec writes a URL, so a nested document's address names its top
 * no more than its own URL.
 */
export function nestedMarkOfKind(
	kind: string,
	codec: GenericCodec,
): string | null {
	const match = /^html(?::form)?:nested:(.*)$/.exec(kind);
	if (!match) return null;
	try {
		return codec.decode(match[1]) || null;
	} catch (error) {
		return null;
	}
}

/** nestedMarkOfKind of a routed path's kind */
export function nestedMarkOf(
	pathname: string,
	directory: string,
	codec: GenericCodec,
): string | null {
	if (!pathname.startsWith(directory)) return null;
	return nestedMarkOfKind(
		pathname.slice(directory.length).split('/')[0],
		codec,
	);
}

/** what a shell written on this thread says of its document's script policy when its caller says nothing: the inject's client's */
let shellFacts: (() => ScriptFacts | undefined) | null = null;
export function provideShellFacts(provider: () => ScriptFacts | undefined) {
	shellFacts = provider;
}

/**
 * What a shell written on this thread says of its document's `sync-xhr` state
 * when its caller names none: the inject's client's, which the documents it
 * builds (a blob:, an srcdoc, a document.write) inherit from it, as the
 * permissions policy is inherited (src/server/clientHints.ts)
 */
let shellSyncXHR: (() => boolean) | null = null;
export function provideShellSyncXHR(provider: () => boolean) {
	shellSyncXHR = provider;
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

/** the shell's script facts, sync-XHR verdict and sites, where a provider gave them (src/htmlShell.ts, src/xmlShell.ts) */
export const providedShell = () => ({
	facts: shellFacts?.(),
	syncXHRBlocked: shellSyncXHR?.(),
	sites: shellSites?.(),
});

/** the mimes an XML document is served under and parsed with */
export const XML_DOCUMENT_MIMES = [
	'image/svg+xml',
	'application/xhtml+xml',
	'text/xml',
	'application/xml',
];

/**
 * Whether the browser shows a document of this mime (an essence, lower
 * case) as an XML document, whose XHTML scripts run and whose
 * xml-stylesheet instructions load: Blink's IsXMLMIMEType, any `+xml` type
 * as well (an RSS or Atom feed)
 */
export function isXMLDocumentMime(mime: string): boolean {
	return (
		XML_DOCUMENT_MIMES.includes(mime) ||
		/^[\w!#$&^.-]+\/[\w!#$&^.+-]+\+xml$/.test(mime)
	);
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
	// what the URL parser strips: C0 controls and space, not the Unicode
	// spaces String.prototype.trim drops too (a no-break space before
	// `javascript:` makes it a relative path, natively)
	url = url.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');
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
	// a data: document is the page's markup like a frame's data: src, and
	// Chrome follows a refresh to one in a frame: routeHTML rewrites it, or
	// its scripts run raw. A javascript: refresh Chrome never follows.
	if (!/^(https?|data):$/.test(resolved.protocol)) return script;
	return `${time}; url=${routeHTML(
		new StompURL(resolved, url),
		url,
		config,
		false,
		nested,
	)}`;
}
