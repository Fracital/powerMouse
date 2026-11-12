import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import {
	ABORT_HEADER,
	CREDENTIALS_HEADER,
	ECHO_ROUTE,
	OPAQUE_HEADER,
	PREFLIGHT_HEADER,
} from '../../../transport/messages';
import Module from '../../Module';
import {
	adoptTypeMark,
	isStompHeader,
	pageHeaderRecord,
	reportOnly,
} from '../../modules/Fetch';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule, { classConstant, onEventTarget } from '../../modules/Proxy';
import UnrouteModule, { unrouteURL } from '../../modules/Unroute';
import { trackUploadListeners } from '../../uploadListeners';
import {
	decodeText,
	finalMime,
	isXMLType,
	overrideMime,
	type MimeType,
} from '../../xhrText';
import DocumentClient from '../Client';
import { responseURLs } from '../responseDocuments';
import BlobDocumentsModule from './BlobDocuments';
import DOMAttributesModule from './DOMAttributes';
import SyncModule from './Sync';

export default class XMLHttpRequestModule extends Module<DocumentClient> {
	/** the realm's listener count (src/inject/uploadListeners.ts), which the Visited module keeps for `navigation` too */
	listeners?: ReturnType<typeof trackUploadListeners>;
	apply() {
		const instances = new WeakSet();
		const real = Symbol();
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		const proxyModule = this.client.getModule(ProxyModule)!;
		const syncModule = that.client.getModule(SyncModule)!;
		// a blob response is the bytes the site sent: the page's Blob (wrapped
		// by BlobDocuments) would turn an HTML one into the inject's shell
		const NativeBlob =
			that.client.getModule(BlobDocumentsModule)?.nativeBlob ??
			that.client.global.Blob;

		class XMLHttpRequestEventTargetProxy extends EventTarget {
			constructor(key: symbol) {
				if (key === real) {
					super();
					instances.add(this);
				} else {
					throw new TypeError(`Illegal constructor`);
				}
			}
		}

		class XMLHttpRequestUploadProxy extends XMLHttpRequestEventTargetProxy {}

		// an upload object with listeners sets the CORS-preflight flag
		const uploads = trackUploadListeners(that.client.global, proxyModule, () =>
			that.client.getModule(UnrouteModule)?.noteReportSite(),
		);

		this.listeners = uploads;

		const decoder = new TextDecoder('utf-8');

		// whether the document's permissions policy lets it make a
		// synchronous request (Chrome's `sync-xhr`)
		const global = that.client.global as typeof globalThis & {
			FeaturePolicy?: { prototype: { allowsFeature?: unknown } };
		};
		const featurePolicy = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'featurePolicy',
		)?.get;
		const allowsFeature = global.FeaturePolicy?.prototype.allowsFeature;
		const syncAllowed = (): boolean => {
			if (!featurePolicy || typeof allowsFeature !== 'function') return true;
			try {
				return !!Reflect.apply(
					allowsFeature,
					Reflect.apply(featurePolicy, global.document, []),
					['sync-xhr'],
				);
			} catch (error) {
				return true;
			}
		};

