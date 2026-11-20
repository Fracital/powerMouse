import {
	ancestorAllowed,
	CODE_DIRECTIVES,
	FALLBACK,
	governing,
	governsWorkerRequests,
	hopRefusals,
	parsePolicies,
	REFUSED_URL,
	sourcesMatch,
	type Policy,
	type WorkerPolicies,
} from '../csp';
import { hostsApply } from '../cspJudge';
import { namedRefusal } from '../refusalName';
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
	/** a worker's (rememberWorkerPolicies) */
	worker?: true;
	/** the destinations its Integrity-Policy blocks (integrityPolicyDestinations) */
	integrity?: string[];
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
	integrity: string[] = [],
) {
	const value = { url, policies, ...(integrity.length ? { integrity } : {}) };
	remember(`url ${withoutHash(routed)}`, value);
	if (clientId) remember(`client ${clientId}`, value);
}

/**
 * Whether a policy of the client `clientId` (or of the document at
 * `referrer`) governs one of `directives`, report-only ones too
 */
export function policiesGovern(
	clientId: string | undefined,
	referrer: string | null | undefined,
	directives: readonly string[],
	creatorOf?: (client: string) => string | undefined,
): boolean {
	return !!policiesOf(clientId, referrer, creatorOf)?.policies.some((policy) =>
		directives.some((directive) => governing(policy, directive) !== null),
	);
}

/** whether the policies of the client `clientId` are known (a document's, a worker's) */
export const knowsPoliciesOf = (clientId: string): boolean =>
	served.has(`client ${clientId}`);

/**
 * The worker `clientId` (a dedicated, shared or emulated service worker of
 * a URL), whose script answered at `url`, has the policies of that response
 * (`policies`, none included), never its creator's, natively (measured,
 * Chrome 157): its requests are judged by them, and a blob: worker it makes
 * inherits them
 */
export function rememberWorkerPolicies(
	clientId: string,
	url: URL,
	policies: Policy[],
) {
	remember(`client ${clientId}`, { url, policies, worker: true });
}

/** the members of a report of a worker's (src/inject/worker/Client.ts deliverReport) */
const WORKER_REPORT_MEMBERS = [
	'document-uri',
	'referrer',
	'violated-directive',
	'effective-directive',
	'original-policy',
	'disposition',
	'blocked-uri',
	'line-number',
	'column-number',
	'source-file',
	'status-code',
	'script-sample',
];

/**
 * Whether `text` is a report the worker `clientId` could send to `endpoint`
 * (src/inject/worker/Client.ts deliverReport, WORKER_REPORT_LOAD): a
 * `{"csp-report": {...}}` of Chrome's members, of strings and numbers, whose
 * original-policy is one of the worker's own policies (a blob: worker's are
 * its creator's) that names that endpoint in its report-uri. Such a request
 * goes as a report load; a page's script in the worker could make one only
 * of what a violation of its policy sends there natively.
 */
export function workerReportAllowed(
	clientId: string,
	endpoint: URL,
	text: string,
	creatorOf?: (client: string) => string | undefined,
): boolean {
	const known = policiesOf(clientId, null, creatorOf);
	if (!known?.worker) return false;
	let report: unknown;
	try {
		report = JSON.parse(text);
	} catch (error) {
		return false;
	}
	if (typeof report !== 'object' || report === null) return false;
	const keys = Object.keys(report);
	const members = (report as Record<string, unknown>)['csp-report'];
	if (
		keys.length !== 1 ||
		typeof members !== 'object' ||
		members === null ||
		Array.isArray(members)
	)
		return false;
	for (const [key, value] of Object.entries(members))
		if (
			!WORKER_REPORT_MEMBERS.includes(key) ||
			(typeof value !== 'string' && typeof value !== 'number')
		)
			return false;
	const target = withoutHash(endpoint.href);
	const policyText = (members as Record<string, unknown>)['original-policy'];
	return known.policies.some(
		(policy) =>
			policy.text === policyText &&
			(policy.directives.get('report-uri') ?? []).some((uri) => {
				try {
					return withoutHash(new URL(uri, known.url).href) === target;
				} catch (error) {
					return false;
				}
			}),
	);
}

/**
 * The policies of the client, or of the document at `referrer` (an
 * about:blank or srcdoc document's creator). A blob: worker has its
 * creator's (`creatorOf`, which knows only blob: workers), as a worker of
 * a URL has its own
 */
