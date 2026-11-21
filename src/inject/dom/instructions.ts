// The deferred side of xml-stylesheet processing instructions
// (./stylesheetPIs.ts) and of an XML document's prolog
// (Client.loadXML): what routes, reads back and edits a PI's data, and the
// XSLT an XML document's prolog names; and the loading of an XML document
// itself (loadXML). A deferred part (./deferredParts.ts): most documents
// never meet a stylesheet PI, and few are XML.
import { routeCSS } from '../../cssURLs';
import { XML_DOCUMENT_MIMES } from '../../rewriteHTML';
import { routeURL } from '../../routeURL';
import StompURL from '../../StompURL';
import {
	mapStylesheetHref,
	pseudoAttributes,
	stylesheetKind,
} from '../../xmlStylesheet';
import ProxyModule from '../modules/Proxy';
import { unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';
import { runDocumentOpenListeners, setGlobalParsingState } from './Client';
import cloneRawNode, { nativeAttributes, parseHTML } from './cloneNode';
import { stripScripts } from './sandbox';
import { isStylesheetPI, type InstructionNatives } from './stylesheetPIs';

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** how many routed data strings are remembered for their readback */
const KEPT = 256;

/**
 * What a realm's stylesheet PIs read and are given, with the natives taken
 * at boot; made at the first one (./stylesheetPIs.ts), which also hooks the
 * PI prototype's own pseudo-attribute methods where the browser has them
 * (Chrome 157 has none)
 */
export function instructionData(
	client: DocumentClient,
	{ getData, setData, createPI, nodeTypeGet, parentGet }: InstructionNatives,
) {
	const call = (method: Method, that: unknown, ...args: unknown[]) =>
		Reflect.apply(method, that, args);
	const inDocument = (pi: ProcessingInstruction) => {
		const parent = call(parentGet, pi);
		return parent !== null && call(nodeTypeGet, parent) === 9;
	};
	// routed data -> the page's, for the readbacks of a PI and of its clones
	const pages = new Map<string, string>();
	const keep = (real: string, page: string) => {
		pages.delete(real);
		pages.set(real, page);
		if (pages.size > KEPT) pages.delete(pages.keys().next().value!);
	};
	const unrouted = (real: string): string =>
		pages.get(real) ??
		mapStylesheetHref(real, (href) => unrouteURL(client, href)) ??
		real;
	const routed = (page: string): string =>
		mapStylesheetHref(page, (href) => {
			try {
				const resource = new StompURL(
					new URL(href, client.baseHref),
					client.baseURL,
				);
				return stylesheetKind(page) === 'xsl'
					? routeURL('binary', resource)
					: routeCSS(resource, client.baseURL);
			} catch (error) {
				// no URL: loads nothing either way
				return null;
			}
		}) ?? page;
	const pageOf = (pi: ProcessingInstruction) =>
		unrouted(call(getData, pi) as string);
	/** give `pi` the page's `page` data, routed where it loads (or will: `landing`) */
	const settle = (pi: ProcessingInstruction, page: string, landing = false) => {
		const real = landing || inDocument(pi) ? routed(page) : page;
		if (real !== page) keep(real, page);
		call(setData, pi, real);
	};
	/** a detached PI holding the page's data of `pi` */
	const copyOf = (pi: ProcessingInstruction) => {
		const copy = call(createPI, client.global.document, 'xml-stylesheet', '');
		call(setData, copy, pageOf(pi));
		return copy as ProcessingInstruction;
	};
	/** run `edit` on a detached copy holding the page's data, then settle */
	const edited = (pi: ProcessingInstruction, edit: (copy: Node) => unknown) => {
		const copy = copyOf(pi);
		const result = edit(copy);
		settle(pi, call(getData, copy) as string);
		return result;
	};
	// its pseudo-attributes: an edit, or a read of the page's data
	const proxyModule = client.getModule(ProxyModule)!;
	const proto = Reflect.getPrototypeOf(
		call(createPI, client.global.document, 'xml-stylesheet', '') as object,
	) as Record<string, unknown> | null;
	const wrap = (
		name: string,
		handler: (target: Method, that: unknown, args: unknown[]) => unknown,
	) => {
		const native = proto?.[name];
		if (typeof native === 'function')
			proto![name] = proxyModule.wrapFunction(native as Method, handler);
	};
	for (const name of ['setAttribute', 'removeAttribute', 'toggleAttribute'])
		wrap(name, (target, that, args) =>
			isStylesheetPI(that)
				? edited(that, (copy) => Reflect.apply(target, copy, args))
				: Reflect.apply(target, that, args),
		);
	wrap('getAttribute', (target, that, args) =>
		Reflect.apply(target, isStylesheetPI(that) ? copyOf(that) : that, args),
	);
	const PI = /<\?xml-stylesheet ([^>]*?)\??>/g;
	return {
		pageOf,
		settle,
		copyOf,
		edited,
		/** serialized markup with each PI as the page wrote it */
		fold: (markup: string) =>
			markup.replace(PI, (whole, data: string) => {
				const page = unrouted(data);
				return page === data ? whole : whole.replace(data, page);
			}),
	};
}

/**
 * An XML document's prolog and epilog (its processing instructions and
 * comments, around the root) as natively: `land` puts them around the
 * root, or, where an xml-stylesheet PI of the prolog names an XSLT, the
 * transform's output stands for the document (`replace`), as the browser's
 * parser makes it at its end. The stylesheet is fetched through the proxy,
 * from the document's own origin only (Chrome refuses any other), its
 * imports and includes routed; one that fails to load or transform leaves
 * the document as it is. A browser without XSLT (Chrome 158 removed it)
 * neither fetches the stylesheet nor transforms: the PI is no more than a
 * node there, and the document lands as it is.
 */
export function xmlProlog(
	client: DocumentClient,
	parsed: Document,
	root: Element,
	land: (prolog: Node[], epilog: Node[]) => void,
	replace: (root: Element) => void,
) {
	const prolog: Node[] = [];
	const epilog: Node[] = [];
	let xslt: string | null = null;
	for (const node of Array.from(parsed.childNodes)) {
		if (node === root || (node.nodeType !== 7 && node.nodeType !== 8)) continue;
		const before = root.compareDocumentPosition(node) & 2;
		if (
			before &&
			xslt === null &&
			node.nodeType === 7 &&
			(node as ProcessingInstruction).target === 'xml-stylesheet' &&
			stylesheetKind((node as ProcessingInstruction).data) === 'xsl'
		)
			xslt = pseudoAttributes((node as ProcessingInstruction).data)!.get(
				'href',
			)!.value;
		(before ? prolog : epilog).push(node);
	}
	if (xslt === null || typeof client.global.XSLTProcessor !== 'function')
		return land(prolog, epilog);
	const url = new URL(xslt, client.url.toString());
	const route = (target: string) =>
		new URL(
			routeURL('binary', new StompURL(new URL(target, url), client.url)),
			client.global.location.href,
		).href;
	(async () => {
		if (url.origin !== client.url.url.origin) throw new Error('cross-origin');
		const response = await client.nativeFetch(route(url.href));
		if (!response.ok) throw new Error(String(response.status));
		const sheet = new client.global.DOMParser().parseFromString(
			await response.text(),
			'text/xml',
		);
		const XSL = 'http://www.w3.org/1999/XSL/Transform';
		for (const name of ['import', 'include'])
			for (const element of Array.from(
				sheet.getElementsByTagNameNS(XSL, name),
			)) {
				const target = element.getAttribute('href');
				if (target !== null) element.setAttribute('href', route(target));
			}
		const processor = new client.global.XSLTProcessor();
		processor.importStylesheet(sheet);
		const output = processor.transformToDocument(parsed)?.documentElement;
		if (!output) throw new Error('no output');
		replace(output);
	})().catch(() => land(prolog, epilog));
}

/**
 * Load an XML document (a standalone SVG, an XHTML page, any other XML
 * document) served through the XML shell (src/xmlShell.ts, which calls the
 * client's loadXML): parsed with its own mime, its scripts rewritten, its
 * tree re-created through the hooks in this document (namespaces kept)
 * under the shell's root, since an XML document has no document.write.
 * Scripts run as the tree lands, like a parser's would. The prolog's
 * processing instructions and comments land around the root as natively (an
 * xml-stylesheet one loads its sheet, routed by ./stylesheetPIs.ts); an XSLT
 * one transforms the document instead, as the browser's parser does at its
 * end.
 */
export function loadXML(client: DocumentClient, markup: string, mime: string) {
	const global = client.global;
	const parsed = parseHTML(
		markup,
		global.document,
		(XML_DOCUMENT_MIMES.includes(mime)
			? mime
			: 'application/xml') as DOMParserSupportedType,
	);
	const root = parsed.documentElement;
	const live = global.document.documentElement;
	if (!root || !live) return;
	const land = (prolog: Node[] = [], epilog: Node[] = []) => {
		client.refreshSandbox();
		if (!client.allows('allow-scripts')) stripScripts(root);
		setGlobalParsingState(global, 'parsingBeforeWrite');
		client.rewriteInlineScripts(root, true);
		const page = global.document;
		// (through the insertion hooks, which route a stylesheet PI's href)
		for (const node of prolog) page.insertBefore(page.importNode(node), live);
		for (const node of epilog) page.appendChild(page.importNode(node));
		// The shell's root is the document's own start tag, so it stays (a
		// root put in its place would not carry the title: Chrome's
		// document.title only follows an SVG <title> that is inserted under
		// the connected root). Its attributes are set again, through the
		// hooks, and the shell's scripts give way to the page's children.
		for (const attribute of Array.from(
			Reflect.apply(nativeAttributes, live, []) as NamedNodeMap,
		))
			if (attribute.namespaceURI)
				live.setAttributeNS(
					attribute.namespaceURI,
					attribute.name,
					attribute.value,
				);
			else live.setAttribute(attribute.name, attribute.value);
		while (live.firstChild) live.removeChild(live.firstChild);
		const clone = cloneRawNode(root, page, true);
		setGlobalParsingState(global);
		live.append(clone);
		runDocumentOpenListeners(global);
	};
	// a document with nothing but its root (most): no prolog to read
	if (parsed.childNodes.length === 1) return land();
	xmlProlog(client, parsed, root, land, (output) => {
		const page = global.document;
		client.refreshSandbox();
		if (!client.allows('allow-scripts')) stripScripts(output);
		setGlobalParsingState(global, 'parsingBeforeWrite');
		client.rewriteInlineScripts(output, true);
		const clone = cloneRawNode([output], page, true);
		setGlobalParsingState(global);
		page.replaceChild(clone, live);
		runDocumentOpenListeners(global);
	});
}
