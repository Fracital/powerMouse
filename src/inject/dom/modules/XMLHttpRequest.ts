import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import {
	ABORT_HEADER,
	CREDENTIALS_HEADER,
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
import { withStack } from '../../nativeErrors';
import { LazyWeakSet } from '../../ownCollections';
import { trackUploadListeners } from '../../uploadListeners';
import {
	decodeText,
	finalMime,
	isXMLType,
	overrideMime,
	type MimeType,
} from '../../xhrText';
import DocumentClient from '../Client';
import { deferred } from '../deferred';
import { responseURLs } from '../responseDocuments';
import type { XhrMessage } from '../xhrMessages';
import type { ResponseParser } from '../xhrParse';
import BlobDocumentsModule from './BlobDocuments';
import SyncModule from './Sync';

export default class XMLHttpRequestModule extends Module<DocumentClient> {
	/** the realm's listener count (src/inject/uploadListeners.ts), which the Visited module keeps for `navigation` too */
	listeners?: ReturnType<typeof trackUploadListeners>;
	apply() {
		const moduleClient = this.client;
		const instances = new LazyWeakSet();
		const real = Symbol();
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const syncModule = that.client.getModule(SyncModule)!;
		// a blob response is the bytes the site sent, in the realm's own Blob
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

		// the browser's messages for a page's misuse of the API, a deferred
		// part (../xhrMessages.ts): the exception is made here, in the
		// hook's own frame
		const message = (key: XhrMessage, detail?: string) =>
			deferred('xhrMessage')(key, detail);

		// whether the document's permissions policy lets the guest make a
		// synchronous request (Chrome's `sync-xhr`). The served
		// Permissions-Policy no longer disables the feature, so the browser's
		// enforced header (document.featurePolicy) would always say yes:
		// STomp's own inject must be able to make a synchronous XHR (the WebRTC
		// rtcStack loader, WebRTC.ts, with captured native XHR, which never
		// reaches this check). The worker's recorded real state decides it for
		// the guest instead (src/server/clientHints.ts syncXHRBlocked)
		const syncAllowed = (): boolean => !that.client.syncXHRBlocked;

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
		const RealmDOMParser = that.client.global.DOMParser;
		const realmParse = RealmDOMParser.prototype.parseFromString;
		const realmQuery = that.client.global.Document.prototype.querySelector;
		// the parse itself is a deferred part (../xhrParse.ts): most pages
		// never read an XML response as a document
		let parser: ResponseParser | undefined;
		const parseResponse: ResponseParser = (...args) =>
			(parser ??= deferred('responseParser')({
				client: that.client,
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
			}))(...args);
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
					throw withStack(
						new DOMException(message('timeout'), 'InvalidAccessError'),
					);
				this.#timeout = Math.max(0, Number(value) || 0);
			}
			get withCredentials() {
				return this.#withCredentials;
			}
			set withCredentials(value) {
				if (this.#sent || this.#loadingOrDone)
					throw withStack(
						new DOMException(message('withCredentials'), 'InvalidStateError'),
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
					throw withStack(
						new DOMException(
							message('responseText', this.#responseType),
							'InvalidStateError',
						),
					);

				return this.#responseText;
			}
			get responseXML() {
				if (this.#responseType !== '' && this.#responseType !== 'document')
					throw withStack(
						new DOMException(
							message('responseXML', this.#responseType),
							'InvalidStateError',
						),
					);
				return this.#responseXML;
			}
			get responseType() {
				return this.#responseType;
			}
			set responseType(value) {
				if (this.#loadingOrDone) {
					throw withStack(
						new DOMException(message('responseTypeLate'), 'InvalidStateError'),
					);
				} else if (!this.#async) {
					throw withStack(
						new DOMException(message('responseTypeSync'), 'InvalidAccessError'),
					);
				}

				if (!XMLHttpRequestResponseType.includes(value)) {
					console.warn(message('responseTypeValue', `${value}`));
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
				throw withStack(
					new that.client.global.DOMException(
						`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${url}'.`,
						'NetworkError',
					),
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
					throw withStack(
						new DOMException(message('overrideMimeType'), 'InvalidStateError'),
					);
				this.#override = overrideMime(mime);
			}
			abort() {
				if (!this.#async) {
					return;
				}

				if (this.#readyState === DONE || this.#readyState === UNSENT) return;
				// opened and not sent: nothing to abort, no events, and send()
				// may still follow
				if (this.#readyState === OPENED && !this.#sent) return;
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
				// a method the browser refuses changes nothing of the request
				const checked = deferred('checkedMethod')(that.client.global, method);
				// a document may not make a synchronous request with a response
				// type or a timeout set beforehand
				if (!async && (this.#timeout !== 0 || this.#responseType !== ''))
					throw withStack(
						new DOMException(message('open'), 'InvalidAccessError'),
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
				this.#method = checked;

				this.#url = String(url);

				if (async) {
					this.#async = true;
				} else {
					this.#async = false;
					// the browser deprecates a synchronous request on a document's
					// main thread and reports it where it is opened, once a page:
					// this one goes through the bridge, so the browser is given one
					// to open (never sent) and makes its own report of it, which
					// shows the page's call (Unroute's noteSynchronousRequest)
					if (
						typeof document !== 'undefined' &&
						that.client.getModule(UnrouteModule)?.noteSynchronousRequest()
					)
						try {
							Reflect.apply(realmOpen, new RealmXHR(), [
								'GET',
								'data:,',
								false,
							]);
						} catch (error) {
							// a document that may open none: no report natively either
						}
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
				[header, value] = deferred('checkedHeader')(
					that.client.global,
					// eslint-disable-next-line prefer-rest-params
					arguments,
					this.#readyState === OPENED && !this.#sent,
				);
				// the proxy's markers are never the page's to send (see Fetch)
				if (isStompHeader(header)) return;
				// behavior is equal to append
				this.#headers.append(header, value);
			}
			send(body: string) {
				if (this.#readyState !== OPENED || this.#sent)
					throw deferred('notOpened')(that.client.global, 'send');
				this.#sent = true;

				// a document whose permissions policy turns `sync-xhr` off (the
				// browser's, which the service worker gives it) fails a
				// synchronous request before it starts, as Chrome's does
				// (and one its connect-src refuses, which no worker sees: the bridge
				// carries it, so the browser is made to refuse and report it,
				// src/csp.ts)
				if (
					!this.#async &&
					(!syncAllowed() ||
						that.client.connectRefusal(
							that.client.encodingParse(
								this.#url,
								that.client.baseURL.toString(),
							),
						))
				) {
					const failed = that.client.encodingParse(
						this.#url,
						that.client.baseURL.toString(),
					);
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
				const target = that.client.encodingParse(
					this.#url,
					that.client.baseURL.toString(),
				);
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
						throw withStack(
							new that.client.global.DOMException(
								`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${target.href}'.`,
								'NetworkError',
							),
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

		// (the realm's own interfaces, which are not the bundle's in a frame
		// its parent's bundle hooks: a refusal is an error of the page's realm)
		proxyModule.mirrorClass(RealmXHR, globalProxy, instances);
		proxyModule.mirrorClass(
			that.client.global.XMLHttpRequestEventTarget,
			globalTargetProxy,
			instances,
		);

		(moduleClient.global as any).XMLHttpRequest = globalProxy;
		(moduleClient.global as any).XMLHttpRequestEventTarget = globalTargetProxy;
	}
}
