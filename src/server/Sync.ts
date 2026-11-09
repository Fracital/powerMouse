import { decodeBase64, encodeBase64 } from '../base64';
import { encodeCookie, splitAnswer } from '../encodeCookie';
import { ProcessData, ProcessResult, SyncBody } from '../sync';
import Router from './Router';

// a body that is valid UTF-8 travels as its text (no bigger than the bytes in
// the cookies for most pages), anything else in base64: a font, an image, a
// Latin-1 text the page decodes with its own charset. ignoreBOM keeps a byte
// order mark in the text, so encoding it back gives the same bytes
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeBody(bytes: Uint8Array): SyncBody {
	try {
		return { text: utf8.decode(bytes) };
	} catch (error) {
		return { base64: encodeBase64(bytes) };
	}
}

const maxRedirects = 20;
const statusRedirect = [301, 302, 303, 307, 308];

async function process(
	router: Router,
	data: ProcessData,
): Promise<ProcessResult> {
	const init: RequestInit = <RequestInit>{ ...data.init };

	if (data.body !== undefined) {
		init.body = data.body;
	} else if (data.bodyBase64 !== undefined) {
		init.body = decodeBase64(data.bodyBase64);
	}

	let redirects = maxRedirects;

	try {
		let url: string = data.url;

		while (redirects--) {
			const request = new Request(url, init);

			if (!router.willRoute(url)) {
				throw new Error('Not found');
			}

			const response = await router.route(request);
			// a network error (the connection failed): the page's synchronous
			// request throws, as it does natively
			if (response.type === 'error') throw new Error('network error');

			if (
				statusRedirect.includes(response.status) &&
				response.headers.has('location')
			) {
				url = new URL(response.headers.get('location')!, url).toString();
				continue;
			}

			return {
				...encodeBody(new Uint8Array(await response.arrayBuffer())),
				init: {
					status: response.status,
					statusText: response.statusText,
					headers: Object.fromEntries(response.headers.entries()),
				},
				url: url.toString(),
			};
		}

		throw new Error('too many redirects');
	} catch (error) {
		return {
			error: {
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export function registerXhr(router: Router) {
	router.routes.set(/\/gxhr/, async (request) => {
		return new Response(
			JSON.stringify(await process(router, await request.json())),
		);
	});

	router.routes.set(/\/xhr/, async (request) => {
		const { id, data } = await request.json();

		const response = await process(router, data);
		// counted from the answer, not from the request: an answer that took
		// longer than this to come was set already expired, and the page spun
		// to its limit waiting for it
		const expires = Date.now() + 3e3;

		// the answer is read with document.cookie from a proxied frame, which in
		// origin-isolation mode is a cross-site embed: the CookieStore default
		// (Strict) is invisible there and every bridge call would time out
		for (const [name, value] of splitAnswer(
			id,
			encodeCookie(JSON.stringify(response)),
		))
			await cookieStore.set({
				name,
				value,
				expires,
				path: '/',
				sameSite: 'none',
			});

		return new Response();
	});
}
