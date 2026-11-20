// chrome.declarativeNetRequest in the service worker (docs/extensions-dnr.md):
// the extensions' rules, compiled and indexed here (src/extensions/dnr), on
// the requests the worker serves. Nothing of it reaches a page: the worker
// matches each request as it routes it, before the blocker's lists, the
// HTTP cache and the transport, and changes the request's headers as they
// go out and the response's as they come in, before the cookie jar and the
// rewriter see them.
//
// The frames the rules' allowAllRequests and topDomains read are the
// worker's clients: a document's frame is the client its navigation made
// (resultingClientId), a subresource's the client that asks (clientId).
// The worker does not see which document frames a nested one. The
// document that started the navigation says (NavigationHint, `startedBy`):
// a document that set a frame's src is its parent, and a frame that
// navigated itself keeps its parent. Without a word from one, a nested
// frame's parent is the latest document committed on the origin its
// navigation came from (the one that referred it), which is exact for one
// frame of a site per tab and approximate past it. Tab ids come from the
// extensions layer (`tabOf`, a tab's top document), a frame being in its
// parent's tab; a main frame's own request is in the tab the host sent it to
// (`hostNavigationTab`) or the tab of the document that started it, and its
// redirects' requests in the same one (they make the same client). A main
// frame that committed in no known tab is placed in its tab when its
// document reports (`placed`), and its matched rules go there. A socket's
// handshake is its document's (the controller names the client). A request
// no tab owns is -1, as in Chrome. Frame ids are the extensions layer's
// (`frameIdOf`), the ones its contexts know: 0 for a tab's top document,
// and a frame that navigated itself keeps its id.

import {
	compileStatic,
	DnrEngine,
	type DnrOutcome,
	type DnrRequest,
	type DnrRequestState,
	type EngineHooks,
	type ExtensionPermissions,
	type ExtensionState,
	type HeaderLines,
	type PageAccess,
	type ResourceType,
} from '../extensions/dnr';
import { displayExtensionOrigin } from '../extensions/origin';

/** one extension's rules, as the extensions layer hands them over */
export interface DnrExtension {
	id: string;
	/** larger is more recent; the more recent extension wins a tie */
	installTime?: number;
	/** where extensionPath redirects point (`https://<id>.invalid/`) */
	extensionBase?: string;
	/**
	 * the manifest's rule_resources, in order, each with its file: its text
	 * as the package holds it (parsed here, so a large ruleset crosses to
	 * the worker as one string), or the parsed JSON
	 */
	rulesets?: { id: string; enabled?: boolean; path?: string; rules: unknown }[];
	permissions?: ExtensionPermissions;
	/**
	 * the host permissions it holds (match patterns, `<all_urls>`); every
	 * host when absent. A redirect, and every action of an extension with
	 * declarativeNetRequestWithHostAccess alone, needs them
	 */
	hostPermissions?: string[];
	/** host permissions the user withheld (runtime host permissions) */
	withheldHostPermissions?: string[];
	/** what the engine persisted for it (persist) */
	state?: ExtensionState;
}

/** what the controller (or the extensions layer) asks of the worker's DNR */
export type DnrCommand =
	| { op: 'install'; extension: DnrExtension }
	| { op: 'uninstall'; id: string }
	| {
			op: 'call';
			id: string;
			/** a chrome.declarativeNetRequest function's name */
			method: string;
			args?: unknown[];
			/** the call came from a user gesture (getMatchedRules' quota) */
			userGesture?: boolean;
	  }
	| { op: 'stats'; reset?: boolean }
	| {
			op: 'bench';
			/** requests as the matcher takes them (a corpus) */
			requests: DnrRequest[];
			/** how many times each is matched, for a timer the worker coarsens (100 us) */
			repeat?: number;
	  };

/** the bench op's answer, in microseconds per request */
export interface DnrBench {
	requests: number;
	/** one pass over every request, timed whole: the true mean */
	mean: number;
	/** per request, each matched `repeat` times in a row (warm) */
	p50: number;
	p90: number;
	p99: number;
	max: number;
	/** how many came out blocked, redirected, allowed or with header changes */
	outcomes: Record<string, number>;
}

