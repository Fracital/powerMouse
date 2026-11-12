/**
 * The page's iframe sandbox, as the proxy applies it. The page's value is kept
 * in the frame's marker attribute (read back as written) and the real
 * attribute holds what the browser can enforce while the service worker
 * still serves the frame: the page's flags plus allow-same-origin (an opaque
 * origin's navigations never reach the worker) and allow-scripts (the inject
 * has to run to rewrite the document), and without the top navigation flags
 * (the browser's top is the host page, never the proxied page's top: the
 * inject navigates that one itself). What the browser no longer enforces
 * (scripts, the opaque origin, top navigation) the inject emulates from the
 * page's flags (DocumentClient.sandboxFlags).
 */

export { realSandbox, sandboxTokens } from '../../csp';

// taken while the bundle's realm is untouched: the page-facing getAttribute
// hides the marker
const nativeMarkerRead = Element.prototype.getAttribute;

/** the sandbox the page wrote on `frame` (its marker), or null without one */
export function pageSandbox(frame: Element, marker: string): string | null {
	return Reflect.apply(nativeMarkerRead, frame, [`${marker}sandbox`]) as
		string | null;
}

// taken while the bundle's realm is untouched: the guard is written with
// methods no hook or page can have replaced
const nativeCreateElement = Document.prototype.createElement;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativePrepend = Element.prototype.prepend;
const nativeHead = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'head',
)!.get!;
const nativeDocumentElement = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'documentElement',
)!.get!;

/** the Content-Security-Policy that lets only the inject's own scripts (`nonce`) run */
export function scriptPolicy(nonce: string): string {
	return `script-src 'nonce-${nonce}'`;
}

// the nonce of each document whose policy is in place: a frame's about:blank
// guarded by its parent (DOMAttributes) keeps it for the client the parent
// injects there later, which builds its shells with it
const nonces = new WeakMap<Document, string>();

/** the nonce of `document`'s script policy, or null when it has none */
export function documentNonce(document: Document): string | null {
	return nonces.get(document) ?? null;
}

const nativeCurrentScript = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'currentScript',
)!.get!;
const nativeNonce = Reflect.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	'nonce',
)!.get!;
const NONCE = /^[\w+/=-]+$/;

/**
 * The nonce the script running in `document` carries, or null: read while
 * a shell's own script makes the document's client, it is the nonce of
 * the policy the document inherited from the one that built the shell (an
 * about:srcdoc, about:blank, blob: or data: document of a document without
 * allow-scripts), which a shell's scripts are the only ones to carry
 * (src/rewriteHTML.ts).
 */
export function runningNonce(document: Document): string | null {
	try {
		const script = Reflect.apply(
			nativeCurrentScript,
			document,
			[],
		) as Element | null;
		if (!script) return null;
		const nonce: unknown = Reflect.apply(nativeNonce, script, []);
		return typeof nonce === 'string' && NONCE.test(nonce) ? nonce : null;
	} catch (error) {
		// an SVG script, or a document of another kind
		return null;
	}
}

/**
 * Put the script policy on `document` (once): a `<meta http-equiv>` in its
 * head (its documentElement when it has no head), which applies from the
 * moment it is inserted to everything the document runs afterwards,
 * survives the document.open() a written page goes through, and is
 * inherited by the about:blank, srcdoc, blob: and data: documents it
 * creates. Returns the policy's nonce, or null when the document has no
 * element to hold it yet.
 *
 * `inherited`: the nonce of a policy the document already runs under, the
 * one it inherited from the document that built its shell (runningNonce).
 * Its own policy then takes the same nonce: a script has to satisfy every
 * policy of a document, so a script the inject inserts later (the rewriter
 * library run with the nonce, src/inject/dom/rewriterRealm.ts) carrying a
 * nonce of its own would be refused by the inherited one.
 */
export function guardDocument(
	document: Document,
	inherited?: string | null,
): string | null {
	const known = nonces.get(document);
	if (known !== undefined) return known;
	const parent = (Reflect.apply(nativeHead, document, []) ??
		Reflect.apply(nativeDocumentElement, document, [])) as Element | null;
	if (!parent) return null;
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const nonce =
		inherited && NONCE.test(inherited)
			? inherited
			: [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	const meta = Reflect.apply(nativeCreateElement, document, [
		'meta',
	]) as Element;
	Reflect.apply(nativeSetAttribute, meta, [
		'http-equiv',
		'Content-Security-Policy',
	]);
	Reflect.apply(nativeSetAttribute, meta, ['content', scriptPolicy(nonce)]);
	Reflect.apply(nativePrepend, parent, [meta]);
	nonces.set(document, nonce);
	return nonce;
}

const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
const nativeReplaceWith = Element.prototype.replaceWith;
const nativeChildNodes = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'childNodes',
)!.get!;