		// A response's document is made by the browser itself: the realm's own
		// XMLHttpRequest (taken before this module replaces it) reads the
		// response's bytes from a data: URL of its final type, so the document
		// is the one Chrome makes (its charset from a meta or an XML
		// declaration, any XML type, null for XML that does not parse, an HTML
		// one left 'interactive'), in the page's realm. Its URL is read back
		// as the response's (responseDocuments).
		const RealmXHR = that.client.global.XMLHttpRequest;
		const realmAccessor = (name: string) =>
			Reflect.getOwnPropertyDescriptor(RealmXHR.prototype, name)!;
		const realmOpen = realmAccessor('open').value;
		const realmSend = realmAccessor('send').value;
		const realmSetType = realmAccessor('responseType').set!;
		const realmResponse = realmAccessor('response').get!;
		const realmResponseXML = realmAccessor('responseXML').get!;
		const realmListen =
			that.client.global.EventTarget.prototype.addEventListener;
		const realmBtoa = that.client.global.btoa;
		const toBase64 = (
			Uint8Array.prototype as { toBase64?: (this: Uint8Array) => string }
		).toBase64;
		const base64 = (bytes: ArrayBuffer): string => {
			const view = new Uint8Array(bytes);
			if (typeof toBase64 === 'function')
				return Reflect.apply(toBase64, view, []);
			let binary = '';
			for (let i = 0; i < view.length; i += 0x8000)
				binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
			return Reflect.apply(realmBtoa, that.client.global, [binary]);
		};
		/**
		 * The browser's document for `bytes` of type `essence` (`charset` as the
		 * final charset): the `document` type's response, or (`asDocument`
		 * false) the default type's responseXML; `done` gets it, at once for a
		 * synchronous request
		 */
		const parseResponse = (
			bytes: ArrayBuffer,
			essence: string,
			charset: string | null,
			asDocument: boolean,
			sync: boolean,
			done: (document: Document | null) => void,
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
				const refused = that.client.browserRefuses('connect-src', 'data:');
				if (
					refused &&
					(sync || that.client.getModule(DOMAttributesModule)?.uncontrolled?.())
				)
					return done(parsedText(bytes, essence, charset, asDocument));
				if (refused) {
					Reflect.apply(realmOpen, xhr, [
						'POST',
						`${that.client.global.location.origin}${that.client.directory}${ECHO_ROUTE}/${encodeURIComponent(`${essence}${parameter}`)}`,
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
		const RealmDOMParser = that.client.global.DOMParser;
		const realmParse = RealmDOMParser.prototype.parseFromString;
		const realmQuery = that.client.global.Document.prototype.querySelector;
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
					text,
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
		// the realm's JSON.parse, before page code can replace it: a json
		// response is the page realm's value
		const realmJSON = that.client.global.JSON;
		const parseJSON = realmJSON.parse;

		const XMLHttpRequestResponseType = [
			'',
			'arraybuffer',
			'blob',
			'document',
			'json',
			'text',
			'moz-chunked-arraybuffer',
			'ms-stream',
		];

		const UNSENT = 0;
		const OPENED = 1;
		const HEADERS_RECEIVED = 2;
		const LOADING = 3;
		const DONE = 4;

		class XMLHttpRequestProxy extends XMLHttpRequestEventTargetProxy {
			constructor() {
				super(real);
			}
			#headers = new Headers({
				'sec-fetch-dest': 'empty',
			});
			#responseHeaders = new Headers();
			#override: MimeType | null = null;
			#method = '';
			#url = '';
			#async = true;
			// open()'s user and password (null: the URL's own stand)
			#username: string | null = null;
			#password: string | null = null;
			// the request's URL with its credentials (what responseURL shows for
			// its response, as natively) and without (the route's), fragment
			// dropped, when it has credentials
			#credentialed: { shown: string; plain: string } | null = null;
			// open()'s or the URL's user:password, for the worker's Basic answer
			#urlCredentials: string | null = null;
			// the URL send() requested, as the page named it (a synchronous
			// request's NetworkError names it)
			#sentURL = '';
			#responseType = '';
			#responseText = '';
			#readyState = UNSENT;
			#responseURL = '';
			#responseXML: Document | null = null;
			#response: unknown = null;
			// the response's bytes once it is done (json is parsed from them)
			#body: ArrayBuffer | null = null;
			// bumped by open(): a response of an earlier request is dropped
			#generation = 0;
			#status = 0;
			#statusText = '';
			#abort = new AbortController();
			#timeout = 0;
			#timer: ReturnType<typeof setTimeout> | undefined;
			#withCredentials = false;
			#sent = false;
			#bodySize = 0;
			#upload = (() => {
				const upload = new XMLHttpRequestUploadProxy(real);
				uploads.track(upload);
				return upload;
			})();
			get upload() {
				return this.#upload;
			}
			get timeout() {
				return this.#timeout;
			}
			set timeout(value) {
				if (!this.#async && typeof document !== 'undefined')
					throw new DOMException(
						"Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.",
						'InvalidAccessError',
					);
				this.#timeout = Math.max(0, Number(value) || 0);
			}
			get withCredentials() {
				return this.#withCredentials;
			}
			set withCredentials(value) {
				if (this.#sent || this.#loadingOrDone)
					throw new DOMException(
						"Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.",
						'InvalidStateError',
					);
				this.#withCredentials = !!value;
			}
			#end(name: 'timeout' | 'error' | 'abort') {
				clearTimeout(this.#timer);
				this.#readyState = DONE;
				this.#status = 0;
				this.#statusText = '';
				this.#body = null;
				// an empty string for a text type, null for the others, as the browser
				this.#response =
					this.#responseType === '' || this.#responseType === 'text'
						? ''
						: null;
				this.#responseText = '';
				this.#dispatchReadyState();
				if (this.#bodySize) {
					this.#upload.dispatchEvent(new ProgressEvent(name));
					this.#upload.dispatchEvent(new ProgressEvent('loadend'));
				}
				this.dispatchEvent(new ProgressEvent(name));
				this.dispatchEvent(new ProgressEvent('loadend'));
			}
			get status() {
				return this.#status;
			}
			get statusText() {
				return this.#statusText;
			}
			#dispatchReadyState() {
				if (!this.#async && this.#readyState !== DONE) {
					return;
				}

				this.dispatchEvent(new Event('readystatechange'));
			}
			get #loadingOrDone() {
				return this.#readyState === LOADING || this.#readyState === DONE;
			}
			get responseText() {
				if (this.#responseType !== '' && this.#responseType !== 'text')
					throw new DOMException(
						`Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${
							this.#responseType
						}').`,
						'InvalidStateError',
					);

				return this.#responseText;
			}
			get responseXML() {
				if (this.#responseType !== '' && this.#responseType !== 'document')
					throw new DOMException(
						"Failed to read the 'responseXML' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'document' (was '" +
							this.#responseType +
							"').",
						'InvalidStateError',
					);
				return this.#responseXML;
			}
			get responseType() {
				return this.#responseType;
			}
			set responseType(value) {
				if (this.#loadingOrDone) {
					throw new DOMException(
						`Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.`,
						'InvalidStateError',
					);
				} else if (!this.#async) {
					throw new DOMException(
						`Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be changed for synchronous requests made from a document.`,
						'InvalidAccessError',
					);
				}

				if (!XMLHttpRequestResponseType.includes(value)) {
					console.warn(
						`The provided value '${value}' is not a valid enum value of type XMLHttpRequestResponseType.`,
					);
					return;
				}

				this.#responseType = value;
			}
			get readyState() {
				return this.#readyState;
			}
			get responseURL() {
				return this.#responseURL;
			}
			get response() {
				if (this.#responseType === '' || this.#responseType === 'text')
					return this.#loadingOrDone ? this.#responseText : '';
				if (this.#readyState !== DONE) return null;
				// Chrome parses a json response again on every read: two reads are
				// two objects
				if (this.#responseType === 'json') {
					if (this.#body === null || this.#body.byteLength === 0) return null;
					try {
						return Reflect.apply(parseJSON, realmJSON, [
							decoder.decode(this.#body),
						]);
					} catch (parseError) {
						return null;
					}
				}
				return this.#response;
			}
			#onHeaders(error: Error): void;
			#onHeaders(error: void, response: Response, url: string): void;
			#onHeaders(
				error: Error | void,
				response: Response | void,
				url: string | void,
			) {
				if (error) {
					console.error(error);
				}

				clearTimeout(this.#timer);
				if (this.#bodySize) {
					this.#upload.dispatchEvent(
						new ProgressEvent('progress', {
							lengthComputable: true,
							loaded: this.#bodySize,
							total: this.#bodySize,
						}),
					);
					this.#upload.dispatchEvent(new ProgressEvent('load'));
					this.#upload.dispatchEvent(new ProgressEvent('loadend'));
				}
				this.#readyState = HEADERS_RECEIVED;
				that.client.notifyResponse();
				this.#status = response!.status;
				this.#statusText = response!.statusText;
				// the fetch hook already reads a Response's URL as the page's; a
				// routed one (the sync bridge's) is decoded, a real one kept
				const responseURL = unrouteURL(that.client, url!) ?? url!;
				// the request's own URL shows its credentials, as natively
				this.#responseURL =
					this.#credentialed?.plain === responseURL
						? this.#credentialed.shown
						: responseURL;
				// an emulated service worker's answer: its mark is the proxy's
				adoptTypeMark(response!);
				this.#responseHeaders = response!.headers;
				this.#dispatchReadyState();

				/*
				// chrome doesn't dispatch loadstart
				this.dispatchEvent(new ProgressEvent('loadstart', {
					total: response.headers.get('content-length') || 1000
				}));
				*/
			}
			#onDone(error: unknown): void;
			#onDone(error: void, response: Response, buffer: ArrayBuffer): void;
			#onDone(
				error: unknown | void,
				response: Response | void,
				buffer: ArrayBuffer | void,
			) {
				if (error !== undefined) {
					if (this.#abort.signal.aborted) {
						return;
					}

					console.error('error', error);
					this.#end('error');
					return;
				}

				clearTimeout(this.#timer);
				this.#body = buffer!;
				this.#response = buffer!;
				const type = finalMime(
					this.#override,
					response!.headers.get('content-type'),
				);
				const mime = type.essence;
				const isXML = isXMLType(mime);
				// the bytes as the browser decodes them (JSON is always UTF-8)
				const text = () =>
					decodeText(buffer!, type.charset, isXML && this.#responseType === '');
				// a document to make of the body (the document type's response, or
				// the default type's responseXML)
				let parse = false;

				switch (this.#responseType) {
					case 'arraybuffer':
						this.#response = buffer!;
						break;
					case 'document':
						// an HTML document for text/html, an XML document for an XML
						// type, null for anything else (as the browser does)
						this.#response = null;
						if (mime === 'text/html' || isXML) parse = true;
						break;
					case 'json':
						// parsed on every read (the response getter), always as UTF-8
						this.#response = null;
						break;
					case 'blob':
						this.#response = new NativeBlob([buffer!], {
							type: mime,
						});
						break;
					default:
					// console.log(this.#responseType, 'DEFAULT');
					// fall through
					case 'text':
						this.#responseText = text();
						this.#response = this.#responseText;
						// the default type gives an XML document for an XML response
						if (this.#responseType === '' && isXML) parse = true;
						break;
				}

				if (!parse) return this.#finish(response!, buffer!);
				// an abort, a timeout or open() while the browser parses wins
				const generation = this.#generation;
				const signal = this.#abort.signal;
				parseResponse(
					buffer!,
					mime,
					type.charset,
					this.#responseType === 'document',
					!this.#async,
					(document) => {
						if (generation !== this.#generation || signal.aborted) return;
						if (document) responseURLs.set(document, this.#responseURL);
						this.#responseXML = document;
						if (this.#responseType === 'document') this.#response = document;
						this.#finish(response!, buffer!);
					},
				);
			}
			/** LOADING with the body, then DONE, load and loadend */
			#finish(response: Response, buffer: ArrayBuffer) {
				if (buffer.byteLength > 0) {
					this.#readyState = LOADING;
					this.#dispatchReadyState();
					this.dispatchEvent(
						new ProgressEvent('progress', {
							lengthComputable: true,
							loaded: buffer.byteLength,
							total: buffer.byteLength,
						}),
					);
				}
				this.#readyState = DONE;
				this.#dispatchReadyState();

				const parsedLen = parseInt(
					response.headers.get('content-length') || '',
				);
				const length = isNaN(parsedLen) ? 1000 : parsedLen;

				this.dispatchEvent(
					new ProgressEvent('load', {
						total: length,
					}),
				);

				this.dispatchEvent(
					new ProgressEvent('loadend', {
						total: length,
					}),
				);
			}
			/** a synchronous request's network error: done, no event, send() throws */
			#syncFailed(url: string): never {
				this.#readyState = DONE;
				this.#status = 0;
				this.#statusText = '';
				this.#response =
					this.#responseType === '' || this.#responseType === 'text'
						? ''
						: null;
				this.#responseText = '';
				throw new that.client.global.DOMException(
					`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${url}'.`,
					'NetworkError',
				);
			}
			#fetch(url: string | URL, init: RequestInit) {
				// the page's headers as a record the browser reads by its own
				// properties, without the proxy's markers (see Fetch)
				const headers = pageHeaderRecord(init.headers as Headers);
				init.headers = headers;
				// open()'s or the URL's credentials, for the worker (stripped
				// with the page's markers above, so added back here)
				if (this.#urlCredentials !== null)
					headers[CREDENTIALS_HEADER] = this.#urlCredentials;
				// a request of an opaque origin goes as one (OPAQUE_HEADER)
				if (that.client.opaqueRequests) headers[OPAQUE_HEADER] = '1';
				// a body with upload listeners: the CORS-preflight flag (never a
				// synchronous request's)
				if (
					this.#async &&
					init.body !== undefined &&
					init.body !== null &&
					uploads.listening(this.#upload)
				)
					headers[PREFLIGHT_HEADER] = '1';
				if (this.#async) {
					const generation = this.#generation;
					init.signal = this.#abort.signal;
					// abort() and a timeout reach the worker under this id; its
					// prefix tells the worker the request is an XMLHttpRequest
					const id = `xhr-${Date.now()}-${Math.random()}`;
					headers[ABORT_HEADER] = id;
					this.#abort.signal.addEventListener(
						'abort',
						() => that.client.abortRequest(id),
						{ once: true },
					);

					// through a controlled realm (this one, or an ancestor when this
					// document is one no service worker controls: an <object>'s)
					that.client
						.routedFetch(url, init)
						.then(async (response) => {
							if (generation !== this.#generation) return;
							this.#onHeaders(undefined, response, response.url);
							const buffer = await response.arrayBuffer();
							if (generation !== this.#generation) return;
							this.#onDone(undefined, response, buffer);
						})
						.catch((error) => {
							if (generation === this.#generation) this.#onDone(error);
						});
				} else {
					try {
						// the controlled client's own bridge (it may be of another
						// bundle): this document's reaches no worker when none controls it
						const bridge =
							(that.client.controlledClient() as DocumentClient | null)
								?.syncBridge ?? syncModule;
						const response = bridge.fetch(url, init);
						this.#onHeaders(undefined, response, response.rawUrl);
						this.#onDone(undefined, response, response.rawArrayBuffer);
					} catch (error) {
						// a network error (the site unreachable, the request refused
						// by CORS) ends a synchronous request with no event: send()
						// throws, as natively
						if (error instanceof TypeError) this.#syncFailed(this.#sentURL);
						this.#onDone(error);
					}
				}
			}
			overrideMimeType(mime: string) {
				if (this.#loadingOrDone)
					throw new DOMException(
						"Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden when the state is LOADING or DONE.",
						'InvalidStateError',
					);
				this.#override = overrideMime(mime);
			}
			abort() {
				if (!this.#async) {
					return;
				}

				if (this.#readyState === DONE || this.#readyState === UNSENT) return;
				this.#abort.abort();
				this.#end('abort');
			}
			open(
				method: string,
				url: string,
				async = true,
				username: string | void,
				password: string | void,
			) {
				// a document may not make a synchronous request with a response
				// type or a timeout set beforehand
				if (!async && (this.#timeout !== 0 || this.#responseType !== ''))
					throw new DOMException(
						"Failed to execute 'open' on 'XMLHttpRequest': Synchronous requests from a document must not set a response type or timeout.",
						'InvalidAccessError',
					);
				// a request in flight is dropped without events, and everything of
				// the last response is gone: status 0, no headers, no body
				this.#generation++;
				clearTimeout(this.#timer);
				if (
					this.#sent &&
					this.#readyState !== DONE &&
					!this.#abort.signal.aborted
				)
					this.#abort.abort();
				this.#abort = new AbortController();
				this.#sent = false;
				this.#bodySize = 0;
				this.#headers = new Headers({ 'sec-fetch-dest': 'empty' });
				this.#responseHeaders = new Headers();
				this.#status = 0;
				this.#statusText = '';
				this.#responseURL = '';
				this.#response = null;
				this.#body = null;
				this.#responseText = '';
				this.#responseXML = null;
				this.#method = String(method).toUpperCase();

				this.#url = String(url);

				if (async) {
					this.#async = true;
				} else {
					this.#async = false;
				}

				// set, they replace the URL's own user and password
				this.#username =
					username === undefined || username === null ? null : String(username);
				this.#password =
					password === undefined || password === null ? null : String(password);
				this.#credentialed = null;
				this.#urlCredentials = null;

				// readystatechange, even for a synchronous request, unless it
				// was opened already
				if (this.#readyState !== OPENED) {
					this.#readyState = OPENED;
					this.dispatchEvent(new Event('readystatechange'));
				}
			}
			setRequestHeader(header: string, value: string) {
				if (this.#readyState !== OPENED) {
					throw new DOMException(
						`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.`,
					);
				}

				// the proxy's markers are never the page's to send (see Fetch)
				if (isStompHeader(String(header))) return;
				// behavior is equal to append
				this.#headers.append(header, value);
			}
			send(body: string) {
				this.#readyState = OPENED;
				this.#sent = true;

				// a document whose permissions policy turns `sync-xhr` off (the
				// browser's, which the service worker gives it) fails a
				// synchronous request before it starts, as Chrome's does
				if (!this.#async && !syncAllowed()) {
					const failed = new URL(this.#url, that.client.baseURL.toString());
					failed.hash = '';
					failed.username = '';
					failed.password = '';
					this.#syncFailed(failed.href);
				}

				const options: RequestInit = {
					method: this.#method,
					headers: this.#headers,
					// the worker applies the credentials mode to the jar
					credentials: this.#withCredentials ? 'include' : 'same-origin',
				};

				if (
					body !== undefined &&
					body !== null &&
					!['GET', 'HEAD'].includes(this.#method)
				) {
					options.body = body;
					this.#bodySize =
						typeof body === 'string'
							? new TextEncoder().encode(body).byteLength
							: ((body as { size?: number; byteLength?: number }).size ??
								(body as { byteLength?: number }).byteLength ??
								0);
				}

				this.dispatchEvent(new ProgressEvent('loadstart'));
				if (this.#bodySize)
					this.#upload.dispatchEvent(new ProgressEvent('loadstart'));
				if (this.#async && this.#timeout > 0)
					this.#timer = setTimeout(() => {
						if (this.#readyState === DONE) return;
						this.#abort.abort();
						this.#end('timeout');
					}, this.#timeout);

				// credentials (open()'s or the URL's) go to the worker, which
				// answers the site's challenge with them (they are never sent before
				// one); the route is of the URL without them
				const target = new URL(this.#url, that.client.baseURL.toString());
				if (this.#username !== null) target.username = this.#username;
				if (this.#password !== null) target.password = this.#password;
				this.#credentialed = null;
				if (target.username !== '' || target.password !== '') {
					this.#urlCredentials = `${target.username}:${target.password}`;
					const shown = new URL(target.href);
					shown.hash = '';
					target.username = '';
					target.password = '';
					const plain = new URL(target.href);
					plain.hash = '';
					this.#credentialed = { shown: shown.href, plain: plain.href };
				}

				// mixed content: a synchronous request reaches the worker without
				// its page (the bridge's), so the page's URL decides here, as for
				// an asynchronous one the worker does
				let sent = target;
				if (!this.#async) {
					const mixed = that.client
						.getModule(MixedContentModule)
						?.verdict(target, 'empty', 'XMLHttpRequest endpoint');
					if (mixed?.action === 'block') {
						that.client.getModule(MixedContentModule)!.report(mixed.notices);
						this.#end('error');
						throw new that.client.global.DOMException(
							`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${target.href}'.`,
							'NetworkError',
						);
					}
					if (mixed?.action === 'upgrade') sent = mixed.url;
				}

				const shown = new URL(sent.href);
				shown.hash = '';
				this.#sentURL = shown.href;
				reportOnly(that.client, sent, 1);
				this.#fetch(routeXHR(new StompURL(sent, that.client.url)), options);
			}
			getResponseHeader(header: string) {
				return this.#responseHeaders.get(header);
			}
			getAllResponseHeaders() {
				let result = '';

				for (const [header, value] of this.#responseHeaders) {
					result += `${header}: ${value}\r\n`;
				}

				return result;
			}
		}

		const globalProxy = proxyModule.standInClass(XMLHttpRequestProxy, RealmXHR);
		const globalTargetProxy = proxyModule.standInClass(
			XMLHttpRequestEventTargetProxy,
			that.client.global.XMLHttpRequestEventTarget,
			true,
		);

		onEventTarget(globalTargetProxy.prototype, 'abort');
		onEventTarget(globalTargetProxy.prototype, 'error');
		onEventTarget(globalTargetProxy.prototype, 'load');
		onEventTarget(globalTargetProxy.prototype, 'loadend');
		onEventTarget(globalTargetProxy.prototype, 'loadstart');
		onEventTarget(globalTargetProxy.prototype, 'progress');
		onEventTarget(globalTargetProxy.prototype, 'timeout');

		onEventTarget(globalProxy.prototype, 'readystatechange');
		const nativeUpload = (
			that.client.global as { XMLHttpRequestUpload?: unknown }
		).XMLHttpRequestUpload;
		if (typeof nativeUpload === 'function') {
			const globalUploadProxy = proxyModule.standInClass(
				XMLHttpRequestUploadProxy,
				nativeUpload,
				true,
			);
			proxyModule.mirrorClass(nativeUpload, globalUploadProxy, instances);
			(that.client.global as any).XMLHttpRequestUpload = globalUploadProxy;
		}
		classConstant(globalProxy, 'UNSENT', UNSENT);
		classConstant(globalProxy, 'OPENED', OPENED);
		classConstant(globalProxy, 'HEADERS_RECEIVED', HEADERS_RECEIVED);
		classConstant(globalProxy, 'LOADING', LOADING);
		classConstant(globalProxy, 'DONE', DONE);

		proxyModule.mirrorClass(XMLHttpRequest, globalProxy, instances);
		proxyModule.mirrorClass(
			XMLHttpRequestEventTarget,
			globalTargetProxy,
			instances,
		);

		(this.client.global as any).XMLHttpRequest = globalProxy;
		(this.client.global as any).XMLHttpRequestEventTarget = globalTargetProxy;
	}
}
