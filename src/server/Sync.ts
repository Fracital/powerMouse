import { decodeBase64, encodeBase64 } from '../base64';
import { encodeCookie } from '../encodeCookie';
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

const split = 4000;

export function registerXhr(router: Router) {
	router.routes.set(/\/gxhr/, async (request) => {
		return new Response(
			JSON.stringify(await process(router, await request.json())),
		);
	});

	router.routes.set(/\/xhr/, async (request) => {
		const { id, data } = await request.json();
		const expiration = new Date(Date.now() + 3e3);

		const response = await process(router, data);

		let long = encodeCookie(JSON.stringify(response));
		let mainCookieValue =
			(long.length < split - 2
				? '0'
				: (Math.ceil(long.length / split) - 1).toString()) + ',';

		if (mainCookieValue.length < split) {
			const end = long.slice(0, split - mainCookieValue.length);
			long = long.slice(end.length);
			mainCookieValue += end;
		}

		for (let i = 0; i < long.length; i += split) {
			const part = long.slice(i, i + 4000);

			const chunk = i / split;

			await cookieStore.set({
				name: id + chunk,
				value: part,
				expires: expiration.getTime(),
				path: '/',
				sameSite: 'none',
			});
		}

		// the answer is read with document.cookie from a proxied frame, which in
		// origin-isolation mode is a cross-site embed: the CookieStore default
		// (Strict) is invisible there and every bridge call would time out
		await cookieStore.set({
			name: id,
			value: mainCookieValue,
			expires: expiration.getTime(),
			path: '/',
			sameSite: 'none',
		});

		return new Response();
	});
}
