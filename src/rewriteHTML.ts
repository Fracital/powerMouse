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

export function routeHTML(
	resource: StompURL,
	url: StompURL,
	config: Config,
	form = false,
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

	return routeURL(form ? 'html:form' : 'html', resource);
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
	return `<!DOCTYPE HTML><html><head><meta charset="utf-8" /></head><body>${baseScript}<script src="${injectDocumentJS(
		url,
	)}"></script><script>${inject}</script></body></html>`;
}

const REFRESH = /(;\s*?|^)url=(?:(['"])(((?!\2).)*)\2?|(.*);?)/i;

// excellent resource
// https://web.archive.org/web/20210514140514/https://www.otsukare.info/2015/03/26/refresh-http-header
export function modifyRefresh(script: string, url: StompURL, config: Config) {
	return script.replace(
		REFRESH,
		(_match, pre, _1, resource1, _3, resource2) => {
			const resource: string = resource1 || resource2;

			return `${pre}url=${routeHTML(
				new StompURL(new URL(resource, url.toString()), url),
				url,
				config,
			)}`;
		},
	);
}
