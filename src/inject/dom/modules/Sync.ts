import { decodeBase64, encodeBase64 } from '../../../base64';
import { decodeCookie, joinAnswer } from '../../../encodeCookie';
import { geckoXHR, queueXHR } from '../../../routeURL';
import { urlLike } from '../../../StompURL';
import { ProcessData, SerializableRequestInit, SyncBody } from '../../../sync';
import { headersRecord } from '../../../syncHeaders';
import Module from '../../Module';
import DocumentClient from '../Client';
import { CookiesModule } from './Cookies';

const statusEmpty: number[] = [101, 204, 205, 304];

// wall-clock limits: the service worker is single threaded, so even a
// loopback route (cookies, storage) waits while it rewrites a multi-megabyte
// script, which takes seconds for YouTube's main bundle
const TIMEOUT = 30e3;
const LOOPBACK_TIMEOUT = 10e3;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface SyncResponse extends Response {
	rawUrl: string;
	rawArrayBuffer: ArrayBuffer;
}

interface SyncResponseInit extends SyncBody {
	error: { message: string };
	init: ResponseInit;
	url: string;
}

// taken when the bundle loads, before page code can replace them
const objectTag = Reflect.getOwnPropertyDescriptor(
	Object.prototype,
	'toString',
)!.value as () => string;
const isView = ArrayBuffer.isView;

function createResponse(init: SyncResponseInit): SyncResponse {
	if (init.error) {
		throw new TypeError(init.error.message);
	}

	// the bytes the worker read: UTF-8 text encodes back to them exactly
	const { buffer: rawArrayBuffer } =
		init.base64 !== undefined
			? decodeBase64(init.base64)
			: encoder.encode(init.text ?? '');

	let response: Response & Partial<SyncResponse>;

	if (!init) {
		throw new Error('No init');
	}

	if (statusEmpty.includes(init.init.status!)) {
		response = new Response(undefined, init.init);
	} else {
		response = new Response(rawArrayBuffer, init.init);
	}

	response.rawUrl = init.url;
	response.rawArrayBuffer = rawArrayBuffer;

	return <SyncResponse>response;
}

export default class SyncModule extends Module<DocumentClient> {
	jsonAPI(url: urlLike, ...args: any[]) {
		const response = this.fetch(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify(args),
			},
			true,
		);

		const parsed = JSON.parse(decoder.decode(response.rawArrayBuffer));

		if (response.ok) {
			return parsed;
		} else {
			throw parsed;
		}
	}
	/**
	 * Synchronous ServiceWorker fetch API
	 * @param url
	 * @param init
	 * @param loopback goes to serviceworker route that does not fetch external urls
	 */
	fetch(
		url: urlLike,
		init: Omit<RequestInit, 'signal'> = {},
		loopback = false,
		// a shorter limit than the bridge's own, for a caller that has a
		// fallback
		limit?: number,
	): SyncResponse {
		const processInit: SerializableRequestInit = {};

		processInit.cache = init.cache;
		processInit.credentials = init.credentials;
		processInit.integrity = init.integrity;
		processInit.keepalive = init.keepalive;
		processInit.method = init.method;
		processInit.mode = init.mode;
		processInit.redirect = init.redirect;
		// the worker builds this request itself, so its referrer would be the
		// worker's: the document's routed URL names the initiator instead
		processInit.referrer = init.referrer ?? location.href;
		processInit.referrerPolicy = init.referrerPolicy;

		// a plain record went nowhere before (its branch tested `=== null`):
		// jsonAPI's content-type never reached the worker
		processInit.headers = headersRecord(init.headers);

		const data: ProcessData = {
			url: new URL(url, location.toString()).toString(),
			init: processInit,
		};

		// a binary body goes as its bytes (a UTF-8 decode would replace every
		// byte that is not UTF-8); either kind of buffer, from any realm
		const body = init.body;
		if (typeof body === 'string') {
			data.body = body;
		} else if (isView(body)) {
			data.bodyBase64 = encodeBase64(
				new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
			);
		} else if (
			body !== null &&
			typeof body === 'object' &&
			Reflect.apply(objectTag, body, []) === '[object ArrayBuffer]'
		) {
			data.bodyBase64 = encodeBase64(new Uint8Array(body as ArrayBuffer));
		}

		if (navigator.userAgent.includes('gecko')) {
			const http = new XMLHttpRequest();

			http.open('POST', geckoXHR(this.client.url), false);
			http.send(JSON.stringify(data));

			return createResponse(JSON.parse(http.responseText));
		}

		const cookies = this.client.getModule(CookiesModule)!;
		const id = 'sync-request-' + Math.random().toString(16).slice(2);

		// a beacon is refused (and never sent) when the payload is over the
		// browser's 64 KiB beacon quota, which a large localStorage value hits;
		// spinning for an answer that cannot come would freeze the page
		if (
			!navigator.sendBeacon(
				queueXHR(this.client.url),
				JSON.stringify({
					id,
					data,
				}),
			)
		)
			throw new DOMException(
				`The synchronous bridge cannot carry this request to ${url} (beacon refused, likely over the 64 KiB payload limit)`,
				'QuotaExceededError',
			);

		const timeout = limit ?? (loopback ? LOOPBACK_TIMEOUT : TIMEOUT);
		const deadline = Date.now() + timeout;

		for (let cycles = 0; Date.now() < deadline; cycles++) {
			if (cycles % 3 !== 0) continue;

			// a piece missing would leave a cut answer, whose last escape decodes
			// to a control character: wait for the whole of it
			const answer = joinAnswer(cookies.cookie, id);
			if (!answer) continue;

			// same attributes as the service worker set, or a cross-site frame
			// cannot delete them and they pile up until the next request to the
			// proxy origin fails with 431
			for (const cookieName of answer.names) {
				cookies.cookie = `${cookieName}=; path=/; expires=${new Date(
					0,
				)}; SameSite=None; Secure`;
			}

			return createResponse(JSON.parse(decodeCookie(answer.value)));
		}

		throw new RangeError(
			`Reached the ${timeout} ms limit when requesting ${url}`,
		);
	}
}