const nativeTextContent = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'textContent',
)!;
const nativeTextContentSet = nativeTextContent.set!;
const nativeTextContentGet = nativeTextContent.get!;

/**
 * Keep what `<noscript>` holds as its text, as a document that runs scripts
 * parses it: the page's markup was parsed with scripting disabled, so its
 * noscript elements hold elements, and the copy the inject makes of them in
 * the page's document would start their loads (a tracking pixel in a
 * noscript block was fetched by every proxied page). Their markup, as
 * written in the parsed document (`innerHTML`, the native getter), becomes
 * their text, which serialises back as it was.
 */
export function textifyNoscript(
	root: Element,
	innerHTML: (element: Element) => string,
) {
	for (const element of Reflect.apply(nativeQuerySelectorAll, root, [
		'noscript',
	]) as Iterable<Element>)
		Reflect.apply(nativeTextContentSet, element, [innerHTML(element)]);
}

/**
 * The markup of `root`'s children as a document that runs scripts
 * serializes them: a noscript element's text (textifyNoscript) raw. A copy
 * made in an inert document, where scripting is disabled, escapes it, and
 * the parser of the document it is written into would read `&lt;style&gt;`
 * where the page wrote `<style>`. Each noscript's text stands in as a token
 * while the copy is serialized and goes back raw.
 */
export function serializeScripted(
	root: Element,
	innerHTML: (element: Element) => string,
): string {
	const noscripts = [
		...(Reflect.apply(nativeQuerySelectorAll, root, [
			'noscript',
		]) as Iterable<Element>),
	];
	if (!noscripts.length) return innerHTML(root);
	const token = `$stomp$noscript${Math.random().toString(36).slice(2)}`;
	const texts: string[] = [];
	for (const element of noscripts) {
		texts.push(Reflect.apply(nativeTextContentGet, element, []) as string);
		Reflect.apply(nativeTextContentSet, element, [
			`${token}:${texts.length - 1};`,
		]);
	}
	const html = innerHTML(root);
	noscripts.forEach((element, index) =>
		Reflect.apply(nativeTextContentSet, element, [texts[index]]),
	);
	return html.replace(
		new RegExp(`${token.replace(/\$/g, '\\$')}:(\\d+);`, 'g'),
		(match, index) => texts[Number(index)],
	);
}

/**
 * Show what `<noscript>` holds, as a document that runs no script shows it:
 * the page's markup was parsed with scripting disabled (its noscript
 * elements hold elements), but the document it is written into runs the
 * inject, and its parser would make them text again. Each noscript element
 * gives way to its children.
 */
export function unwrapNoscript(root: Element) {
	for (const element of Reflect.apply(nativeQuerySelectorAll, root, [
		'noscript',
	]) as Iterable<Element>)
		Reflect.apply(nativeReplaceWith, element, [
			...(Reflect.apply(nativeChildNodes, element, []) as NodeList),
		]);
}

const nativeRemove = Element.prototype.remove;
const nativeGetAttributeNames = Element.prototype.getAttributeNames;
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeRemoveAttribute = Element.prototype.removeAttribute;

/**
 * Take every script out of an XML document's tree (a standalone SVG, an
 * XHTML page) for a document without allow-scripts. The script policy
 * cannot hold there (a policy's meta element counts only as a child of an
 * HTML head), so what would run goes before the tree lands: script
 * elements, event handler attributes, and any attribute whose value is a
 * javascript: URL (a link's href, an animation's `to` or `values`).
 */
export function stripScripts(root: Element) {
	const elements = [
		root,
		...(Reflect.apply(nativeQuerySelectorAll, root, [
			'*',
		]) as Iterable<Element>),
	];
	for (const element of elements) {
		if ((element.localName || '').toLowerCase() === 'script') {
			Reflect.apply(nativeRemove, element, []);
			continue;
		}
		for (const name of Reflect.apply(
			nativeGetAttributeNames,
			element,
			[],
		) as string[]) {
			const value = Reflect.apply(nativeGetAttribute, element, [name]) as
				string | null;
			const local = name.slice(name.indexOf(':') + 1).toLowerCase();
			if (
				local.startsWith('on') ||
				// a URL parser drops spaces and control characters around and
				// inside the scheme
				/javascript:/i.test(
					[...(value ?? '')]
						.filter((character) => character.charCodeAt(0) > 0x20)
						.join(''),
				)
			)
				Reflect.apply(nativeRemoveAttribute, element, [name]);
		}
	}
}
