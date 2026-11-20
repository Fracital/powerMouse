// What the request path (rewrites.ts) asks of the extensions, in one place:
// each step is a synchronous "no" while no extension has rules or listeners,
// so a scope without extensions pays a property read per request.
import type { RawHeaders } from '@mercuryworkshop/proxy-transports';
import {
	displayExtensionOrigin,
	extensionOfHost,
} from '../../extensions/origin';
import type {
	WebRequestDetails,
	WebRequestListener,
	WebRequestVerdict,
} from '../../extensions/types';
import type { RequestInfo } from '../../transport/messages';
import type { ExtensionRegistry } from './registry';
import { webRequests, webRequestType } from './webRequest';

/** a request as the extensions see it */
export interface ExtensionRequest {
	requestId: string;
	url: string;
	method: string;
	/** the webRequest / DNR resource type */
	type: string;
	initiator: string | null;
	site: 'same-origin' | 'same-site' | 'cross-site' | 'none';
	client: string;
	/** what the blocking listeners changed of the headers sent, for onSendHeaders */
	sent?: boolean;
}

/** what the extensions make of a request before it goes out */
export type BeforeVerdict =
	| { cancel: true; by: string }
	| { redirect: string; by: string }
	| { upgrade: true; by: string }
	| null;

const toList = (headers: RawHeaders) =>
	headers.map(([name, value]) => ({ name, value }));

/**
 * The fields as they were before DNR changed them (`dnr`: each changed
 * name's value then, null for one a rule added): what onBeforeSendHeaders
 * shows, as Chrome dispatches it before it applies DNR's header actions
 * (MergeOnBeforeSendHeadersResponses)
 */
function beforeDnr(
	visible: RawHeaders,
	dnr: ReadonlyMap<string, string | null>,
): RawHeaders {
	const shown: RawHeaders = [];
	const done = new Set<string>();
	for (const [name, value] of visible) {
		const key = name.toLowerCase();
		if (!dnr.has(key)) shown.push([name, value]);
		else if (!done.has(key)) {
			done.add(key);
			const original = dnr.get(key);
			if (original !== null && original !== undefined)
				shown.push([name, original]);
		}
	}
	for (const [key, original] of dnr)
		if (original !== null && !done.has(key)) shown.push([key, original]);
	return shown;
}

/**
 * A listener's fields, merged as Chrome merges them with DNR's: the
 * listener's change against what it was shown is dropped whole when it sets
 * a field a rule removed or set to another value, or removes one a rule set
 */
function mergedWithDnr(
	visible: RawHeaders,
	shown: RawHeaders,
	answered: RawHeaders,
	dnr: ReadonlyMap<string, string | null>,
): RawHeaders {
	const valuesOf = (headers: RawHeaders) => {
		const values = new Map<string, [string, string]>();
		for (const [name, value] of headers) {
			const key = name.toLowerCase();
			if (!values.has(key)) values.set(key, [name, value]);
		}
		return values;
	};
	const before = valuesOf(shown);
	const after = valuesOf(answered);
	const now = valuesOf(visible);
	const set = [...after].filter(
		([key, [, value]]) => before.get(key)?.[1] !== value,
	);
	const removed = [...before.keys()].filter((key) => !after.has(key));
	if (
		set.some(
			([key, [, value]]) => dnr.has(key) && now.get(key)?.[1] !== value,
		) ||
		removed.some((key) => dnr.has(key) && now.has(key))
	)
		return visible;
	const gone = new Set(removed);
	const merged: RawHeaders = [];
	const placed = new Set<string>();
	const values = new Map(set);
	for (const [name, value] of visible) {
		const key = name.toLowerCase();
		if (gone.has(key) || placed.has(key)) continue;
		const changed = values.get(key);
		if (changed) placed.add(key);
		merged.push(changed ? [name, changed[1]] : [name, value]);
	}
	for (const [key, [name, value]] of set)
		if (!placed.has(key)) merged.push([name, value]);
	return merged;
}

const fromList = (list: { name: string; value?: string }[]): RawHeaders =>
	list
		.filter((header) => typeof header?.name === 'string')
		.map((header) => [header.name, String(header.value ?? '')]);

let requestIds = 0;

export class ExtensionPipeline {
	#registry: ExtensionRegistry;
	#channel: string;
	/** the requestId of a URL's last request per client, so the log's events carry it */
	#ids = new Map<string, string>();

	constructor(registry: ExtensionRegistry, channel: string) {
		this.#registry = registry;
		this.#channel = channel;
		webRequests.load().catch(() => {});
	}

	/** whether any step has something to do (no extension rules, no listeners: nothing) */
	get active(): boolean {
		return webRequests.any;
	}

	/** whether the request log should be built for the extensions */
	get logs(): boolean {
		return webRequests.completes;
	}

