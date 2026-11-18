// The rare branches of DOMAttributes' hooks (./modules/DOMAttributes.ts): a
// frame whose src is a data: document, a refresh meta, and the report of a
// base a report-only base-uri refuses. A deferred part (./deferredParts.ts),
// made by the hook before it writes anything for the browser: most
// documents never have one. With the HTML shell (../../htmlShell.ts), which
// a data: frame's document gets where no worker serves it.
import { modifyHTML } from '../../htmlShell';
import { modifyRefresh } from '../../refresh';
import { parseDataURI, proxyBlobURL } from '../../routeURL';
import type StompURL from '../../StompURL';
import { dataBody } from '../../urlShape';
import type { LazyWeakSet } from '../ownCollections';
import DocumentClient, { addDocumentOpenListener } from './Client';
import type { CustomElement } from './modules/DOMHooks';

/**
 * A frame whose src is a data: document gets an opaque origin, which the
 * inject cannot reach: its requests would have nowhere to go and its
 * messages no route to the page. It loads instead from a blob: URL of the
 * shell with the data: URL itself as the document's URL, so it runs
 * injected and same-origin underneath, while every readback treats it as
 * the opaque origin "null" it is: its location is the data: URL, its
 * origin "null", and the page and the frame see each other through the
 * restricted cross-origin stand-ins (contentDocument null), as for any
 * frame of another real origin. Best effort, as every proxied cross-origin
 * frame is in same-origin mode. Null for a data: URL that is no HTML
 * document. `NativeBlob`: the realm's, taken at boot.
 */
export function opaqueDocument(
	client: DocumentClient,
	resource: StompURL,
	NativeBlob: typeof Blob,
): string | null {
	const { mime, data } = parseDataURI(dataBody(resource.url));
	if (
		!/^\s*(text\/html|application\/xhtml\+xml)\s*$/i.test(mime || 'text/plain')
	)
		return null;
	// served by the worker as an inline document (controlled, its
	// subresources reaching the worker); its requests refer as a data:
	// document does, with nothing. Without a worker to register with, the
	// shell is a blob as before (subresources then miss the worker)
	const inline = client.inlineDocument(data, resource.url.href, 'data:,');
	if (inline) return inline;
	const blob = new NativeBlob(
		[
			modifyHTML(
				data,
				resource,
				client.config,
				true,
				undefined,
				client.scriptNonce,
			),
		],
		{ type: 'text/html' },
	);
	return proxyBlobURL(client.global.URL.createObjectURL(blob));
}

/** a refresh meta's content, routed (the page's kept for its readback) */
export function metaRefresh(client: DocumentClient, element: CustomElement) {
	const content = element.getAttribute('content')!;
	element.setAttributeOG('content', content);
	element.setAttribute(
		'content',
		modifyRefresh(content, client.baseURL, client.config, client.nestedRoute),
	);
}

/**
 * A report-only base-uri's refusal is the inject's to report (the base
 * applies): once, for the document's first base, a task later as natively,
 * and for the markup's own once it is parsed (the hook ran on its copy,
 * before the page's scripts could listen). `reported`: the bases reported.
 */
export function reportBase(
	client: DocumentClient,
	element: Element,
	url: URL,
	reported: LazyWeakSet<Element>,
) {
	const global = client.global;
	const owner = element.ownerDocument;
	const first = owner.querySelector('base[href]');
	if (reported.has(element) || (first !== element && first !== null)) return;
	reported.add(element);
	const report = () => client.reportRefusal('base-uri', url);
	if (owner === global.document) {
		Reflect.apply(setTimeout, global, [report, 0]);
		return;
	}
	// (the markup is written after a document.open, which drops the
	// document's listeners)
	let pending = true;
	addDocumentOpenListener(global, () => {
		if (!pending) return;
		pending = false;
		global.document.addEventListener('DOMContentLoaded', report, {
			once: true,
		});
	});
}