/** the stats op's answer: what matching costs here, per request */
export interface DnrStats {
	extensions: { id: string; beforeRequest: number; headersReceived: number }[];
	requests: number;
	lastInstall: { id: string; compileMs: number; indexMs: number } | null;
	/**
	 * microseconds a request's beforeRequest step took, over the last
	 * REQUEST_SAMPLES, by the worker's clock (which Chrome coarsens to 100 us
	 * outside cross-origin isolation: the bench op is the measurement)
	 */
	p50: number;
	p99: number;
	mean: number;
}

/** what the worker knows of a request as it routes it */
export interface DnrRequestInfo {
	/** the real URL */
	url: string;
	method: string;
	/** Request.destination ('' for fetch and XHR) */
	destination: string;
	navigation: boolean;
	/** a navigation of a top-level document (STomp's top frames are the host's iframes) */
	topLevel: boolean;
	/** the real URL of the document that makes the request, or refers the navigation; '' for none */
	source: string;
	/** a beacon or a hyperlink ping */
	ping?: boolean;
	clientId?: string;
	resultingClientId?: string;
	/**
	 * a navigation: the client of the document that told the worker it
	 * started it (NavigationHint), and whether it set a frame's src (it is
	 * then the frame's parent; otherwise the frame navigated itself)
	 */
	startedBy?: { client: string; frameSrc: boolean } | null;
}

/** a request between its stages */
export interface DnrFlow {
	state: DnrRequestState;
	info: DnrRequestInfo;
	frame: string | null;
	parent: string | null;
	/** the tab the request was matched in (-1 for none) */
	tabId: number;
}

const ALLOWED: PageAccess = 'allowed';
const REQUEST_SAMPLES = 4096;
/** the frames kept for allowAllRequests and topDomains; the oldest go first */
const MAX_FRAMES = 1024;

/** a request's DNR resource type from what the fetch event says (WebRequestResourceType) */
export function resourceTypeOf(info: DnrRequestInfo): ResourceType {
	if (info.navigation) return info.topLevel ? 'main_frame' : 'sub_frame';
	if (info.ping) return 'ping';
	switch (info.destination) {
		case 'document':
			return 'main_frame';
		case 'iframe':
		case 'frame':
		case 'fencedframe':
			return 'sub_frame';
		case 'script':
		case 'worker':
		case 'sharedworker':
		case 'serviceworker':
		case 'audioworklet':
		case 'paintworklet':
		case 'sharedstorageworklet':
			return 'script';
		case 'style':
		case 'xslt':
			return 'stylesheet';
		case 'image':
			return 'image';
		case 'font':
			return 'font';
		case 'audio':
		case 'video':
		case 'track':
			return 'media';
		case 'object':
		case 'embed':
			return 'object';
		case 'report':
			return 'csp_report';
		case 'webbundle':
			return 'webbundle';
		case 'websocket':
			return 'websocket';
		case 'webtransport':
			return 'webtransport';
		case '':
		case 'empty':
			return 'xmlhttprequest';
		default:
			return 'other';
	}
}

const originOf = (url: string): string | null => {
	try {
		const origin = new URL(url).origin;
		return origin === 'null' ? null : origin;
	} catch {
		return null;
	}
};