function policiesOf(
	clientId: string | undefined,
	referrer: string | null | undefined,
	creatorOf?: (client: string) => string | undefined,
): Served | null {
	if (clientId) {
		const known = served.get(`client ${clientId}`);
		if (known) return known;
		// (a blob: worker of a blob: worker: its creator's creator's)
		let creator = creatorOf?.(clientId);
		for (let depth = 0; creator && depth < 8; depth++) {
			const inherited = served.get(`client ${creator}`);
			if (inherited) return { ...inherited, worker: true };
			creator = creatorOf?.(creator);
		}
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

/**
 * The destinations a document's Integrity-Policy header blocks without
 * integrity metadata: its blocked-destinations, of those Chrome 157 knows
 * (script). The browser would apply it to STomp's own scripts and to the
 * page's, whose metadata the worker checks itself (src/sri.ts), so it never
 * gets the header (filterHeaders) and the worker applies it
 * (integrityRefuses).
 */
export function integrityPolicyDestinations(header: string | null): string[] {
	const match = /(?:^|,)\s*blocked-destinations=\(([^)]*)\)/.exec(header ?? '');
	if (!match) return [];
	return match[1]
		.trim()
		.split(/\s+/)
		.filter((token) => token === 'script');
}

/**
 * Whether the Integrity-Policy of the document that makes a request of
 * `destination` refuses it, as Chrome does: one with no integrity metadata,
 * or that is not a CORS request (measured: a same-origin script with a
 * matching integrity and no crossorigin attribute is blocked)
 */
export function integrityRefuses(
	clientId: string | undefined,
	referrer: string | null | undefined,
	destination: string,
	mode: RequestMode,
	integrity: boolean,
	creatorOf?: (client: string) => string | undefined,
): boolean {
	const document = policiesOf(clientId, referrer, creatorOf);
	if (!document?.integrity?.includes(destination)) return false;
	return !integrity || (mode !== 'cors' && mode !== 'same-origin');
}

/** a response's policies, enforced and report-only */
export const responsePolicies = (headers: Headers): Policy[] => [
	...parsePolicies(headers.get('content-security-policy'), 'enforce', 'header'),
	...parsePolicies(
		headers.get('content-security-policy-report-only'),
		'report',
		'header',
	),
];

/**
 * The policies a worker whose script answered at `url` with `headers`
 * judges its own connections by (src/csp.ts WorkerPolicies), or null for
 * none that governs them: its response's, natively (a blob: or data:
 * worker inherits its creator's, which the inject hands it)
 */
export function workerPolicies(
	headers: Headers,
	url: URL,
): WorkerPolicies | null {
	const policies = responsePolicies(headers)
		.filter(governsWorkerRequests)
		.map((policy): WorkerPolicies['policies'][number] => [
			policy.text,
			policy.disposition,
			url.href,
		]);
	return policies.length ? { policies } : null;
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
 * The policies of the document or worker that makes a request of
 * `destination` for `url` that refuse it, enforced and report-only (empty
 * for none, or for a client the worker knows no policy of), and whether
 * the client is a worker. A module worker's static imports (a worker
 * destination in `cors` mode, from the worker itself) are judged by its
 * creator's policies, as natively: the worker's own are not yet in force
 * while its module graph loads (measured, Chrome 157).
 */
export function refusingPolicies(
	clientId: string | undefined,
	referrer: string | null | undefined,
	destination: string,
	url: URL,
	redirected = false,
	mode?: RequestMode,
	creatorOf?: (client: string) => string | undefined,
	ownerOf?: (client: string) => string | undefined,
): { policies: Policy[]; worker: boolean } {
	const directive = directiveOf(destination);
	if (!directive || !FALLBACK[directive])
		return { policies: [], worker: false };
	let document = policiesOf(clientId, referrer, creatorOf);
	const worker = !!document?.worker;
	if (
		worker &&
		mode === 'cors' &&
		(destination === 'worker' || destination === 'sharedworker') &&
		clientId
	) {
		const creator = ownerOf?.(clientId);
		document = creator ? policiesOf(creator, null, creatorOf) : null;
	}
	if (!document) return { policies: [], worker };
	const policies = document.policies.filter((policy) => {
		const governed = governing(policy, directive);
		return (
			governed !== null &&
			// a script or style list that decides by the element too is the
			// browser's and the inject's (src/cspJudge.ts hostsApply)
			(!CODE_DIRECTIVES.includes(directive) || hostsApply(governed.sources)) &&
			!sourcesMatch(governed.sources, url, document!.url, redirected)
		);
	});
	return { policies, worker };
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
 * document whose policy it is, unless `report` is false (a hop asked about
 * before it is requested, which is judged again when it is).
 */
export function hopRefusal(
	chain: NavigationChain,
	url: URL,
	frame: boolean,
	/** the real URL the navigation began at */
	first: string,
	report = true,
): string | null {
	for (const directive of frame
		? ['form-action', 'frame-src']
		: ['form-action']) {
		const refusing = chain.policies.filter(
			({ policy }) => hopRefusals([policy], directive, url).length,
		);
		if (refusing.some(({ policy }) => policy[2] === 'enforce'))
			return directive === 'form-action' ? REFUSED_URL : namedRefusal(url.href);
		if (!report) continue;
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

/** a source the way two lists are compared: a keyword in lower case */
const sourceToken = (source: string) =>
	/^'(?!nonce-|sha)/i.test(source) ? source.toLowerCase() : source;

/**
 * CSP Embedded Enforcement: what a frame's document whose response has
 * `headers` makes of the policy its frame's csp attribute requires of it
 * (`required`), its parent being of the origin `parent`, as Chrome decides
 * (measured, Chrome 157): `apply` when its Allow-CSP-From is `*` or that
 * origin (the policy is enforced on it), `accept` when one of its own
 * enforced header policies is as strict for each of the required policy's
 * directives (each of that policy's sources is one of the required
 * directive's, or it allows none), else `refuse` (the browser's error page).
 * A report-only or meta policy counts for nothing.
 */
export function embeddingVerdict(
	headers: Headers,
	required: string,
	parent: string | undefined,
): 'apply' | 'accept' | 'refuse' {
	const allow = headers.get('allow-csp-from')?.trim();
	if (allow === '*' || (allow !== undefined && allow === parent))
		return 'apply';
	const [wanted] = parsePolicies(required, 'enforce', 'header');
	if (!wanted) return 'accept';
	const own = parsePolicies(
		headers.get('content-security-policy'),
		'enforce',
		'header',
	);
	const none = (sources: string[]) =>
		sources.every((source) => sourceToken(source) === "'none'");
	for (const [directive, sources] of wanted.directives) {
		const allowed = new Set(sources.map(sourceToken));
		const strict = own.some((policy) => {
			const governed = governing(policy, directive);
			if (!governed) return false;
			if (none(governed.sources)) return true;
			if (none(sources)) return false;
			return governed.sources.every((source) =>
				allowed.has(sourceToken(source)),
			);
		});
		if (!strict) return 'refuse';
	}
	return 'accept';
}

/**
 * Whether a document's response `headers` (it is at `url`) refuse one of
 * its real `ancestors`' origins: the enforced frame-ancestors, or, when no
 * enforced policy of the headers has one, X-Frame-Options as HTML's "check
 * a navigation response's adherence" reads it (Chrome's too, measured: a
 * list of more than one value refuses when it names a known one, DENY
 * refuses, SAMEORIGIN judges every ancestor, anything else lets it in)
 */
export function refusesAncestors(
	headers: Headers,
	url: URL,
	ancestors: string[],
): boolean {
	const policies = parsePolicies(
		headers.get('content-security-policy'),
		'enforce',
		'header',
	);
	let framed = false;
	for (const policy of policies) {
		const sources = policy.directives.get('frame-ancestors');
		if (sources === undefined) continue;
		framed = true;
		if (ancestors.some((origin) => !ancestorAllowed(sources, origin, url)))
			return true;
	}
	if (framed) return false;
	const raw = headers.get('x-frame-options');
	if (raw === null) return false;
	const values = new Set(
		raw.split(',').map((value) => value.trim().toLowerCase()),
	);
	const known = ['deny', 'allowall', 'sameorigin'];
	if (values.size > 1) return known.some((value) => values.has(value));
	if (values.has('deny')) return true;
	return values.has('sameorigin') && ancestors.some((o) => o !== url.origin);
}
