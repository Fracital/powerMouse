/**
 * The per-site shields' strict HTTPS ('strict', Brave's "require HTTPS",
 * docs/adblock.md "Per-site shields"): the worker upgrades the site's
 * top-level page to https, and when the upgraded load fails at the
 * connection or at TLS (the site has no https), the tab shows this
 * interstitial instead of the http page, as Chromium's HTTPS-Only Mode
 * does ("Connection is not secure", chrome-error://chromewebdata/ natively).
 * Nothing goes to the site over http until the user picks "Continue to
 * site", which tells the worker (a POST to HTTPS_ONLY_ROUTE with the
 * page's one-time token; no page can make one up) and then loads the
 * http page: the host's shields upgrade nothing of it for the rest of the
 * worker's life (ShieldsStore.allowHttp). "Go back" steps back.
 *
 * The interstitial runs no inject. In a dialed tab (docs/dialing.md) it is
 * written into the call page, whose port to the host it finds where the
 * call page left it (CALLED_KEY): it asks the host for the http page and
 * for the step back as a dialed document does. In a classic tab it
 * navigates its frame.
 */
import { CALLED_KEY } from '../transport/messages';
import { errorReportScript } from './errorPage';

/** the worker's route a "Continue to site" posts its token to, under the directory */
export const HTTPS_ONLY_ROUTE = 'https-only';

/** how long an upgrade or an offer to go on over http is remembered */
const KEPT_MS = 5 * 60_000;
const MOST = 64;

/** the routed https URLs this worker upgraded a strict site's page to, and the http URL each came from */
const upgrades = new Map<string, { from: string; expires: number }>();
/** the interstitials' tokens: the host each lets the user go on to over http */
const offers = new Map<string, { host: string; expires: number }>();

function remember<T extends { expires: number }>(
	map: Map<string, T>,
	key: string,
	value: T,
) {
	const now = Date.now();
	for (const [old, entry] of map) if (entry.expires <= now) map.delete(old);
	map.delete(key);
	if (map.size >= MOST) map.delete(map.keys().next().value!);
	map.set(key, value);
}

/** the strict upgrade of the page at `from` went to the route `routed` */
export function rememberHttpsOnlyUpgrade(routed: string, from: string) {
	remember(upgrades, withoutHash(routed), {
		from,
		expires: Date.now() + KEPT_MS,
	});
}

/** the http URL whose strict upgrade the route `routed` is, else null */
export function httpsOnlyUpgradeOf(routed: string): string | null {
	const entry = upgrades.get(withoutHash(routed));
	return entry && entry.expires > Date.now() ? entry.from : null;
}

/**
 * The host a "Continue to site" with `token` lets the user go on to (the
 * token is spent), else null
 */
export function takeHttpsOnlyOffer(token: string): string | null {
	const entry = offers.get(token);
	offers.delete(token);
	return entry && entry.expires > Date.now() ? entry.host : null;
}

const withoutHash = (url: string) => {
	const at = url.indexOf('#');
	return at < 0 ? url : url.slice(0, at);
};

const escapeHTML = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				c
			]!,
	);

/** a value in the page's script: nothing in it ends the script element */
const literal = (value: unknown) =>
	JSON.stringify(value).replace(
		/[<>&\u2028\u2029]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);

function token(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

/**
 * The interstitial for the strict site's page at `from` (its http URL),
 * whose https load failed. `routed`: the http page's route; `proceed`: the
 * URL of HTTPS_ONLY_ROUTE on this worker's origin; `client`: the frame's
 * client, which the classic tab's error report names.
 */
export function httpsOnlyPage(
	from: string,
	routed: string,
	proceed: string,
	client?: string,
): Response {
	const host = new URL(from).hostname;
	const offer = token();
	remember(offers, offer, { host, expires: Date.now() + KEPT_MS });
	const script = `<script>(() => {
	const called = window[${literal(CALLED_KEY)}];
	const port = called && called.port;
	const go = async () => {
		try {
			await fetch(${literal(proceed)}, { method: 'POST', body: ${literal(offer)} });
		} catch (error) {}
		if (port) port.postMessage({ op: 'navigate', url: ${literal(from)}, replace: true });
		else location.replace(${literal(routed)});
	};
	const back = () => {
		if (port) port.postMessage({ op: 'step', delta: -1 });
		else history.back();
	};
	addEventListener('DOMContentLoaded', () => {
		document.getElementById('proceed-button').addEventListener('click', go);
		document.getElementById('primary-button').addEventListener('click', back);
	});
})();</script>`;
	return new Response(
		`<!doctype html><html dir="ltr" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="initial-scale=1, minimum-scale=1, width=device-width">${errorReportScript(from, client)}${script}<title>Connection is not secure</title><style>body{font-family:system-ui,sans-serif;color:#202124;margin:0;padding:14vh 24px 0}main{max-width:600px;margin:0 auto}h1{font-size:1.6em;font-weight:normal;line-height:1.25}p{line-height:1.6;font-size:15px}.nav{display:flex;gap:12px;justify-content:flex-end;margin-top:48px}button{font:inherit;font-size:14px;border-radius:4px;padding:8px 16px;cursor:pointer}#primary-button{background:#1a73e8;color:#fff;border:0}#proceed-button{background:#fff;color:#1a73e8;border:1px solid #dadce0}</style></head><body><main><h1>Connection is not secure</h1><p>The site&rsquo;s shields require HTTPS, and <strong>${escapeHTML(host)}</strong> does not support a secure connection. Attackers could see or change what you send to and get from this site.</p><div class="nav"><button id="proceed-button" type="button">Continue to site</button><button id="primary-button" type="button">Go back</button></div></main></body></html>`,
		{
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			},
		},
	);
}