/** URLPattern::MatchesURL for a host permission's scheme and host (its path is ignored, as Chrome ignores it for hosts) */
export function hostPermissionMatches(pattern: string, url: URL): boolean {
	const web = /^(https?|wss?):$/.test(url.protocol);
	if (pattern === '<all_urls>')
		return web || url.protocol === 'ftp:' || url.protocol === 'file:';
	const parsed = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
	if (!parsed) return false;
	const [, scheme, host] = parsed;
	const protocol = url.protocol.slice(0, -1);
	// a web scheme's pattern covers its socket scheme (ws for http, wss for https)
	const effective =
		protocol === 'ws' ? 'http' : protocol === 'wss' ? 'https' : protocol;
	if (
		scheme === '*'
			? !/^https?$/.test(effective)
			: scheme.toLowerCase() !== effective
	)
		return false;
	const hostname = url.hostname.toLowerCase();
	const wanted = host.replace(/:\d+$/, '').toLowerCase();
	if (wanted === '*') return true;
	if (wanted.startsWith('*.')) {
		const base = wanted.slice(2);
		return hostname === base || hostname.endsWith(`.${base}`);
	}
	return hostname === wanted;
}

/** the hosts Chrome keeps from every extension (ExtensionsAPIClient::ShouldHideBrowserNetworkRequest, the Web Store) */
function hiddenFromExtensions(
	url: string,
	extensionBase: string | undefined,
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return true;
	}
	const host = parsed.hostname;
	if (host === 'chromewebstore.google.com') return true;
	if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
		return true;
	// another extension's package (an extension origin is `https://<id>.invalid`)
	if (
		host.endsWith('.invalid') &&
		!(extensionBase && url.startsWith(extensionBase))
	)
		return true;
	return false;
}

interface Frame {
	url: string;
	origin: string | null;
	/** the outermost frame's URL */
	top: string;
	/** the client of the document that frames it, null at the top */
	parent: string | null;
	/** the tab its navigation was matched in, -1 for none */
	tab: number;
	/** a tab's top document (frame id 0) */
	main: boolean;
}

/** the frames a tab id is looked for up the tree, at most */
const MAX_DEPTH = 32;

export class DnrHost {
	readonly engine: DnrEngine;
	private extensions = new Map<string, DnrExtension>();
	private frames = new Map<string, Frame>();
	/** the latest committed frame of each origin, for a nested navigation's parent */
	private latestByOrigin = new Map<string, string>();
	private samples = new Float64Array(REQUEST_SAMPLES);
	/** what the last install cost: compiling its rulesets, then indexing them */
	private lastInstall: DnrStats['lastInstall'] = null;
	private sampled = 0;
	/**
	 * the client of the document that frames a nested one, when the
	 * extensions layer knows its frame tree (given the nested document's
	 * client); otherwise the latest document of the origin that referred it
	 */
	parentOf: (clientId: string) => string | null | undefined = () => undefined;
	/** the tab a client belongs to (the extensions layer's tabs); -1 for none */
	tabOf: (clientId: string) => number = () => -1;
	/**
	 * the tab a top-level navigation the host started itself goes to (a
	 * frame's go(), the address bar), by the navigation's URL; -1 for none
	 */
	hostNavigationTab: (url: string) => number = () => -1;
	/**
	 * a nested document's frame id (the extensions layer keeps them, so its
	 * contexts and these requests agree), assigned on first ask; -1 without one
	 */
	frameIdOf: (clientId: string) => number = () => -1;
	/** a frame's next document (`next`) keeps the frame id of its last (`previous`) */
	sameFrame: (next: string, previous: string) => void = () => {};
	/** the document a dedicated worker belongs to (its requests are in that document's tab) */
	ownerOf: (clientId: string) => string | undefined = () => undefined;
	/** the tab of each top-level navigation in flight, by the client it makes: its redirects' requests are the same navigation's */
	private navigationTabs = new Map<string, number>();
	/** main frames that committed in no known tab, until the extensions layer places them */
	private unplaced = new Set<string>();
	/** the state the engine keeps for an extension changed: the extensions layer stores it */
	onPersist: ((extensionId: string, state: ExtensionState) => void) | null =
		null;
	/** onRuleMatchedDebug and the action badge, for the extensions layer */
	hooks: Pick<
		EngineHooks,
		'debug' | 'badge' | 'withheld' | 'validTab' | 'activeTabGranted'
	> = {};

