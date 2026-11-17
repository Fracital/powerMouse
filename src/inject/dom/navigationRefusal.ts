// The SecurityError the browser throws for a navigation a document may not
// take over (src/inject/dom/modules/Visited.ts): a deferred part
// (./deferred.ts), made only when a page's intercept() is refused or a
// precommit handler redirects. Its top level reads no global
// (./deferredParts.ts).
import { withStack } from '../nativeErrors';
import type DocumentClient from './Client';

/**
 * The error of intercept() (`redirect` false) or of a precommit handler's
 * redirect() to `url`, worded as Chrome words it about this document's
 * real origin and URL
 */
export function navigationRefusal(
	client: DocumentClient,
	redirect: boolean,
	url: string,
): Error {
	const at = `with origin '${client.opaqueRequests ? 'null' : client.url.url.origin}' and URL '${client.url.url.href}'.`;
	return withStack(
		new client.global.DOMException(
			redirect
				? `Failed to execute 'redirect' on 'NavigationPrecommitController': Cannot redirect to '${url}' in a document ${at}`
				: `Failed to execute 'intercept' on 'NavigateEvent': A navigation with URL '${url}' cannot be intercepted by in a window ${at}`,
			'SecurityError',
		),
	);
}

/**
 * A precommit handler's redirect(url, options) (`call`: the native method,
 * the controller and the arguments): to the page's URL, resolved against its
 * own address and routed (`plain`), and only to one this document may have
 * (`rewritable`); the browser resolved it against the route and judged it
 * by the proxy's origin
 */
export function precommitRedirect(
	client: DocumentClient,
	[target, that, args]: [Function, unknown, unknown[]],
	rewritable: (url: URL) => boolean,
	plain: (url: URL) => string,
): unknown {
	const rest = args.slice(1);
	const text = `${args[0]}`;
	let url: URL;
	try {
		url = new URL(text, client.baseURL.toString());
	} catch (error) {
		return Reflect.apply(target, that, [text, ...rest]);
	}
	if (rewritable(url))
		return Reflect.apply(target, that, [plain(url), ...rest]);
	// the browser's checks of the controller's state come before the URL's:
	// one that does not parse passes them only
	try {
		Reflect.apply(target, that, ['http://[', ...rest]);
	} catch (error) {
		if ((error as Error)?.name !== 'SyntaxError') throw error;
	}
	throw navigationRefusal(client, true, url.href);
}
