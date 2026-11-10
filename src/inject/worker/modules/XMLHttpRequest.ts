import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import { ABORT_HEADER, CREDENTIALS_HEADER } from '../../../transport/messages';
import Module from '../../Module';
import { isStompHeader } from '../../modules/Fetch';
import ProxyModule, { classConstant, onEventTarget } from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import {
	decodeText,
	finalMime,
	isXMLType,
	overrideMime,
	type MimeType,
} from '../../xhrText';
import WorkerClient from '../Client';

export default class XMLHttpRequestModule extends Module<WorkerClient> {
	apply() {
		const instances = new WeakSet();
		const real = Symbol();
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		const proxyModule = this.client.getModule(ProxyModule)!;

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

		const decoder = new TextDecoder('utf-8');
		// the realm's JSON.parse, before page code can replace it: a json
		// response is the page realm's value
		const realmJSON = that.client.global.JSON;
		const parseJSON = realmJSON.parse;

		// A worker's synchronous XHR reaches the service worker (Chrome hands a
		// dedicated worker's sync request to its controller, unlike a
		// document's), so the browser's own XHR carries it to the routed URL,
		// its bytes as an ArrayBuffer. Its methods are taken now, before page
		// code runs.
		const NativeXHR = XMLHttpRequest;
		const nativeProto = NativeXHR.prototype;
		const method = (name: string) =>
			Reflect.getOwnPropertyDescriptor(nativeProto, name)!.value;
		const accessor = (name: string) =>
			Reflect.getOwnPropertyDescriptor(nativeProto, name)!;
		const nativeOpen = method('open');
		const nativeSend = method('send');
		const nativeSetHeader = method('setRequestHeader');
		const nativeAllHeaders = method('getAllResponseHeaders');
		const nativeResponseType = accessor('responseType').set!;
		const nativeCredentials = accessor('withCredentials').set!;
		const nativeStatus = accessor('status').get!;
		const nativeStatusText = accessor('statusText').get!;
		const nativeResponse = accessor('response').get!;
		const nativeResponseURL = accessor('responseURL').get!;
		const syncRequest = (url: string, init: RequestInit) => {
			const xhr = new NativeXHR();
			Reflect.apply(nativeOpen, xhr, [init.method, url, false]);
			Reflect.apply(nativeResponseType, xhr, ['arraybuffer']);
			Reflect.apply(nativeCredentials, xhr, [init.credentials === 'include']);
			for (const [name, value] of init.headers as Headers)
				try {
					Reflect.apply(nativeSetHeader, xhr, [name, value]);
				} catch (error) {
					// a header the browser does not let a page set
				}
			Reflect.apply(nativeSend, xhr, [init.body ?? null]);
			const headers = new Headers();
			const lines = String(Reflect.apply(nativeAllHeaders, xhr, [])).split(
				'\r\n',
			);
			for (const line of lines) {
				const colon = line.indexOf(':');
				if (colon > 0)
					headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
			}
			const response = {
				status: Reflect.apply(nativeStatus, xhr, []) as number,
				statusText: Reflect.apply(nativeStatusText, xhr, []) as string,
				headers,
			} as Response;
			return {
				response,
				url: Reflect.apply(nativeResponseURL, xhr, []) as string,
				buffer: Reflect.apply(nativeResponse, xhr, []) as ArrayBuffer,
			};
		};

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
			#headers = new Headers();
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
			#upload = new XMLHttpRequestUploadProxy(real);
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
					this.responseType === '' || this.responseType === 'text' ? '' : null;
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
				if (this.responseType !== '' && this.responseType !== 'text')
					throw new DOMException(
						`Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${
							this.#responseType
						}').`,
						'InvalidStateError',
					);

				return this.#responseText;
			}
			get responseXML() {
				if (this.responseType !== '' && this.responseType !== 'document')
					throw new DOMException(
						"Failed to read the 'responseXML' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'document' (was '" +
							this.responseType +
							"').",
						'InvalidStateError',
					);
				return this.#responseXML;
			}
			get responseType() {
				return this.#responseType;
			}
			set responseType(value) {
				// a worker may set any type on a synchronous request; only a
				// document may not
				if (this.#loadingOrDone) {
					throw new DOMException(
						`Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.`,
						'InvalidStateError',
					);
				}

				if (!XMLHttpRequestResponseType.includes(value)) {
					console.warn(
						`The provided value '${value}' is not a valid enum value of type XMLHttpRequestResponseType.`,
					);
					return;
				}

				// a worker has no documents: the browser ignores 'document' there
				if (value === 'document') return;
				this.#responseType = value;
			}
			get readyState() {
				return this.#readyState;
			}
			get responseURL() {
				return this.#responseURL;
			}
			get response() {
				if (this.responseType === '' || this.responseType === 'text')
					return this.#loadingOrDone ? this.#responseText : '';
				if (this.#readyState !== DONE) return null;
				// Chrome parses a json response again on every read: two reads are
				// two objects
				if (this.responseType === 'json') {
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

				switch (this.responseType) {
					case 'arraybuffer':
						this.#response = buffer!;
						break;
					case 'document':
						this.#response = null;
						break;
					case 'json':
						// parsed on every read (the response getter), always as UTF-8
						this.#response = null;
						break;
					case 'blob':
						this.#response = new that.client.global.Blob([buffer!], {
							type: mime,
						});
						break;
					default:
					case 'text':
						this.#responseText = decodeText(
							buffer!,
							type.charset,
							isXMLType(type.essence) && this.responseType === '',
						);
						this.#response = this.#responseText;
						break;
				}

				if (buffer!.byteLength > 0) {
					this.#readyState = LOADING;
					this.#dispatchReadyState();
					this.dispatchEvent(
						new ProgressEvent('progress', {
							lengthComputable: true,
							loaded: buffer!.byteLength,
							total: buffer!.byteLength,
						}),
					);
				}
				this.#readyState = DONE;
				this.#dispatchReadyState();

				const parsedLen = parseInt(
					response!.headers.get('content-length') || '',
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
			#fetch(url: string | URL, init: RequestInit) {
				if (this.#async) {
					const generation = this.#generation;
					init.signal = this.#abort.signal;
					// abort() and a timeout reach the worker under this id; its
					// prefix tells the worker the request is an XMLHttpRequest
					const id = `xhr-${Date.now()}-${Math.random()}`;
					(init.headers as Headers).set(ABORT_HEADER, id);
					this.#abort.signal.addEventListener(
						'abort',
						() => that.client.abortRequest(id),
						{ once: true },
					);

					fetch(url, init)
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
						const {
							response,
							url: final,
							buffer,
						} = syncRequest(String(url), init);
						this.#onHeaders(undefined, response, final);
						this.#onDone(undefined, response, buffer);
					} catch (error) {
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
				this.#headers = new Headers();
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
				const target = new URL(this.#url, that.client.url.toString());
				if (this.#username !== null) target.username = this.#username;
				if (this.#password !== null) target.password = this.#password;
				this.#credentialed = null;
				if (target.username !== '' || target.password !== '') {
					this.#headers.set(
						CREDENTIALS_HEADER,
						`${target.username}:${target.password}`,
					);
					const shown = new URL(target.href);
					shown.hash = '';
					target.username = '';
					target.password = '';
					const plain = new URL(target.href);
					plain.hash = '';
					this.#credentialed = { shown: shown.href, plain: plain.href };
				}

				this.#fetch(routeXHR(new StompURL(target, that.client.url)), options);
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

		const globalProxy = proxyModule.standInClass(
			XMLHttpRequestProxy,
			that.client.global.XMLHttpRequest,
		);
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
