import { decodeBase64, encodeBase64 } from '../base64';
import type GenericCodec from '../Codecs';
import { encodeCookie, splitAnswer, SYNC_CHUNK } from '../encodeCookie';
import { ProcessData, ProcessResult, SyncBody } from '../sync';
import { RouteContext } from '../transport/messages';
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

/**
 * The most cookies one answer is set in. Chrome keeps at most 180 cookies of
 * a site and drops the least recently used past that, so an answer in more
 * never arrived whole: the page spun to its limit for it while the cookies
 * set for it pushed every other answer, and the proxy origin's own cookies,
 * out of the jar (an ad quality script of 735 KB written into ad frames on
 * washingtonpost.com, 5 s a frame, and the script never ran). A body that
 * would take more is kept here and read in parts (`syncPart`), each well
 * under the limit with room for other answers in flight.
 */
const ANSWER_COOKIES = 72;
/** what one part may cost in its answer's cookies, its wrapping aside */
const PART_COST = (ANSWER_COOKIES - 2) * SYNC_CHUNK;
/** how long a body waits for the page to read its parts */
const KEEP_MS = 30e3;
const kept = new Map<string, string>();

/** what `text` costs as an answer's body, in its cookies */
const answerCost = (text: string) => encodeCookie(JSON.stringify(text)).length;

const maxRedirects = 20;
const statusRedirect = [301, 302, 303, 307, 308];

async function process(
	router: Router,
	data: ProcessData,
	context?: RouteContext,
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

			// as the page's own request: the policy between the real origins
			// is judged by the document that made it (the beacon's client)
			const response = await router.route(request, context);
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

export function registerXhr(router: Router, codec: GenericCodec) {
	// a part of a body kept for a page (see ANSWER_COOKIES), from `at`: as
	// much as one answer carries, never a surrogate pair split (a part
	// travels as UTF-8)
	router.routes.set(/^\/syncPart$/, async (request) => {
		const [key, at] = (await request.json()) as [string, number];
		const body = kept.get(key);
		if (body === undefined || at >= body.length)
			return new Response(null, { status: 404 });
		let end = Math.min(body.length, at + PART_COST);
		for (let cost; (cost = answerCost(body.slice(at, end))) > PART_COST;)
			end =
				at + Math.max(1, Math.floor(((end - at) * PART_COST) / cost / 1.02));
		const last = body.charCodeAt(end - 1);
		if (end < body.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff)
			end--;
		if (end === body.length) kept.delete(key);
		return new Response(body.slice(at, end));
	});

	router.routes.set(/\/gxhr/, async (request, _url, context) => {
		return new Response(
			JSON.stringify(await process(router, await request.json(), context)),
		);
	});

	router.routes.set(/\/xhr/, async (request, _url, context) => {
		// the request rides in the beacon's URL, which takes none of the
		// page's beacon quota, unless it is too long for one; sealed with the
		// codec, as a route is (a seal it cannot open is no request)
		const inURL = new URL(request.url).searchParams.get('r');
		const { id, data } =
			inURL === null ? await request.json() : JSON.parse(codec.decode(inURL));

		const response = await process(router, data, context);
		// counted from the answer, not from the request: an answer that took
		// longer than this to come was set already expired, and the page spun
		// to its limit waiting for it
		const expires = Date.now() + 3e3;

		// the answer is read with document.cookie from a proxied frame, which in
		// origin-isolation mode is a cross-site embed: the CookieStore default
		// (Strict) is invisible there and every bridge call would time out
		let answer = splitAnswer(id, encodeCookie(JSON.stringify(response)));
		if (answer.length > ANSWER_COOKIES && 'init' in response) {
			const { text, base64, ...head } = response;
			const body = (text ?? base64)!;
			kept.set(id, body);
			setTimeout(() => kept.delete(id), KEEP_MS);
			answer = splitAnswer(
				id,
				encodeCookie(
					JSON.stringify({
						...head,
						more: { key: id, length: body.length, base64: text === undefined },
					}),
				),
			);
		}
		for (const [name, value] of answer)
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
