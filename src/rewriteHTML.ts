import { escapeText } from 'entities';
import { Config } from './config';
import { CLIENT_KEY, modifyJS } from './rewriteJS';
import {
	createDataURI,
	injectDocumentJS,
	parseDataURI,
	routeURL,
} from './routeURL';
import StompURL from './StompURL';
import { WORKER_BASE } from './transport/messages';

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
export function routeHTML(
	resource: StompURL,
	url: StompURL,
	config: Config,
	form = false,
	nested: string | false = false,
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(resource.url.pathname);
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
		return `javascript:${modifyJS(body, url, config, 'generic')}`;
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

/**
 * The shell that stands in for a document: loads the inject bundle, creates
 * the client and hands it the real markup. A document whose own URL cannot
 * carry the page URL (a blob: document the page built) gets `base`: the
 * shell names the page URL for the client first.
 */
export function modifyHTML(
	script: string,
	url: StompURL,
	config: Config,
	base = false,
): string {
	// if(fragment) return '<script>document.currentScript.replaceWith(globalstomp.cloneIntoNewNode())
	const inject = `if (typeof globalThis.createClient !== 'function') {
	document.write("Stomp bundle did not load. See devtools output for more information.");
} else {
	if (!(${JSON.stringify(CLIENT_KEY)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

	if (!${CLIENT_KEY}.applied) try {
		${CLIENT_KEY}.apply();
	} catch(error) {
		document.write("Failure applying Stomp hooks. See devtools output for more information.");
		throw error;
	}

	try {
		${CLIENT_KEY}.loadHTML(${escapeText(JSON.stringify(script))});
	} catch(error) {
		document.write("Failure loading Stomp HTML. See devtools output for more information.");
		throw error;
	}
}`;

	const baseScript = base
		? `<script>globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(url.toString())};</script>`
		: '';
	return `<!DOCTYPE HTML><html><head><meta charset="utf-8" /></head><body>${baseScript}<script src="${injectDocumentJS(url, config)}"></script><script>${inject}</script></body></html>`;
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
	const inject = `if (typeof globalThis.createClient !== 'function') {
	document.documentElement.textContent = "Stomp bundle did not load. See devtools output for more information.";
} else {
	if (!(${JSON.stringify(CLIENT_KEY)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
	if (!${CLIENT_KEY}.applied) ${CLIENT_KEY}.apply();
	${CLIENT_KEY}.loadXML(${JSON.stringify(script)}, ${JSON.stringify(mime)});
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
