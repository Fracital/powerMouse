/**
 * Mixed content, as Chrome 152 decides it (measured: test/suites/mixed-content
 * and docs/browserleaks-baseline.md). Every proxied page is https (or a
 * loopback http) in proxy URL space, so the browser's own enforcement never
 * fires for it: the service worker decides from the page's real URL instead,
 * and the inject does the same for what never reaches the worker (WebSocket,
 * sendBeacon's answer). Shared by both, so it carries no worker or DOM code.
 *
 * A request is mixed content when its URL is http: or ws: and not
 * potentially trustworthy, and the document that makes it (or the proxied
 * top above it) is https. Then:
 *
 * - an image (not a srcset or picture candidate), audio or video is
 *   upgraded to https, keeping a non-default port; a failed upgrade is the
 *   network error the https load gives, never a fallback to http. A host
 *   that is an IP address or localhost is not upgraded and loads as is, with
 *   a warning (Chrome warns even for the loopback ones it never calls mixed);
 * - anything else (scripts, stylesheets and @import, fonts, frames,
 *   objects, fetch, XHR, EventSource, beacons, prefetches, a worker's
 *   requests, srcset candidates, WebSockets) is blocked as a network error;
 * - a form that targets http is warned about, blocked in a nested frame,
 *   and stopped at an interstitial at the top.
 *
 * A document whose policy has upgrade-insecure-requests (its CSP header or
 * meta, or its parent's) upgrades every insecure request first, active
 * content and navigations included, whatever its own scheme.
 * block-all-mixed-content changes nothing in Chrome 152 (measured).
 */

/** the scheme an insecure URL is upgraded to */
const UPGRADED: Record<string, string> = { 'http:': 'https:', 'ws:': 'wss:' };

/**
 * Chrome's potentially trustworthy URLs: https and wss, and the loopback
 * hosts it treats as secure (localhost and its subdomains, 127/8, ::1).
 */
export function potentiallyTrustworthy(url: URL): boolean {
	if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
	const host = url.hostname;
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '[::1]' ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

/** an http: or ws: URL the browser would call insecure */
export function insecure(url: URL): boolean {
	return url.protocol in UPGRADED && !potentiallyTrustworthy(url);
}

/** whether a page's URL makes the content it loads mixed (https, or its wss twin) */
export function restrictsMixedContent(url: string | URL | null | undefined) {
	if (!url) return false;
	const text = typeof url === 'string' ? url : url.href;
	return text.startsWith('https:');
}

/** `url` with Chrome's upgrade applied: https/wss, port 80 becomes 443 */
export function upgradedURL(url: URL): URL {
	const upgraded = new URL(url.href);
	const port = upgraded.port;
	upgraded.protocol = UPGRADED[upgraded.protocol] ?? upgraded.protocol;
	if (port === '80') upgraded.port = '';
	return upgraded;
}

/** a host Chrome does not upgrade: an IP address or a local name */
function notUpgraded(url: URL): 'ip' | 'local' | null {
	const host = url.hostname;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return 'ip';
	if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
	return null;
}

/**
 * What a console notice says, by kind. The inject writes the sentence
 * (Chrome's own words), naming the page it is about: `self` the document
 * that made the request, `top` the proxied top when it is https (Chrome
 * names the outermost frame the content is mixed in) and else the document.
 */
export interface MixedContentNotice {
	kind:
		| 'blocked'
		| 'upgraded'
		| 'not-upgraded-ip'
		| 'not-upgraded-local'
		| 'should-also'
		| 'form'
		| 'websocket';
	/** the type Chrome names (`script`, `frame`, `resource`, ...) */
	type?: string;
	/** the URL as the page asked for it */
	url: string;
}

/** a notice's console level and its sentence, for the page at `page` */
export function noticeText(
	notice: MixedContentNotice,
	page: string,
): { level: 'error' | 'warn'; text: string } {
	const start = `Mixed Content: The page at '${page}' was loaded over HTTPS, but`;
	switch (notice.kind) {
		case 'blocked':
			return {
				level: 'error',
				text: `${start} requested an insecure ${notice.type} '${notice.url}'. This request has been blocked; the content must be served over HTTPS.`,
			};
		case 'upgraded':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was automatically upgraded to HTTPS, For more information see https://blog.chromium.org/2019/10/no-more-mixed-messages-about-https.html`,
			};
		case 'not-upgraded-ip':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was not upgraded to HTTPS because its URL's host is an IP address.`,
			};
		case 'not-upgraded-local':
			return {
				level: 'warn',
				text: `${start} requested an insecure element '${notice.url}'. This request was not upgraded to HTTPS because it is a local network request.`,
			};
		case 'should-also':
			return {
				level: 'warn',
				text: `${start} requested an insecure ${notice.type} '${notice.url}'. This content should also be served over HTTPS.`,
			};
		case 'form':
			return {
				level: 'warn',
				text: `Mixed Content: The page at '${page}' was loaded over a secure connection, but contains a form that targets an insecure endpoint '${notice.url}'. This endpoint should be made available over a secure connection.`,
			};
		case 'websocket':
			return {
				level: 'error',
				text: `${start} attempted to connect to the insecure WebSocket endpoint '${notice.url}'. This request has been blocked; this endpoint must be available over WSS.`,
			};
	}
}

