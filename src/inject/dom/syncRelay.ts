// A page's own synchronous request where no answer of the bridge can reach
// a page that waits (Config syncFrozen, src/server/syncFrozen.ts: WebKit,
// where the wait stops the service worker). A deferred part (./deferred.ts):
// the bridge (./modules/Sync.ts) hands it the request it would have sent.
//
// WebKit sends a page's synchronous request to the network, past its
// worker, and runs it while the page waits, so the request goes to the
// host's server (demo/syncRelay.js) as one of the page's own: the server
// makes it through the Wisp relay and answers with the whole response. What
// the browser adds natively is added here: its headers, and the cookies
// the document knows (its view of the jar, with the HttpOnly ones its shell
// carried, Config syncSeed). The cookies the response sets go to the jar
// afterwards, and to what this document knows at once. A response of
// another origin is read only where its CORS headers allow it.
import { acceptLanguage } from '../../acceptLanguage';
import { encodeBase64 } from '../../base64';
import { partitionSite } from '../../partition';
import {
	BrowserCookieArray,
	compareCookies,
	cookieMatches,
	parseCookie,
	type CookieRequestContext,
	type JarCookie,
} from '../../server/Cookies';
import type { ProcessData, ProcessResult } from '../../sync';
import { SYNC_RELAY_ROUTE } from '../../transport/messages';
import { routedPrefix, unrouteURL } from '../modules/Unroute';
import { getDomain, getPublicSuffix } from '../rewriter';
import type DocumentClient from './Client';
import { CookiesModule } from './modules/Cookies';

/** the server's answer (demo/syncRelay.js) */
interface Relayed {
	error?: string;
	status: number;
	statusText: string;
	url: string;
	headers: [string, string][];
	body: string;
	cookies?: [string, string][];
}

const encoder = new TextEncoder();
const publicSuffix = (host: string) => getPublicSuffix(host);

/** the HttpOnly cookies this realm knows: its shell's, with what responses set since */
let held: JarCookie[] | undefined;

/** `cookie` replaces the one of its id in `lists` (an expired one only goes) */
function took(lists: (JarCookie[] | null | undefined)[], cookie: JarCookie) {
	for (const list of lists) {
		if (!list) continue;
		const index = list.findIndex((other) => other.id === cookie.id);
		if (index !== -1) list.splice(index, 1);
	}
	if (cookie.expires !== undefined && cookie.expires <= Date.now()) return;
	(cookie.httpOnly ? lists[0] : lists[1])?.push(cookie);
}

export function syncRelay(
	client: DocumentClient,
	data: ProcessData,
): ProcessResult {
	const failed = (message: string) => ({ error: { message } });
	const real = unrouteURL(client, data.url);
	if (real === null) return failed('Not found');
	const target = new URL(real);
	const page = client.url.url;
	const init = data.init;
	const method = (init.method ?? 'GET').toUpperCase();
	const cross = target.origin !== page.origin;
	const credentials = init.credentials === 'include';
	const partitionKey = partitionSite(client.partition) ?? undefined;
	const seed = client.syncSeed;
	held ??=
		seed?.key === client.storageKey
			? seed.cookies.filter((cookie) => cookie.httpOnly)
			: [];
	const cookies = client.getModule(CookiesModule);

	const headers: [string, string][] = [];
	for (const [name, value] of Object.entries(init.headers ?? {}))
		// (the proxy's own markers stay here)
		if (!name.toLowerCase().startsWith('x-stomp-'))
			for (const one of [value].flat()) headers.push([name, one]);
	const add = (name: string, value: string) => {
		if (!headers.some(([other]) => other.toLowerCase() === name))
			headers.push([name, value]);
	};
	const same = getDomain(target.hostname) === getDomain(page.hostname);
	const site: CookieRequestContext['site'] = !cross
		? 'same-origin'
		: same
			? 'same-site'
			: 'cross-site';
	add('accept', '*/*');
	add('user-agent', navigator.userAgent);
	const languages = acceptLanguage(client.global.navigator.languages);
	if (languages) add('accept-language', languages);
	if (cross || (method !== 'GET' && method !== 'HEAD'))
		add('origin', page.origin);
	// strict-origin-when-cross-origin, the default policy
	if (page.protocol !== 'https:' || target.protocol === 'https:')
		add('referer', cross ? `${page.origin}/` : page.href.replace(/#.*$/s, ''));
	add('sec-fetch-dest', 'empty');
	add('sec-fetch-mode', 'cors');
	add('sec-fetch-site', site);
	if (!cross || credentials) {
		const context = {
			partitionKey,
			site: partitionKey === undefined ? site : ('cross-site' as const),
		};
		const now = Date.now();
		const line = new BrowserCookieArray(
			...[...held, ...(cookies?.known ?? [])]
				.filter(
					(cookie) =>
						!(cookie.expires !== undefined && cookie.expires <= now) &&
						cookieMatches(cookie, target, context),
				)
				.sort(compareCookies),
		).toString();
		if (line) add('cookie', line);
	}
	let body = data.bodyBase64;
	if (data.body !== undefined) {
		body = encodeBase64(encoder.encode(data.body));
		add('content-type', 'text/plain;charset=UTF-8');
	}

	// the snapshot's class, whose prototype no page reaches (./syncAnswer.ts)
	const methods = XMLHttpRequest.prototype;
	const request = new XMLHttpRequest();
	let answer: Relayed;
	try {
		Reflect.apply(methods.open, request, [
			'POST',
			`${client.scope}${SYNC_RELAY_ROUTE}`,
			false,
		]);
		Reflect.apply(methods.send, request, [
			JSON.stringify({
				url: target.href,
				method,
				headers,
				body,
				redirect: init.redirect ?? 'follow',
			}),
		]);
		const text = Reflect.getOwnPropertyDescriptor(
			methods,
			'responseText',
		)!.get!;
		answer = JSON.parse(Reflect.apply(text, request, []) as string);
	} catch (error) {
		// no relay on this host, or it could not be reached
		return failed('The synchronous request could not be relayed');
	}
	if (answer.error !== undefined) return failed(answer.error);

	// what the response set: this document knows it now, and the jar soon
	const set = answer.cookies ?? [];
	const byURL = new Map<string, string[]>();
	for (const [url, header] of set) {
		const cookie = parseCookie(header, new URL(url), publicSuffix, {
			partitionKey,
			crossSite: site === 'cross-site',
		});
		if (cookie) took([held, cookies?.known], cookie);
		byURL.set(url, [...(byURL.get(url) ?? []), header]);
	}
	for (const [url, values] of byURL)
		client
			.routedFetch(`${routedPrefix(client)}cookies/set`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify([values, url, 'http', partitionKey]),
			})
			.catch(() => {})
			.finally(() => cookies?.invalidate());

	const header = (name: string) =>
		answer.headers.find(([other]) => other === name)?.[1];
	const allowed = header('access-control-allow-origin');
	if (
		cross &&
		(!(allowed === page.origin || (allowed === '*' && !credentials)) ||
			(credentials && header('access-control-allow-credentials') !== 'true'))
	)
		return failed('The response was refused by CORS');
	return {
		base64: answer.body,
		init: {
			status: answer.status,
			statusText: answer.statusText,
			headers: answer.headers,
		},
		url: answer.url,
	};
}
