import { decodeCookie } from '../../../encodeCookie';
import { geckoXHR, queueXHR } from '../../../routeURL';
import { urlLike } from '../../../StompURL';
import { ProcessData, SerializableRequestInit } from '../../../sync';
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

interface SyncResponseInit {
	error: { message: string };
	textArrayBuffer: string;
	init: ResponseInit;
	url: string;
}

function createResponse(init: SyncResponseInit): SyncResponse {
	if (init.error) {
		throw new TypeError(init.error.message);
	}

	const { buffer: rawArrayBuffer } = encoder.encode(init.textArrayBuffer);

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

		if (init.headers instanceof Headers) {
			processInit.headers = Object.fromEntries(init.headers.entries());
		} else if (typeof init.headers === 'object' && init.headers === null) {
			processInit.headers = init.headers;
		}

		const data: ProcessData = {
			url: new URL(url, location.toString()).toString(),
			init: processInit,
		};

		if (init.body instanceof ArrayBuffer) {
			data.body = decoder.decode(init.body);
		} else if (typeof init.body === 'string') {
			data.body = init.body;
		}

		if (navigator.userAgent.includes('gecko')) {
			const http = new XMLHttpRequest();

			http.open('POST', geckoXHR(this.client.url), false);
			http.send(JSON.stringify(data));

			return createResponse(JSON.parse(http.responseText));
		}

		const cookies = this.client.getModule(CookiesModule)!;
		const id = 'sync-request-' + Math.random().toString(16).slice(2);
		const regex = new RegExp(`${id}=(\\d+),(.*?)(;|$)`);

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

		const timeout = loopback ? LOOPBACK_TIMEOUT : TIMEOUT;
		const deadline = Date.now() + timeout;

		for (let cycles = 0; Date.now() < deadline; cycles++) {
			if (cycles % 3 !== 0) continue;

			const cookie = cookies.cookie;
			const match = cookie.match(regex);

			if (!match) continue;

			const clearCookies: string[] = [id];

			const chunks = parseInt(match[1]);

			let joinedValue = match[2];

			for (let i = 0; i < chunks; i++) {
				const cookieName = `${id}${i}`;
				const regex = new RegExp(`${cookieName}=(.*?)(;|$)`);
				const match = cookie.match(regex);

				if (!match) {
					console.warn(`Couldn't find chunk ${i}`);
					continue;
				}

				clearCookies.push(cookieName);

				const [, value] = match;

				joinedValue += value;
			}

			// same attributes as the service worker set, or a cross-site frame
			// cannot delete them and they pile up until the next request to the
			// proxy origin fails with 431
			for (const cookieName of clearCookies) {
				cookies.cookie = `${cookieName}=; path=/; expires=${new Date(
					0,
				)}; SameSite=None; Secure`;
			}

			return createResponse(JSON.parse(decodeCookie(joinedValue)));
		}

		throw new RangeError(
			`Reached the ${timeout} ms limit when requesting ${url}`,
		);
	}
}