	constructor() {
		this.engine = new DnrEngine({
			access: (id, request) => this.access(id, request),
			hidden: (id, request) =>
				hiddenFromExtensions(
					request.url,
					this.extensions.get(id)?.extensionBase,
				),
			persist: (id, state) => this.onPersist?.(id, state),
			debug: (id, info) => this.hooks.debug?.(id, info),
			badge: (id, tab, count) => this.hooks.badge?.(id, tab, count),
			withheld: (id, request) => this.hooks.withheld?.(id, request),
			validTab: (tab) => this.hooks.validTab?.(tab) ?? tab >= 0,
			activeTabGranted: (id, tab) =>
				this.hooks.activeTabGranted?.(id, tab) ?? false,
		});
	}

	/** any extension has rules: the request path asks nothing otherwise */
	get active(): boolean {
		return this.engine.active;
	}

	private access(extensionId: string, request: DnrRequest): PageAccess {
		const extension = this.extensions.get(extensionId);
		if (!extension?.hostPermissions) return ALLOWED;
		const can = (
			url: string | null | undefined,
			patterns: string[] | undefined,
		) => {
			if (!url || !patterns) return false;
			try {
				const parsed = new URL(url);
				return patterns.some((pattern) =>
					hostPermissionMatches(pattern, parsed),
				);
			} catch {
				return false;
			}
		};
		const check = (patterns: string[] | undefined) =>
			can(request.url, patterns) &&
			// the initiator too, for a request a document makes (kRequireHostPermissionsForURLAndInitiator)
			(!request.initiator ||
				request.initiator === 'null' ||
				request.type === 'main_frame' ||
				// (the extension's own pages need no permission for themselves)
				request.initiator === `chrome-extension://${extensionId}` ||
				can(request.initiator, patterns));
		if (check(extension.hostPermissions)) return ALLOWED;
		if (
			extension.withheldHostPermissions &&
			check(extension.withheldHostPermissions)
		)
			return 'withheld';
		return 'denied';
	}

	/** install or replace an extension's rules; returns the warnings Chrome would show (an error first, when the install fails) */
	install(extension: DnrExtension): string[] {
		const base =
			extension.extensionBase ?? `chrome-extension://${extension.id}/`;
		const warnings: string[] = [];
		const started = performance.now();
		const staticRulesets = (extension.rulesets ?? []).map((source, index) => {
			let rules = source.rules;
			if (typeof rules === 'string')
				try {
					rules = JSON.parse(rules);
				} catch {
					// (compileStatic words the error as Chrome does a file that is not a list)
					rules = null;
				}
			const result = compileStatic(rules, {
				extensionBase: base,
				path: source.path ?? `${source.id}.json`,
				rulesetId: index + 1,
			});
			if (result.error) warnings.unshift(result.error);
			warnings.push(...result.warnings);
			return {
				id: source.id,
				enabled: source.enabled ?? true,
				ruleset: result.ruleset,
			};
		});
		const compiled = performance.now();
		this.engine.uninstall(extension.id);
		this.extensions.set(extension.id, {
			...extension,
			rulesets: undefined,
			extensionBase: base,
		});
		let installed: string[];
		try {
			installed = this.engine.install({
				id: extension.id,
				installTime: extension.installTime ?? Date.now(),
				extensionBase: base,
				staticRulesets,
				permissions: extension.permissions ?? { declarativeNetRequest: true },
				state: extension.state,
			});
		} catch (error) {
			// a manifest error: the extension does not install
			this.extensions.delete(extension.id);
			return [(error as Error).message];
		}
		warnings.push(
			...installed,
			...(this.engine.runtimeWarnings.get(extension.id) ?? []),
		);
		// indexed now, not by the first request that meets the rules
		this.engine.matcherOf(extension.id)?.prepare();
		this.lastInstall = {
			id: extension.id,
			compileMs: Math.round(compiled - started),
			indexMs: Math.round(performance.now() - compiled),
		};
		return warnings;
	}

	uninstall(id: string) {
		this.extensions.delete(id);
		this.engine.uninstall(id);
	}