	request(init: {
		url: string;
		method: string;
		destination: string;
		navigation: boolean;
		top: boolean;
		initiator: string | null;
		site: ExtensionRequest['site'];
		client?: string;
	}): ExtensionRequest | null {
		if (!this.active) return null;
		const url = new URL(init.url);
		// an extension's own files are nobody's to block
		if (extensionOfHost(url.hostname)) return null;
		const requestId = String(++requestIds);
		const client = init.client ?? '';
		this.#ids.set(`${client}|${init.url}`, requestId);
		if (this.#ids.size > 512) this.#ids.delete(this.#ids.keys().next().value!);
		return {
			requestId,
			url: init.url,
			method: init.method,
			type: webRequestType(init.destination, init.navigation, init.top),
			// an extension's page asks from chrome-extension://, as in Chrome
			initiator: init.initiator && displayExtensionOrigin(init.initiator),
			site: init.site,
			client,
		};
	}

	#details(
		request: ExtensionRequest,
		more: Partial<WebRequestDetails> = {},
	): WebRequestDetails {
		return {
			requestId: request.requestId,
			url: request.url,
			method: request.method,
			type: request.type,
			tabId: -1,
			frameId: request.type === 'main_frame' ? 0 : -1,
			parentFrameId: -1,
			...(request.initiator && request.initiator !== 'null'
				? { initiator: request.initiator }
				: {}),
			timeStamp: Date.now(),
			client: request.client,
			...more,
		};
	}

	// (an extension whose site access withholds the host hears none of its requests)
	#enabled = (id: string, url: string, tabId: number) => {
		const loaded = this.#registry.get(id);
		return (
			!!loaded?.record.enabled && this.#registry.siteGranted(loaded, url, tabId)
		);
	};

	#dispatch(event: WebRequestListener['event'], details: WebRequestDetails) {
		return webRequests.dispatch(this.#channel, event, details, this.#enabled);
	}

	/** onBeforeRequest (blocking where permitted), told before the worker's DnrHost matches the request */
	async before(request: ExtensionRequest): Promise<BeforeVerdict> {
		const answer = await this.#dispatch(
			'onBeforeRequest',
			this.#details(request),
		);
		if (answer?.cancel) return { cancel: true, by: 'webRequest' };
		if (answer?.redirectUrl && answer.redirectUrl !== request.url)
			return { redirect: answer.redirectUrl, by: 'webRequest' };
		return null;
	}

	/**
	 * The headers as they go out (DnrHost changed them already; `dnr` holds
	 * the value before of each name it changed, null for one it added):
	 * onBeforeSendHeaders sees them as they were before DNR's changes and
	 * may cancel (null), then onSendHeaders is told what goes out. `internal`
	 * fields of the proxy's own stay as they were, unseen.
	 */
	async send(
		request: ExtensionRequest,
		headers: RawHeaders,
		internal: (name: string) => boolean,
		dnr?: ReadonlyMap<string, string | null>,
	): Promise<RawHeaders | null> {
		const own = headers.filter(([name]) => internal(name));
		let visible = headers.filter(([name]) => !internal(name));
		if (webRequests.any) {
			const shown = dnr?.size ? beforeDnr(visible, dnr) : visible;
			const answer = await this.#dispatch(
				'onBeforeSendHeaders',
				this.#details(request, { requestHeaders: toList(shown) }),
			);
			if (answer?.cancel) return null;
			if (answer?.requestHeaders)
				visible = dnr?.size
					? mergedWithDnr(visible, shown, fromList(answer.requestHeaders), dnr)
					: fromList(answer.requestHeaders);
			this.#dispatch(
				'onSendHeaders',
				this.#details(request, { requestHeaders: toList(visible) }),
			).catch(() => {});
		}
		return [...visible, ...own];
	}

	/** the response's head (after DnrHost's changes): onHeadersReceived (cancel, redirect, new headers) */
	async received(
		request: ExtensionRequest,
		status: number,
		statusText: string,
		headers: RawHeaders,
	): Promise<{
		cancel?: true;
		redirect?: string;
		headers?: RawHeaders;
	} | null> {
		let changed: RawHeaders | null = null;
		if (webRequests.any) {
			const answer: WebRequestVerdict | null = await this.#dispatch(
				'onHeadersReceived',
				this.#details(request, {
					statusCode: status,
					statusLine: `HTTP/1.1 ${status} ${statusText}`.trim(),
					responseHeaders: toList(changed ?? headers),
				}),
			);
			if (answer?.cancel) return { cancel: true };
			if (answer?.redirectUrl) return { redirect: answer.redirectUrl };
			if (answer?.responseHeaders) changed = fromList(answer.responseHeaders);
		}
		return changed ? { headers: changed } : null;
	}

	/** a request the log reports: onCompleted, or onErrorOccurred */
	logged(info: RequestInfo) {
		if (!webRequests.completes) return;
		let url: URL;
		try {
			url = new URL(info.url);
		} catch (error) {
			return;
		}
		if (extensionOfHost(url.hostname)) return;
		const client = info.client ?? '';
		const requestId =
			this.#ids.get(`${client}|${info.url}`) ?? `log${++requestIds}`;
		const request: ExtensionRequest = {
			requestId,
			url: info.url,
			method: info.method,
			type: webRequestType(info.destination, false, false),
			initiator: null,
			site: 'none',
			client,
		};
		const failed = info.error !== undefined && info.status === 0;
		this.#dispatch(
			failed ? 'onErrorOccurred' : 'onCompleted',
			this.#details(request, {
				...(failed
					? {
							error:
								info.kind === 'blocked'
									? 'net::ERR_BLOCKED_BY_CLIENT'
									: 'net::ERR_FAILED',
						}
					: { statusCode: info.status, fromCache: info.cached }),
			}),
		).catch(() => {});
	}
}
