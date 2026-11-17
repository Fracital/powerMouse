// An XMLHttpRequest response's document (./modules/XMLHttpRequest.ts): a
// `document` response, or the default type's responseXML of an XML one. A
// deferred part of the document bundle (./deferredParts.ts): most pages
// never read an XML response as a document. Its top level reads no global;
// what it reads of the browser is what the module took before the page
// ran.
import { ECHO_ROUTE } from '../../transport/messages';
import { trustedHTML } from '../trusted';
import { decodeText } from '../xhrText';
import type DocumentClient from './Client';
import DOMAttributesModule from './modules/DOMAttributes';

/** what the module hands responseParser: the realm's own, taken before the page ran */
export interface ParserRealm {
	client: DocumentClient;
	RealmXHR: typeof XMLHttpRequest;
	realmOpen: Function;
	realmSend: Function;
	realmSetType: Function;
	realmResponse: Function;
	realmResponseXML: Function;
	realmListen: Function;
	realmBtoa: Function;
	toBase64: ((this: Uint8Array) => string) | undefined;
	RealmDOMParser: typeof DOMParser;
	realmParse: Function;
	realmQuery: Function;
}

/**
 * The browser's document for `bytes` of type `essence` (`charset` as the
 * final charset): the `document` type's response, or (`asDocument` false)
 * the default type's responseXML; `done` gets it, at once for a
 * synchronous request
 */
export type ResponseParser = (
	bytes: ArrayBuffer,
	essence: string,
	charset: string | null,
	asDocument: boolean,
	sync: boolean,
	done: (document: Document | null) => void,
) => void;

/** parseResponse for one document's realm */
export function responseParser({
	client,
	RealmXHR,
	realmOpen,
	realmSend,
	realmSetType,
	realmResponse,
	realmResponseXML,
	realmListen,
	realmBtoa,
	toBase64,
	RealmDOMParser,
	realmParse,
	realmQuery,
}: ParserRealm): ResponseParser {
	const base64 = (bytes: ArrayBuffer): string => {
		const view = new Uint8Array(bytes);
		if (typeof toBase64 === 'function')
			return Reflect.apply(toBase64, view, []);
		let binary = '';
		for (let i = 0; i < view.length; i += 0x8000)
			binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
		return Reflect.apply(realmBtoa, client.global, [binary]);
	};
	const parseResponse: ResponseParser = (
		bytes,
		essence,
		charset,
		asDocument,
		sync,
		done,
	) => {
		const xhr = new RealmXHR();
		const read = () => {
			let document: Document | null = null;
			try {
				document = Reflect.apply(
					asDocument ? realmResponse : realmResponseXML,
					xhr,
					[],
				);
			} catch (error) {
				// nothing to read: null, as for a body that does not parse
			}
			done(document ?? null);
		};
		try {
			// a charset that is not a plain token cannot go in the data: URL
			const parameter =
				charset && /^[\w.:-]+$/.test(charset) ? `;charset=${charset}` : '';
			// A document whose policy refuses (or reports) a data: request
			// (its connect-src, src/csp.ts) would show the page a violation
			// of the proxy's: the bytes come back from the service worker's
			// echo instead, the proxy origin's, which the policy allows. A
			// synchronous request never reaches the worker (nor does one of
			// a document it does not control): the realm's DOMParser makes
			// the document.
			const refused = client.browserRefuses('connect-src', 'data:');
			if (
				refused &&
				(sync || client.getModule(DOMAttributesModule)?.uncontrolled?.())
			)
				return done(parsedText(bytes, essence, charset, asDocument));
			if (refused) {
				Reflect.apply(realmOpen, xhr, [
					'POST',
					`${client.global.location.origin}${client.directory}${ECHO_ROUTE}/${encodeURIComponent(`${essence}${parameter}`)}`,
					true,
				]);
				if (asDocument) Reflect.apply(realmSetType, xhr, ['document']);
				Reflect.apply(realmListen, xhr, ['loadend', read]);
				Reflect.apply(realmSend, xhr, [bytes]);
				return;
			}
			Reflect.apply(realmOpen, xhr, [
				'GET',
				`data:${essence}${parameter};base64,${base64(bytes)}`,
				!sync,
			]);
			if (asDocument) Reflect.apply(realmSetType, xhr, ['document']);
			if (!sync) Reflect.apply(realmListen, xhr, ['loadend', read]);
			Reflect.apply(realmSend, xhr, []);
		} catch (error) {
			return done(null);
		}
		if (sync) read();
	};
	/**
	 * The document of `bytes` the realm's DOMParser makes, as close to
	 * the browser's response document as it gets (for parseResponse's
	 * requests that cannot go through a URL): an HTML one for text/html
	 * (the document type only), an XML one for any XML type, null for XML
	 * that does not parse
	 */
	const parsedText = (
		bytes: ArrayBuffer,
		essence: string,
		charset: string | null,
		asDocument: boolean,
	): Document | null => {
		const html = essence === 'text/html';
		if (html && !asDocument) return null;
		try {
			const text = decodeText(bytes, charset, !html);
			const document = Reflect.apply(realmParse, new RealmDOMParser(), [
				trustedHTML(text),
				html
					? 'text/html'
					: ['text/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(
								essence,
						  )
						? essence
						: 'application/xml',
			]) as Document;
			if (!html && Reflect.apply(realmQuery, document, ['parsererror']))
				return null;
			return document;
		} catch (error) {
			return null;
		}
	};
	return parseResponse;
}