	/** the controller's `dnr` RPC */
	async command(command: DnrCommand): Promise<unknown> {
		switch (command.op) {
			case 'install':
				return this.install(command.extension);
			case 'uninstall':
				this.uninstall(command.id);
				return null;
			case 'call': {
				const result = await this.call(
					command.id,
					command.method,
					command.args ?? [],
					!!command.userGesture,
				);
				this.engine.matcherOf(command.id)?.prepare();
				return result;
			}
			case 'stats':
				return this.stats(!!command.reset);
			case 'bench':
				return this.bench(command.requests, command.repeat ?? 32);
		}
	}

	/** what matching costs here, over a corpus of requests (the measurements of docs/extensions-dnr.md) */
	bench(requests: DnrRequest[], repeat: number): DnrBench {
		const engine = this.engine;
		const outcomes: Record<string, number> = {};
		let start = performance.now();
		for (const request of requests) {
			const { state } = engine.beforeRequest(request);
			const key = state.actions[0]?.type ?? 'none';
			outcomes[key] = (outcomes[key] ?? 0) + 1;
		}
		const mean =
			((performance.now() - start) * 1000) / Math.max(1, requests.length);
		const each = new Float64Array(requests.length);
		requests.forEach((request, at) => {
			start = performance.now();
			for (let i = 0; i < repeat; i++) engine.beforeRequest(request);
			each[at] = ((performance.now() - start) * 1000) / repeat;
		});
		each.sort();
		const q = (fraction: number) =>
			each.length
				? +each[
						Math.min(each.length - 1, Math.floor(fraction * each.length))
					].toFixed(2)
				: 0;
		// (the tracker kept what the corpus matched: no extension asked for it)
		for (const id of this.extensions.keys()) engine.tracker.clearExtension(id);
		return {
			requests: requests.length,
			mean: +mean.toFixed(2),
			p50: q(0.5),
			p90: q(0.9),
			p99: q(0.99),
			max: q(1),
			outcomes,
		};
	}

	/** a chrome.declarativeNetRequest call of an extension; rejects with Chrome's message */
	call(
		id: string,
		method: string,
		args: unknown[],
		userGesture = false,
	): Promise<unknown> {
		const engine = this.engine;
		const [first, second] = args as [never, never];
		switch (method) {
			case 'updateDynamicRules':
				return engine.updateDynamicRules(id, first);
			case 'getDynamicRules':
				return engine.getDynamicRules(id, first);
			case 'updateSessionRules':
				return engine.updateSessionRules(id, first);
			case 'getSessionRules':
				return engine.getSessionRules(id, first);
			case 'getEnabledRulesets':
				return engine.getEnabledRulesets(id);
			case 'updateEnabledRulesets':
				return engine.updateEnabledRulesets(id, first);
			case 'updateStaticRules':
				return engine.updateStaticRules(id, first);
			case 'getDisabledRuleIds':
				return engine.getDisabledRuleIds(id, first);
			case 'getAvailableStaticRuleCount':
				return engine.getAvailableStaticRuleCount(id);
			case 'getMatchedRules':
				return engine.getMatchedRules(id, first, userGesture);
			case 'setExtensionActionOptions':
				return engine.setExtensionActionOptions(id, first);
			case 'isRegexSupported':
				return engine.isRegexSupported(first);
			case 'testMatchOutcome':
				return engine.testMatchOutcome(id, first);
			default:
				void second;
				return Promise.reject(
					new Error(`declarativeNetRequest.${method} is not a function`),
				);
		}
	}

	stats(reset: boolean): DnrStats {
		const count = Math.min(this.sampled, REQUEST_SAMPLES);
		const sorted = Float64Array.from(this.samples.subarray(0, count)).sort();
		const at = (q: number) =>
			count ? sorted[Math.min(count - 1, Math.floor(q * count))] : 0;
		const out: DnrStats = {
			extensions: [...this.extensions.keys()].map((id) => ({
				id,
				...(this.engine.matcherOf(id)?.counts() ?? {
					beforeRequest: 0,
					headersReceived: 0,
				}),
			})),
			lastInstall: this.lastInstall,
			requests: this.sampled,
			p50: +at(0.5).toFixed(2),
			p99: +at(0.99).toFixed(2),
			mean: count ? +(sorted.reduce((a, b) => a + b, 0) / count).toFixed(2) : 0,
		};
		if (reset) this.sampled = 0;
		return out;
	}

