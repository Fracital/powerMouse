import {
	ancestorAllowed,
	CODE_DIRECTIVES,
	FALLBACK,
	governing,
	hopRefusals,
	hostsApply,
	namedRefusal,
	parsePolicies,
	REFUSED_URL,
	sourcesMatch,
	type Policy,
} from '../csp';
import { CSP_REPORT } from '../transport/messages';
import type { NavigationChain } from './navigationHints';

/**
 * The page's own policies of each document the worker served (src/csp.ts),
 * by the routed URL it served it at and by its client id: the browser
 * applies what of them it can to the proxy's URLs, and what names hosts is
 * applied here, to every request the document makes. A document of the
 * creator's (about:blank, srcdoc) has its creator's policies natively; its
 * requests name that document as their referrer. Kept in memory: a
 * restarted worker forgets them, and the documents' requests then go out as
 * natively without a policy.
 */
interface Served {
	/** the document's real URL: what 'self' means */
	url: URL;
	policies: Policy[];
}

const served = new Map<string, Served>();
const KEPT = 512;

const withoutHash = (url: string) => {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
};

function remember(key: string, value: Served) {
	served.delete(key);
	if (served.size >= KEPT) served.delete(served.keys().next().value!);
	served.set(key, value);
}

/** the document served at `routed` (to the client `clientId`), at `url` natively, has the page's `policies` */
export function rememberPolicies(
	routed: string,
	clientId: string | undefined,
	url: URL,
	policies: Policy[],
) {
	const value = { url, policies };
	remember(`url ${withoutHash(routed)}`, value);
	if (clientId) remember(`client ${clientId}`, value);
}

/** the policies of the client, or of the document at `referrer` (an about:blank or srcdoc document's creator) */
function policiesOf(
	clientId: string | undefined,
	referrer: string | null | undefined,
): Served | null {
	if (clientId) {
		const known = served.get(`client ${clientId}`);
		if (known) return known;
	}
	if (referrer) {
		const known = served.get(`url ${withoutHash(referrer)}`);
		if (known) {
			if (clientId) remember(`client ${clientId}`, known);
			return known;
		}
	}
	return null;
}

/** the directive a request of `destination` is judged by (CSP3 §6.8.1) */
export function directiveOf(destination: string): string | null {
	switch (destination) {
		case '':
		case 'empty':
		case 'json':
		case 'webidentity':
			return 'connect-src';
		case 'audio':
		case 'track':
		case 'video':
			return 'media-src';
		case 'font':
			return 'font-src';
		case 'image':
			return 'img-src';
		case 'manifest':
			return 'manifest-src';
		case 'object':
		case 'embed':
			return 'object-src';
		case 'frame':
		case 'iframe':
			return 'frame-src';
		case 'fencedframe':
			return 'fenced-frame-src';
		case 'script':
		case 'xslt':
		case 'audioworklet':
		case 'paintworklet':
			return 'script-src-elem';
		case 'serviceworker':
		case 'sharedworker':
		case 'worker':
			return 'worker-src';
		case 'style':
			return 'style-src-elem';
		default:
			return null;
	}
}

/**
 * The policies of the document that makes a request of `destination` for
 * `url` that refuse it, enforced and report-only (empty for none, or for a
 * document the worker knows no policy of)
 */
export function refusingPolicies(
	clientId: string | undefined,
	referrer: string | null | undefined,
	destination: string,
	url: URL,
	redirected = false,
): Policy[] {
	const directive = directiveOf(destination);
	if (!directive || !FALLBACK[directive]) return [];
	const document = policiesOf(clientId, referrer);
	if (!document) return [];
	return document.policies.filter((policy) => {
		const governed = governing(policy, directive);
		return (
			governed !== null &&
			// a script or style list that decides by the element too is the
			// browser's and the inject's (src/csp.ts hostsApply)
			(!CODE_DIRECTIVES.includes(directive) || hostsApply(governed.sources)) &&
			!sourcesMatch(governed.sources, url, document.url, redirected)
		);
	});
}

/**
 * The policies of `markup`'s `<meta http-equiv="Content-Security-Policy">`
 * elements in its head, as the browser applies them when it parses them
 */
