import { escapeText } from 'entities';
import { parse } from 'meriyah';
import { Config } from './config';
import { helperNames } from './helperNames';
import type { Prewritten } from './prewrite';
import type { ReferrerInfo } from './referrerPolicy';
import { modifyJS } from './rewriteJS';
import {
	createDataURI,
	injectDocumentJS,
	parseDataURI,
	routeURL,
} from './routeURL';
import type { ControlInfo } from './serviceWorkerTypes';
import StompURL from './StompURL';
import { SW_CONTROL, WORKER_BASE } from './transport/messages';

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
	const single = (code: string) => {
		try {
			const program = parse(code, { next: true });
			return (
				program.body.length === 1 &&
				program.body[0].type === 'ExpressionStatement'
			);
		} catch (error) {
			return false;
		}
	};
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
			resource.url.pathname + resource.url.search,
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
		// its own client, and nothing happens).
		const inject = `self[${client}]||(()=>{try{parent[${client}].injectChild(self)}catch(e){}})()`;
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
		return `javascript:((r,c)=>typeof r==='string'&&c?c.javascriptDocument(r,document.URL):r)((${inject},(${expression})),self[${client}]||(()=>{try{return parent[${client}]}catch(e){}})())`;
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
	if (!pathname.startsWith(directory)) return null;
	const kind = pathname.slice(directory.length).split('/')[0];
	const match = /^html(?::form)?:nested:(.*)$/.exec(kind);
	if (!match) return null;
	try {
		return new URL(decodeURIComponent(match[1])).origin;
	} catch (error) {
		return null;
	}
}

/** the shell's statement that hands the client its document's referrer (none without one) */
function referred(client: string, referrer: ReferrerInfo | undefined): string {
	if (!referrer) return '';
	// a URL's query may hold `<`: never let it close the shell's script
	const info = JSON.stringify(referrer).replace(/</g, '\\u003c');
	return `\t${client}.setReferrer(document, ${info});`;
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
 * and only the shell's own scripts carry the nonce.
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
): string {
	// if(fragment) return '<script>document.currentScript.replaceWith(globalstomp.cloneIntoNewNode())
	const names = helperNames(config);
	const controlled = control
		? `globalThis[${JSON.stringify(SW_CONTROL)}] = ${JSON.stringify(control).replace(/</g, '\\u003c')};\n\t`
		: '';
	const inject = `if (typeof globalThis.createClient !== 'function') {
	document.write("Stomp bundle did not load. See devtools output for more information.");
} else {
	${controlled}if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

${referred(names.client, referrer)}
	if (!${names.client}.applied) try {
		${names.client}.apply(true);
	} catch(error) {
		document.write("Failure applying Stomp hooks. See devtools output for more information.");
		throw error;
	}

	try {
		${names.client}.loadHTML(${escapeText(JSON.stringify(script))}${
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
	const baseScript = base
		? `<script${attribute}>globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(url.toString()).replace(/</g, '\\u003c')};</script>`
		: '';
	return `<!DOCTYPE HTML><html><head><meta charset="utf-8" /></head><body>${baseScript}<script${attribute} src="${injectDocumentJS(url, config)}"></script><script${attribute}>${inject}</script></body></html>`;
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
): string {
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
	if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
${referred(names.client, referrer)}
	if (!${names.client}.applied) ${names.client}.apply();
	${names.client}.loadXML(${JSON.stringify(script)}, ${JSON.stringify(mime)});
}`;
	const xhtml = 'http://www.w3.org/1999/xhtml';
	return `<?xml version="1.0" encoding="UTF-8"?>${root}<script xmlns="${xhtml}" src="${injectDocumentJS(url, config)}"></script><script xmlns="${xhtml}">${cdata(inject)}</script></${name}>`;
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