	private remember(key: string, frame: Frame) {
		this.frames.delete(key);
		this.frames.set(key, frame);
		if (frame.origin) this.latestByOrigin.set(frame.origin, key);
		while (this.frames.size > MAX_FRAMES) {
			const [oldest, gone] = this.frames.entries().next().value!;
			this.frames.delete(oldest);
			if (gone.origin && this.latestByOrigin.get(gone.origin) === oldest)
				this.latestByOrigin.delete(gone.origin);
			this.engine.onFrameRemoved(oldest);
		}
	}

	/**
	 * The extensions layer placed a client in a tab. A main frame that
	 * committed in no known tab (a navigation no hooked document announced)
	 * is that tab's now: its matched rules and the badge count go to it
	 */
	placed(clientId: string, tabId: number) {
		if (tabId < 0 || !this.unplaced.delete(clientId)) return;
		const frame = this.frames.get(clientId);
		if (frame) frame.tab = tabId;
		this.engine.onMainFramePlaced(tabId, clientId);
	}

	/**
	 * A frame's next document (its window reported it) after `previous`:
	 * the frame's parent, top and tab stay the frame's, whatever its
	 * navigation was matched under (a src set with no word from the parent
	 * in time falls back to the latest document of the referring origin)
	 */
	linked(next: string, previous: string) {
		const frame = this.frames.get(next);
		const before = this.frames.get(previous);
		if (!frame || !before || frame.main || before.main || !before.parent)
			return;
		frame.parent = before.parent;
		frame.top = before.top;
		if (before.tab >= 0) frame.tab = before.tab;
	}

	/** a client the controller says is gone */
	forgetClient(clientId: string) {
		const frame = this.frames.get(clientId);
		if (!frame) return;
		this.frames.delete(clientId);
		if (frame.origin && this.latestByOrigin.get(frame.origin) === clientId)
			this.latestByOrigin.delete(frame.origin);
		this.engine.onFrameRemoved(clientId);
	}

