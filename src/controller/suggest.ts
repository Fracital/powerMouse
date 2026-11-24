/**
 * A search engine's completions for what was typed into the host's own
 * address bar (`controller.suggest()`), asked through the controller's
 * transport: the relay has no CORS, so a host needs no endpoint of its own.
 * The request is the host's, as Chrome's omnibox asks from its own process:
 * no page's cookies, partition, referrer or origin, and the fields Chrome
 * sends for a request of the browser's (src/server/passkeys.ts wellKnown,
 * measured on 152 and 156). It carries no cookies at all: a person's
 * engine account stays out of what they type before they search.
 */
import type {
	ProxyTransport,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import { searchEngine } from '../bootstrapper/searchEngines';
import RemoteTransport from '../transport/RemoteTransport';
import { fitHeaders } from '../transport/serveTransport';

export interface SuggestOptions {
	/**
	 * The engine: an id of SEARCH_ENGINES (`'google'`, `'duckduckgo'`,
	 * `'bing'`, `'brave'`, `'startpage'`) or a SearchBuilder template of
	 * one. Google when neither this nor `endpoint` is given.
	 */
	engine?: string;
	/** an OpenSearch suggest endpoint of another engine, `%s` the query; wins over `engine` */
	endpoint?: string;
	/** at most this many completions (8, the most Chrome shows) */
	limit?: number;
	/** rejects the call with the signal's reason; a late answer is dropped */
	signal?: AbortSignal;
}

/** the longest query sent; Chrome's omnibox sends none past this either */
const MAX_QUERY = 200;
/** an answer past this is no list of completions */
const MAX_BYTES = 256 * 1024;
const REDIRECTS = 3;

const web = (url: URL) => url.protocol === 'https:' || url.protocol === 'http:';

const fold = (text: string) =>
	text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The completions in an OpenSearch answer (`[query, [completion, ...]]`,
 * DuckDuckGo's `[{ phrase }]` too), trimmed and once each, without the
 * query itself; [] for anything else.
 */
export function parseSuggestions(
	json: unknown,
	query: string,
	limit = 8,
): string[] {
	if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
	const typed = fold(query);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of json[1] as unknown[]) {
		const text =
			typeof item === 'string'
				? item
				: typeof (item as { phrase?: unknown })?.phrase === 'string'
					? (item as { phrase: string }).phrase
					: '';
		const trimmed = text.replace(/\s+/g, ' ').trim();
		const key = fold(trimmed);
		if (!trimmed || key === typed || seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
		if (out.length >= limit) break;
	}
	return out;
}

/** the endpoint a call asks, its `%s` filled */
export function suggestUrl(text: string, options: SuggestOptions): URL {
	const template =
		options.endpoint ?? searchEngine(options.engine ?? 'google')?.suggest;
	const url =
		template?.includes('%s') &&
		URL.parse(template.replace('%s', encodeURIComponent(text)));
	if (!url || !web(url))
		throw new TypeError(
			'Stomp: suggest() takes an engine of SEARCH_ENGINES, or an http(s) endpoint with %s for the query',
		);
	return url;
}

/** the answer's body as text, in the charset it names */
async function bodyText(
	body: unknown,
	headers: RawHeaders,
): Promise<string | null> {
	const type =
		(Array.isArray(headers) ? headers : []).find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? '';
	const bytes = await new Response(body as BodyInit | null).arrayBuffer();
	if (bytes.byteLength > MAX_BYTES) return null;
	const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset);
	} catch {
		decoder = new TextDecoder();
	}
	return decoder.decode(bytes);
}

/** what `signal` aborting does to `promise`: it rejects with the reason at once */
export function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', abort));
	});
}

/**
 * The engine's completions for `text`, through `transport`. Resolves to []
 * for an empty query or an answer that is no list of completions; rejects
 * when the request fails, the engine answers an error status, or `signal`
 * aborts.
 */
export function suggestThrough(
	transport: ProxyTransport,
	text: string,
	options: SuggestOptions = {},
	userAgent?: string,
): Promise<string[]> {
	const query = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
	if (!query) return Promise.resolve([]);
	let url = suggestUrl(query, options);
	const languages = acceptLanguage(navigator.languages);
	const fields: RawHeaders = [
		['Sec-Fetch-Site', 'none'],
		['Sec-Fetch-Mode', 'no-cors'],
		['Sec-Fetch-Dest', 'empty'],
		['User-Agent', userAgent ?? navigator.userAgent],
		// (src/server/headerOrder.ts CHROME_ACCEPT_ENCODING; a transport that
		// decodes less sends what it decodes, fitHeaders)
		['Accept-Encoding', 'gzip, deflate, br, zstd'],
		...(languages
			? ([['Accept-Language', languages]] as [string, string][])
			: []),
	];
	// a transport of this page is called as it is: the one served from the
	// transport worker fits the fields there (serveTransport)
	const sent =
		transport instanceof RemoteTransport
			? fields
			: fitHeaders(transport, fields);
	const ask = async (): Promise<string[]> => {
		for (let hop = 0; ; hop++) {
			const response = await transport.request(
				url,
				'GET',
				null,
				sent,
				options.signal,
			);
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.find(
					([name]) => name.toLowerCase() === 'location',
				)?.[1];
				const next = location && hop < REDIRECTS && URL.parse(location, url);
				if (next && web(next)) {
					url = next;
					continue;
				}
			}
			if (response.status < 200 || response.status > 299)
				throw new Error(
					`Stomp: the suggest endpoint answered ${response.status}`,
				);
			const body = await bodyText(response.body, response.headers);
			if (body === null) return [];
			let json: unknown;
			try {
				// Google's answer may open with an XSSI guard
				json = JSON.parse(body.replace(/^\)\]\}'[^\n]*\n?/, ''));
			} catch {
				return [];
			}
			return parseSuggestions(json, query, options.limit);
		}
	};
	return untilAborted(ask(), options.signal);
}