/** which page a notice names: the top for a block and its kin, the document itself for an upgrade */
export function noticeNamesTop(notice: MixedContentNotice): boolean {
	return (
		notice.kind === 'blocked' ||
		notice.kind === 'websocket' ||
		notice.kind === 'form' ||
		notice.kind === 'should-also'
	);
}

/** Chrome's name for what a request of `destination` loads */
export function typeName(destination: string): string {
	switch (destination) {
		case 'script':
		case 'paintworklet':
		case 'audioworklet':
			return 'script';
		case 'style':
			return 'stylesheet';
		case 'image':
			return 'image';
		case 'font':
			return 'font';
		case 'iframe':
		case 'frame':
		case 'document':
			return 'frame';
		case 'object':
		case 'embed':
			return 'plugin resource';
		case 'track':
			return 'Text Track';
		case 'worker':
			return 'Worker';
		case 'sharedworker':
			return 'Shared Worker script';
		case 'serviceworker':
			return 'Service Worker script';
		case 'manifest':
			return 'manifest';
		case 'audio':
			return 'audio file';
		case 'video':
			return 'video';
		case 'xslt':
			return 'XSLT';
		case 'report':
			return 'Content Security Policy reporting endpoint';
		default:
			return 'resource';
	}
}

export interface MixedContentRequest {
	/** the real URL asked for */
	url: URL;
	/** what it loads (Sec-Fetch-Dest's value, `empty` for fetch and the like) */
	destination: string;
	/** a srcset or picture candidate (Chrome's image set: blocked, not upgraded) */
	imageSet?: boolean;
	/** Chrome's type when the destination does not say it (XHR, EventSource, Beacon, prefetch) */
	type?: string;
	/** the real URL of the document (or worker) that makes it; for a nested navigation, the parent */
	context: URL | null;
	/** the origin of the proxied top above it, when it is nested */
	top: string | null;
	/** the context's policy has upgrade-insecure-requests */
	upgradeInsecure: boolean;
}

export type MixedContentVerdict =
	| { action: 'allow'; notices: MixedContentNotice[] }
	| {
			action: 'upgrade';
			url: URL;
			notices: MixedContentNotice[];
			/**
			 * audio or video: Chrome's media player warns once more when the
			 * response is in, naming what it holds (`audio file` for audio,
			 * `video` for video, whatever the element: measured with a WAV in a
			 * <video>), as `should-also` with the URL asked for
			 */
			media?: boolean;
	  }
	| { action: 'block'; notices: MixedContentNotice[] };

const PASSIVE = ['image', 'audio', 'video'];

/** what Chrome does with a subresource request or a nested navigation */
export function mixedContentVerdict(
	request: MixedContentRequest,
): MixedContentVerdict {
	const { url } = request;
	const pageURL = url.href;
	if (!(url.protocol in UPGRADED)) return { action: 'allow', notices: [] };
	// upgrade-insecure-requests comes first, for every request of the page,
	// and the upgraded request is mixed content no more
	if (request.upgradeInsecure && !potentiallyTrustworthy(url))
		return { action: 'upgrade', url: upgradedURL(url), notices: [] };
	const secure =
		restrictsMixedContent(request.context) ||
		restrictsMixedContent(request.top);
	if (!secure) return { action: 'allow', notices: [] };
	const passive = PASSIVE.includes(request.destination) && !request.imageSet;
	if (passive) {
		// the autoupgrade looks at http images before asking whether they are
		// mixed at all: a loopback one is warned about too
		const exempt = notUpgraded(url);
		if (exempt === null)
			return {
				action: 'upgrade',
				url: upgradedURL(url),
				notices: [{ kind: 'upgraded', url: pageURL }],
				...(request.destination === 'image' ? {} : { media: true }),
			};
		const notices: MixedContentNotice[] = [
			{
				kind: exempt === 'ip' ? 'not-upgraded-ip' : 'not-upgraded-local',
				url: pageURL,
			},
		];
		// passive content Chrome does not upgrade loads over http, a warning
		// more when it is mixed (a loopback host never is)
		if (insecure(url))
			notices.push({
				kind: 'should-also',
				type: typeName(request.destination),
				url: pageURL,
			});
		return { action: 'allow', notices };
	}
	if (!insecure(url)) return { action: 'allow', notices: [] };
	return {
		action: 'block',
		notices: [
			{
				kind: 'blocked',
				type: request.type ?? typeName(request.destination),
				url: pageURL,
			},
		],
	};
}

/**
 * Whether a CSP header value or meta content enforces
 * upgrade-insecure-requests (any of its comma-separated policies)
 */
export function upgradesInsecureRequests(policy: string | null): boolean {
	if (!policy) return false;
	return policy
		.split(/[,;]/)
		.some((directive) =>
			/^\s*upgrade-insecure-requests(\s|$)/i.test(directive),
		);
}

/**
 * Whether markup's head has a `<meta http-equiv="Content-Security-Policy">`
 * with upgrade-insecure-requests (a meta policy counts in the head only)
 */
export function metaUpgradesInsecureRequests(markup: string): boolean {
	const body = markup.search(/<body[\s>]/i);
	const head = body === -1 ? markup : markup.slice(0, body);
	for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
		if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>/]/i.test(tag))
			continue;
		const content = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		if (
			upgradesInsecureRequests(
				content?.[2] ?? content?.[3] ?? content?.[4] ?? null,
			)
		)
			return true;
	}
	return false;
}