	/** onBeforeRequest's step: null when no extension has rules */
	beforeRequest(
		info: DnrRequestInfo,
	): { flow: DnrFlow; outcome: DnrOutcome } | null {
		if (!this.engine.active) return null;
		const start = performance.now();
		const sourceOrigin = info.source ? originOf(info.source) : null;
		let frame: string | null = null;
		let parent: string | null = null;
		let topUrl: string | null = null;
		let tabId = -1;
		// (a dedicated worker's requests are its document's, as Chrome
		// matches them in the frame that owns the worker)
		const requester =
			info.navigation || !info.clientId || this.frames.has(info.clientId)
				? info.clientId
				: (this.ownerOf(info.clientId) ?? info.clientId);
		if (info.navigation) {
			// a navigation is matched in its parent's frame (a main frame's in none)
			if (!info.topLevel) {
				const known = info.resultingClientId
					? this.parentOf(info.resultingClientId)
					: undefined;
				parent =
					known !== undefined
						? known
						: (this.parentFromStarter(info.startedBy) ??
							(sourceOrigin
								? (this.latestByOrigin.get(sourceOrigin) ?? null)
								: null));
				frame = parent;
				topUrl = parent ? (this.frames.get(parent)?.top ?? null) : null;
				// a frame's document is in its parent's tab
				tabId = this.tabFor(parent);
			} else {
				// a main frame's own request is its tab's: the one the host sent
				// it to, else the tab of the document that started it
				tabId = this.hostNavigationTab(info.url);
				if (tabId < 0) tabId = this.tabFor(info.startedBy?.client);
				// a redirect's next request makes the same client
				const reserved = info.resultingClientId;
				if (reserved && tabId < 0)
					tabId = this.navigationTabs.get(reserved) ?? -1;
				else if (reserved) {
					this.navigationTabs.set(reserved, tabId);
					if (this.navigationTabs.size > 256)
						this.navigationTabs.delete(
							this.navigationTabs.keys().next().value!,
						);
				}
			}
		} else if (requester && this.frames.has(requester)) {
			frame = requester;
			topUrl = this.frames.get(frame)!.top;
		}
		if (!info.navigation) tabId = this.tabFor(info.clientId);
		// frame ids: a tab's top document is 0 (a nested one's id is the
		// extensions layer's, which the worker does not keep)
		const { frameId, parentFrameId } = this.frameIdsOf(info, parent, requester);
		const request: DnrRequest = {
			url: info.url,
			// an extension's page asks from chrome-extension://, as in Chrome
			initiator: sourceOrigin && displayExtensionOrigin(sourceOrigin),
			type: resourceTypeOf(info),
			method: info.method,
			tabId,
			// a main frame of no known tab: its matches are held for its document
			...(info.navigation &&
			info.topLevel &&
			tabId < 0 &&
			info.resultingClientId
				? { held: info.resultingClientId }
				: {}),
			topUrl:
				info.navigation && info.topLevel
					? info.url
					: (topUrl ?? info.source ?? null),
			frame,
			frameId,
			parentFrameId,
		};
		const { state, outcome } = this.engine.beforeRequest(request);
		this.samples[this.sampled++ % REQUEST_SAMPLES] =
			(performance.now() - start) * 1000;
		return { flow: { state, info, frame, parent, tabId }, outcome };
	}

	/**
	 * The tab a client is in: the extensions layer's, else the one its frame's
	 * navigation was matched in, else its parent's, up the tree
	 */
	private tabFor(client: string | null | undefined): number {
		for (let at = client, depth = 0; at && depth < MAX_DEPTH; depth++) {
			const tab = this.tabOf(at);
			if (tab >= 0) return tab;
			const frame = this.frames.get(at);
			if (frame && frame.tab >= 0) return frame.tab;
			// (a client of no frame: a dedicated worker is its document's)
			at = frame ? frame.parent : this.ownerOf(at);
		}
		return -1;
	}

	/** a request's frameId and parentFrameId */
	private frameIdsOf(
		info: DnrRequestInfo,
		parent: string | null,
		requester: string | undefined,
	): { frameId: number; parentFrameId: number } {
		if (info.navigation && info.topLevel)
			return { frameId: 0, parentFrameId: -1 };
		if (info.navigation) {
			// the frame's document to be: a frame that navigated itself keeps its id
			const next = info.resultingClientId;
			const starter = info.startedBy;
			if (next && starter && !starter.frameSrc)
				this.sameFrame(next, starter.client);
			return {
				frameId: next ? this.frameIdOf(next) : -1,
				parentFrameId: this.idOf(parent),
			};
		}
		const frame = requester ? this.frames.get(requester) : undefined;
		return {
			frameId: this.idOf(requester),
			parentFrameId: frame && !frame.main ? this.idOf(frame.parent) : -1,
		};
	}

	/** a document's frame id: 0 for a tab's top document, -1 for one the worker never saw */
	private idOf(client: string | null | undefined): number {
		if (!client) return -1;
		const frame = this.frames.get(client);
		if (frame?.main || (!frame && this.tabOf(client) >= 0)) return 0;
		return frame ? this.frameIdOf(client) : -1;
	}

	/**
	 * A nested navigation's parent, from the document that told the worker it
	 * started it: that document when it set the frame's src, the parent of
	 * its own frame when the frame navigated itself; null when neither is known
	 */
	private parentFromStarter(
		startedBy: DnrRequestInfo['startedBy'],
	): string | null {
		if (!startedBy) return null;
		if (startedBy.frameSrc) return startedBy.client;
		return this.frames.get(startedBy.client)?.parent ?? null;
	}

