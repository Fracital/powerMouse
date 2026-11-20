// What the request path (rewrites.ts) asks of the extensions, in one place:
// each step is a synchronous "no" while no extension has rules or listeners,
// so a scope without extensions pays a property read per request.
import type { RawHeaders } from '@mercuryworkshop/proxy-transports';
import { extensionOfHost } from '../../extensions/origin';
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
			initiator: init.initiator,
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

	#enabled = (id: string) => !!this.#registry.get(id)?.record.enabled;

	#dispatch(event: WebRequestListener['event'], details: WebRequestDetails) {
		return webRequests.dispatch(this.#channel, event, details, this.#enabled);
	}

	/** onBeforeRequest (blocking where permitted); the worker's DnrHost asked before */
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
	 * The headers as they go out (DnrHost changed them already):
	 * onBeforeSendHeaders (which may cancel: null), then onSendHeaders is told. `internal`
	 * fields of the proxy's own stay as they were, unseen.
	 */
	async send(
		request: ExtensionRequest,
		headers: RawHeaders,
		internal: (name: string) => boolean,
	): Promise<RawHeaders | null> {
		const own = headers.filter(([name]) => internal(name));
		let visible = headers.filter(([name]) => !internal(name));
		if (webRequests.any) {
			const answer = await this.#dispatch(
				'onBeforeSendHeaders',
				this.#details(request, { requestHeaders: toList(visible) }),
			);
			if (answer?.cancel) return null;
			if (answer?.requestHeaders) visible = fromList(answer.requestHeaders);
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
