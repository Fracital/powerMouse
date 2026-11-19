// The Reporting API's delivery of the reports a page's policy sends to its
// report-to endpoint (Reporting-Endpoints), in the browser's place: the
// browser never gets the page's report-to (src/csp.ts browserPolicy, the
// header is stripped, filterHeaders.ts), so the inject hands each report
// to this worker (src/inject/dom/violationDelivery.ts, a `reports` load),
// which delivers it as Chrome's network service does (measured, Chrome
// 157): the first report at once, the ones queued after it together about
// a minute after the last upload, or at once when their document goes away
// (navigated from, or its frame removed), each document's reports for one
// endpoint in one POST of application/reports+json (a list of { age, body, type, url,
// user_agent }, the members in alphabetical order); no Referer and no
// Sec-Fetch- headers; an endpoint of another origin asked first by a CORS
// preflight and sent no cookies, one of the document's origin sent them.
// A report outlives its document: the fetch event that handed it over
// waits until it is delivered. One that fails goes again with the next
// upload, up to MAX_ATTEMPTS times.
import type { BareCompatibleClient } from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import { preflightAllows } from './cors';

/** how long Chrome's delivery waits after an upload before the next (measured) */
const DELIVERY_INTERVAL_MS = 60_000;
/** how many uploads a report is tried in before it is dropped */
const MAX_ATTEMPTS = 5;
/** the preflight cache partition these preflights would use, which none reads */
const PREFLIGHT_PARTITION = 'reporting';
/** how often the documents of waiting reports are looked for while they wait */
const GONE_POLL_MS = 1000;

/** a report as the inject hands it over: its type, url and body */
export interface HandedReport {
	type: string;
	url: string;
	body: Record<string, unknown>;
}

interface Pending {
	report: HandedReport;
	userAgent: string;
	queued: number;
	attempts: number;
	done: () => void;
}

/** what an upload goes through: the transport and the cookie jar */
export interface Uploader {
	bare: BareCompatibleClient;
	/** the Cookie header of a request of `url`'s own origin */
	cookie(url: URL): Promise<string>;
}

interface Group {
	endpoint: URL;
	origin: string;
	/** the client id of the document the reports are of ('' when unknown) */
	source: string;
	reports: Pending[];
}

/** the reports waiting, by endpoint, origin and document */
const waiting = new Map<string, Group>();
let lastUpload = -Infinity;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

const groupKey = (endpoint: URL, origin: string, source: string) =>
	`${endpoint.href} ${origin} ${source}`;

/** the group `key` names, made when there is none */
function groupOf(endpoint: URL, origin: string, source: string): Group {
	const key = groupKey(endpoint, origin, source);
	let group = waiting.get(key);
	if (!group)
		waiting.set(key, (group = { endpoint, origin, source, reports: [] }));
	return group;
}

/** an endpoint Chrome takes: a potentially trustworthy URL */
const trustworthy = (url: URL) =>
	url.protocol === 'https:' ||
	(url.protocol === 'http:' &&
		/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname));

/** a value with the members of its objects in alphabetical order, as Chrome writes a report */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		out[key] = sorted((value as Record<string, unknown>)[key]);
	return out;
}

/** whether `value` is a report the inject could have handed over */
function isReport(value: unknown): value is HandedReport {
	const report = value as HandedReport;
	return (
		typeof report === 'object' &&
		report !== null &&
		typeof report.type === 'string' &&
		typeof report.url === 'string' &&
		typeof report.body === 'object' &&
		report.body !== null
	);
}

/**
 * Queue the report `text` (a HandedReport's JSON) for `endpoint`, from the
 * document whose client id is `source`; settles once it was delivered or
 * given up
 */
export function queueReport(
	uploader: Uploader,
	endpoint: URL,
	text: string,
	source = '',
): Promise<void> {
	let report: unknown;
	try {
		report = JSON.parse(text);
	} catch (error) {
		return Promise.resolve();
	}
	if (!isReport(report) || !trustworthy(endpoint)) return Promise.resolve();
	let origin: string;
	try {
		origin = new URL(report.url).origin;
	} catch (error) {
		return Promise.resolve();
	}
	return new Promise((done) => {
		groupOf(endpoint, origin, source).reports.push({
			report,
			userAgent: navigator.userAgent,
			queued: Date.now(),
			attempts: 0,
			done,
		});
		schedule(uploader);
		watchSources(uploader);
	});
}

/**
 * While reports wait, look for their documents: a document gone (Chrome's
 * reporting source expiring with it) has its reports delivered at once
 */