	/**
	 * A WebSocket's or WebTransport session's handshake (the controller
	 * asks: a socket never passes the worker): whether the rules block it. A
	 * redirect of a socket is no action in Chrome (CreateRedirectAction).
	 * `clientId`: the document that opens it, whose frame and tab it is in
	 */
	socketBlocked(
		url: string,
		source: string,
		type?: 'webtransport',
		clientId?: string,
	): DnrOutcome | null {
		const step = this.beforeRequest({
			url,
			method: type ? 'CONNECT' : 'GET',
			destination: type ?? 'websocket',
			navigation: false,
			topLevel: false,
			source,
			...(clientId ? { clientId } : {}),
		});
		if (!step) return null;
		const { type: kind } = step.outcome;
		return kind === 'block' || kind === 'collapse' ? step.outcome : null;
	}

	/** onBeforeSendHeaders' step, on the headers as they go out; true when one changed */
	sendHeaders(flow: DnrFlow, headers: Headers): boolean {
		return this.engine.beforeSendHeaders(flow.state, headers).length > 0;
	}

	/**
	 * onHeadersReceived's step, on the response's header lines (its
	 * Set-Cookie lines among them). `lines` is what the response goes on
	 * with, when a rule changed it
	 */
	receiveHeaders(
		flow: DnrFlow,
		lines: HeaderLines,
	): { outcome: DnrOutcome; lines: HeaderLines | null } {
		return this.engine.headersReceived(flow.state, lines);
	}

	/** a navigation's document is served: its frame commits (OnDidFinishNavigation) */
	committed(flow: DnrFlow, lines: HeaderLines | null, errorPage = false) {
		const { info } = flow;
		const key = info.resultingClientId;
		if (!info.navigation || !key) return;
		const origin = originOf(info.url);
		const parentFrame = flow.parent ? this.frames.get(flow.parent) : undefined;
		const top = info.topLevel
			? info.url
			: (parentFrame?.top ?? info.source ?? info.url);
		const parent = info.topLevel ? null : flow.parent;
		if (info.topLevel) {
			this.navigationTabs.delete(key);
			// its tab comes with the document's report (placed)
			if (flow.tabId < 0) {
				this.unplaced.add(key);
				if (this.unplaced.size > 64) {
					const dropped = this.unplaced.keys().next().value!;
					this.unplaced.delete(dropped);
					this.engine.onHeldDropped(dropped);
				}
			}
		}
		this.remember(key, {
			url: info.url,
			origin,
			top,
			parent,
			tab: flow.tabId,
			main: info.topLevel,
		});
		this.engine.onNavigationCommitted({
			frame: key,
			parent,
			url: info.url,
			origin: origin ?? 'null',
			parentOrigin: info.topLevel
				? null
				: (parentFrame?.origin ?? originOf(info.source)),
			topOrigin: originOf(top),
			isPost: info.method.toUpperCase() === 'POST',
			errorPage,
			tabId: this.tabFor(key),
			responseHeaders: lines,
		});
	}
}

/** a response's header lines: its fields, and the Set-Cookie lines a Response cannot hold */
export function headerLinesOf(
	headers: Headers,
	raw?: [string, string][],
): HeaderLines {
	const lines: HeaderLines = [];
	for (const [name, value] of headers)
		if (name !== 'set-cookie') lines.push([name, value]);
	for (const [name, value] of raw ?? [])
		if (name.toLowerCase() === 'set-cookie') lines.push(['set-cookie', value]);
	return lines;
}

/** the fields and the Set-Cookie lines back out of header lines */
export function splitHeaderLines(lines: HeaderLines): {
	headers: Headers;
	cookies: [string, string][];
} {
	const headers = new Headers();
	const cookies: [string, string][] = [];
	for (const [name, value] of lines) {
		if (name.toLowerCase() === 'set-cookie') cookies.push([name, value]);
		else headers.append(name, value);
	}
	return { headers, cookies };
}
