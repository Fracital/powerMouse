// Two rare navigations of a document's own, deferred parts of the document
// bundle (./deferredParts.ts) made at a document's first: the markup a
// javascript: URL's string value becomes (DocumentClient
// javascriptDocument), and navigation.navigate(url) (modules/History.ts).
// Few pages make either, and their frames fewer.
import { routeHTML } from '../../rewriteHTML';
import StompURL from '../../StompURL';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import type FragmentModule from './modules/Fragment';

/**
 * The document a javascript: URL's string value (`markup`) becomes, in the
 * shell with `client`'s page as its URL (as a blob document gets it), so
 * its scripts run injected
 */
export function javascriptDocument(
	client: DocumentClient,
	markup: string,
	documentURL?: string,
): string {
	// served by the worker as an inline document, so it is controlled and
	// its subresources reach the worker; the javascript: document itself is
	// a raw bootstrap that replaces itself with it. The replaced document
	// was an iframe's initial about:blank, whose URL strips to no referrer,
	// or another (an srcdoc), whose requests refer like the page
	const url = client.url.toString();
	const route = client.inlineDocument(
		markup,
		url,
		documentURL === 'about:blank' ? 'about:blank' : url,
	);
	// (the shell is a deferred part: without it the URL throws, and its
	// frame keeps the document it had)
	if (!route)
		return deferred('modifyHTML')(
			markup,
			client.url,
			client.config,
			true,
			undefined,
			client.scriptNonce,
		);
	// (with the nonce of the policy the document inherits from this one)
	const nonce = client.scriptNonce;
	return `<!doctype html><script${nonce ? ` nonce="${nonce.replace(/[^\w+/=-]/g, '')}"` : ''}>location.replace(${JSON.stringify(route).replace(/</g, '\\u003c')})</script>`;
}

/**
 * `navigation.navigate(...args)` of `client`'s own navigation (`target` the
 * browser's): the page's URL, resolved against its document's base URL as
 * natively (a `<base href>` moves a bare fragment to another document), is
 * routed as a navigation of the document is (location.assign, or with
 * `history: 'replace'` location.replace), and a fragment of this document
 * goes as written (`fragment`'s live). Unhooked, the URL
 * resolved against the proxy's address and the frame left the proxy for
 * the proxy origin's own path.
 */
export function navigationNavigate(
	client: DocumentClient,
	fragment: FragmentModule | undefined,
	target: Function,
	that: unknown,
	args: unknown[],
): unknown {
	let destination: URL;
	try {
		destination = new URL(String(args[0]), client.baseHref);
	} catch (error) {
		// the browser's own SyntaxError
		return Reflect.apply(target, that, args);
	}
	const options = args[1] as { history?: unknown } | undefined;
	const routed =
		options?.history === 'replace'
			? routeHTML(
					new StompURL(destination, client.url),
					client.url,
					client.config,
					false,
					client.nestedRoute,
				)
			: client.navigationRoute(destination);
	// to a fragment of this document as written
	const live =
		fragment?.live(new URL(routed, client.global.location.href).href) ?? routed;
	return Reflect.apply(target, that, [live, ...args.slice(1)]);
}