function watchSources(uploader: Uploader) {
	if (polling || typeof clients === 'undefined') return;
	polling = true;
	const look = async () => {
		const sources = new Set<string>();
		for (const group of waiting.values())
			if (group.source) sources.add(group.source);
		if (!sources.size) {
			polling = false;
			return;
		}
		const gone = new Set<string>();
		for (const source of sources)
			if (!(await clients.get(source).catch(() => undefined))) gone.add(source);
		if (gone.size) deliver(uploader, (group) => gone.has(group.source));
		setTimeout(look, GONE_POLL_MS);
	};
	setTimeout(look, GONE_POLL_MS);
}

/** deliver now when the last upload was long enough ago, else when it will be */
function schedule(uploader: Uploader) {
	if (timer !== null) return;
	const wait = lastUpload + DELIVERY_INTERVAL_MS - Date.now();
	if (wait <= 0) deliver(uploader);
	else
		timer = setTimeout(() => {
			timer = null;
			deliver(uploader);
		}, wait);
}

/**
 * Upload the waiting reports, or those of the groups `only` takes (the
 * documents gone, which leave the delivery's interval as it is)
 */
function deliver(uploader: Uploader, only?: (group: Group) => boolean) {
	if (!only) lastUpload = Date.now();
	const groups: Group[] = [];
	for (const [key, group] of waiting)
		if (!only || only(group)) {
			groups.push(group);
			waiting.delete(key);
		}
	for (const group of groups)
		upload(uploader, group.endpoint, group.origin, group.reports)
			.catch(() => false)
			.then((sent) => {
				for (const pending of group.reports) {
					pending.attempts++;
					if (sent || pending.attempts >= MAX_ATTEMPTS) {
						pending.done();
						continue;
					}
					// (again with the next upload, its document's or not)
					groupOf(group.endpoint, group.origin, '').reports.push(pending);
				}
				if (waiting.size) schedule(uploader);
			});
}

/** one upload of `reports` to `endpoint`; whether the endpoint took it */
async function upload(
	uploader: Uploader,
	endpoint: URL,
	origin: string,
	reports: Pending[],
): Promise<boolean> {
	const now = Date.now();
	const body = JSON.stringify(
		reports.map(({ report, userAgent, queued }) =>
			sorted({
				age: now - queued,
				body: report.body,
				type: report.type,
				url: report.url,
				user_agent: userAgent,
			}),
		),
	);
	const language = acceptLanguage(navigator.languages);
	const sameOrigin = endpoint.origin === origin;
	if (!sameOrigin) {
		const asked: [string, string][] = [
			['origin', origin],
			['access-control-request-method', 'POST'],
			['access-control-request-headers', 'content-type'],
			['user-agent', navigator.userAgent],
		];
		if (language) asked.push(['accept-language', language]);
		const answer = await uploader.bare.fetch(endpoint.href, {
			method: 'OPTIONS',
			redirect: 'manual',
			headers: asked,
		});
		await answer.body?.cancel().catch(() => {});
		if (
			!preflightAllows(
				answer,
				origin,
				endpoint.href,
				false,
				'POST',
				['content-type'],
				PREFLIGHT_PARTITION,
			)
		)
			return false;
	}
	const headers: [string, string][] = [
		['content-type', 'application/reports+json'],
		['origin', origin],
		['user-agent', navigator.userAgent],
	];
	if (language) headers.push(['accept-language', language]);
	const cookie = sameOrigin ? await uploader.cookie(endpoint) : '';
	if (cookie) headers.push(['cookie', cookie]);
	const answer = await uploader.bare.fetch(endpoint.href, {
		method: 'POST',
		redirect: 'manual',
		headers,
		body,
	});
	await answer.body?.cancel().catch(() => {});
	return answer.status >= 200 && answer.status <= 299;
}

/**
 * The endpoints of a document's Reporting-Endpoints header (`value`), by
 * name, as absolute URLs: only for a document of an https URL (`url`), and
 * only endpoints Chrome takes (potentially trustworthy URLs; measured,
 * Chrome 157: an http document's report-to sends nothing, and Report-To
 * groups are not report-to endpoints)
 */
export function reportingEndpoints(
	value: string | null,
	url: URL,
): Record<string, string> | undefined {
	if (!value || url.protocol !== 'https:') return undefined;
	const endpoints: Record<string, string> = {};
	let any = false;
	// a structured dictionary of strings: name="url", name2="url"
	for (const match of value.matchAll(
		/(?:^|,)\s*([a-z*][a-z0-9_\-.*]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:;[^,]*)?(?=,|$)/g,
	)) {
		const [, name, raw] = match;
		let endpoint: URL;
		try {
			endpoint = new URL(raw.replace(/\\(.)/g, '$1'), url);
		} catch (error) {
			continue;
		}
		if (!trustworthy(endpoint)) continue;
		// (a name given twice is its last: a structured dictionary's rule)
		endpoints[name] = endpoint.href;
		any = true;
	}
	return any ? endpoints : undefined;
}
