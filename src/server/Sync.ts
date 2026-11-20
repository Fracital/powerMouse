import { decodeBase64, encodeBase64 } from '../base64';
import type GenericCodec from '../Codecs';
import { encodeCookie, splitAnswer, SYNC_CHUNK } from '../encodeCookie';
import { ProcessData, ProcessResult, SyncBody } from '../sync';
import { SYNC_ANSWER_HEADER } from '../syncAsk';
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

/**
 * The answers of the last half minute, by request id, as the cookies they
 * were set in, for a page that asks for its answer with a synchronous
 * XMLHttpRequest (`?a=<id>`, src/inject/dom/syncAnswer.ts). While a page
 * spins on document.cookie, Firefox shows it no cookie set after the spin
 * began, and holds the worker's clients.get of its window, and so every
 * route that reads its client, until the spin ends: every answer reached
 * the page only once it had given up. A synchronous request of the page's
 * own Firefox lets the worker answer, and runs the rest meanwhile
 * (measured in Firefox 160; Chrome 157 and WebKitGTK 2.52.4 send a page's
 * synchronous request past its worker, to the network).
 */
const answers = new Map<string, [string, string][]>();
/** a page's ask for an answer that is not made yet, by request id */
const askers = new Map<string, Set<() => void>>();
/**
 * Whether a page's synchronous request reaches this worker: true once an
 * ask came, false once a page said its ask went past (`?n`), undefined
 * until either (Config syncAnswers, which the documents are served with)
 */
let reached: boolean | undefined;
/** what is known of the browser's synchronous requests (reached) */
export const syncAnswers = (): boolean | undefined => reached;

/**
 * The answer to `?a=<id>&w=<ms>`, as the string its cookies would read in
 * document.cookie, once it is made (empty when it is not made in `ms`)
 */
async function askedAnswer(id: string, wait: number): Promise<Response> {
	if (!answers.has(id))
		await new Promise<void>((resolve) => {
			let set = askers.get(id);
			if (!set) askers.set(id, (set = new Set()));
			const wake = () => {
				clearTimeout(timer);
				set.delete(wake);
				if (!set.size && askers.get(id) === set) askers.delete(id);
				resolve();
			};
			const timer = setTimeout(wake, wait);
			set.add(wake);
		});
	const answer = answers.get(id);
	return new Response(
		answer?.map(([name, value]) => `${name}=${value}`).join('; ') ?? '',
		{ headers: { [SYNC_ANSWER_HEADER]: '1' } },
	);
}

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

export function registerXhr(
	router: Router,
	codec: GenericCodec,
	/** what an earlier worker learned (reached), and how to keep it */
	known?: boolean,
	remember?: (reached: boolean) => void,
) {
	reached ??= known;
	const learn = (value: boolean) => {
		if (reached === value || reached === true) return;
		reached = value;
		remember?.(value);
	};
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
		const query = new URL(request.url).searchParams;
		// a page asks for the answer to a request it sent (answers)
		const asked = query.get('a');
		if (asked !== null) {
			learn(true);
			return askedAnswer(asked, Math.min(Number(query.get('w')) || 0, KEEP_MS));
		}
		// a page's ask went past this worker, to the network
		if (query.has('n')) {
			learn(false);
			return new Response(null, { status: 204 });
		}
		// the request rides in the beacon's URL, which takes none of the
		// page's beacon quota, unless it is too long for one; sealed with the
		// codec, as a route is (a seal it cannot open is no request)
		const inURL = query.get('r');
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
		answers.set(id, answer);
		setTimeout(() => answers.delete(id), KEEP_MS);
		// a page that waits in an ask takes it there, and needs no cookies
		const waiting = [...(askers.get(id) ?? [])];
		askers.delete(id);
		for (const wake of waiting) wake();
		if (waiting.length) return new Response();
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