export function metaPolicies(markup: string): Policy[] {
	const body = markup.search(/<body[\s>]/i);
	const head = body === -1 ? markup : markup.slice(0, body);
	const policies: Policy[] = [];
	for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
		if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>/]/i.test(tag))
			continue;
		const content = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const value = content?.[2] ?? content?.[3] ?? content?.[4];
		if (value !== undefined)
			policies.push(...parsePolicies(decodeEntities(value), 'enforce', 'meta'));
	}
	return policies;
}

/** the character references an attribute value of a policy may hold */
function decodeEntities(value: string): string {
	return value.replace(
		/&(#x[0-9a-f]+|#\d+|quot|amp|apos|lt|gt);/gi,
		(_, ref: string) => {
			const lower = ref.toLowerCase();
			if (lower.startsWith('#x'))
				return String.fromCodePoint(parseInt(lower.slice(2), 16));
			if (lower.startsWith('#'))
				return String.fromCodePoint(Number(lower.slice(1)));
			return (
				{ quot: '"', amp: '&', apos: "'", lt: '<', gt: '>' } as Record<
					string,
					string
				>
			)[lower];
		},
	);
}

declare const clients: Clients | undefined;

/**
 * Tell the document that made a request of `directive` for `url` that a
 * report-only policy of its refuses it, which the browser would have
 * reported (the inject does: src/inject/dom/modules/ContentSecurity.ts).
 * Never awaited by the request.
 */
export async function postReport(
	clientId: string | undefined,
	directive: string,
	url: URL,
	/** a navigation's later hop: what the report names, how often, whether the policy is the client's parent's */
	hop?: [string, number, boolean],
) {
	if (!clientId || typeof clients === 'undefined') return;
	try {
		(await clients.get(clientId))?.postMessage({
			[CSP_REPORT]: [directive, url.href, ...(hop ?? [])],
		});
	} catch (error) {
		// the client went away: nobody to tell
	}
}

/**
 * Where a later hop of a navigation to `url` goes instead when a policy
 * of its chain refuses it (a form's form-action; a frame's parent's
 * frame-src, for a `frame`'s navigation), or null when it may go on. The
 * browser reports a form's refused hop by the chain's first URL, so any
 * refused URL does; a frame's by the URL it refused, which the host of the
 * one returned names. A report-only policy's refusal is told to the
 * document whose policy it is.
 */
export function hopRefusal(
	chain: NavigationChain,
	url: URL,
	frame: boolean,
	/** the real URL the navigation began at */
	first: string,
): string | null {
	for (const directive of frame
		? ['form-action', 'frame-src']
		: ['form-action']) {
		const refusing = chain.policies.filter(
			({ policy }) => hopRefusals([policy], directive, url).length,
		);
		if (refusing.some(({ policy }) => policy[2] === 'enforce'))
			return directive === 'form-action' ? REFUSED_URL : namedRefusal(url.href);
		for (const { policy, client, parent } of refusing) {
			let blocked = url.href.replace(/#.*$/s, '');
			try {
				if (
					directive === 'frame-src' &&
					new URL(policy[3]).origin !== url.origin
				)
					blocked = url.origin;
			} catch (error) {
				// no such document URL: the whole URL
			}
			// (a form's report names the chain's first URL)
			postReport(client, directive, url, [
				directive === 'form-action' ? first.replace(/#.*$/s, '') : blocked,
				directive === 'frame-src' ? 2 : 1,
				parent,
			]);
		}
	}
	return null;
}

/**
 * Whether the enforced frame-ancestors of a document's response `headers`
 * (it is at `url`) refuses one of its real `ancestors`' origins
 */
export function refusesAncestors(
	headers: Headers,
	url: URL,
	ancestors: string[],
): boolean {
	return parsePolicies(
		headers.get('content-security-policy'),
		'enforce',
		'header',
	).some((policy) => {
		const sources = policy.directives.get('frame-ancestors');
		return (
			sources !== undefined &&
			ancestors.some((origin) => !ancestorAllowed(sources, origin, url))
		);
	});
}
