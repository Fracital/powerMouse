// The declarativeNetRequest engine of a STomp profile: every installed
// extension's rulesets and Chrome's API over them (rules_monitor_service.cc,
// declarative_net_request_api.cc, global_rules_tracker.cc), and the request
// path the service worker runs (ruleset_manager.cc and the web request event
// router's DNR steps): before the request, its headers going out, its
// response headers coming in, and the frames that commit. All of it in the
// service worker; nothing of it in a page.

import {
	applyRequestHeaders,
	applyResponseHeaders,
	type HeaderLines,
	type HeaderList,
	type HeaderOps,
} from './actions';
import {
	compileUpdate,
	type CompiledRuleset,
	type DynamicLimits,
} from './compile';
import { LIMIT_MESSAGES } from './errors';
import { isValidHeaderName } from './indexRule';
import {
	ExtensionMatcher,
	isAllow,
	isThirdParty,
	Params,
	parseOrigin,
	STAGE_BEFORE_REQUEST,
	STAGE_HEADERS_RECEIVED,
	topHostOf,
	type LoadedRuleset,
	type PageAccess,
	type Stage,
} from './match';
import { compileRE2 } from './re2';
import {
	ActionTracker,
	type MatchedRuleInfo,
	type MatchedRuleInfoDebug,
} from './tracker';
import {
	DYNAMIC_RULESET_ID,
	GETMATCHEDRULES_QUOTA_INTERVAL,
	GUARANTEED_MINIMUM_STATIC_RULES,
	MAX_DISABLED_STATIC_RULES,
	MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL,
	MAX_NUMBER_OF_DYNAMIC_RULES,
	MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
	MAX_NUMBER_OF_REGEX_RULES,
	MAX_NUMBER_OF_SESSION_RULES,
	MAX_NUMBER_OF_STATIC_RULESETS,
	MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
	MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
	MAX_STATIC_RULES_PER_PROFILE,
	SESSION_RULESET_ID,
	TAB_ID_NONE,
	type DnrAction,
	type DnrRequest,
	type MatchedRule,
	type RequestMethod,
	type ResourceType,
	type Rule,
	type UnsupportedRegexReason,
} from './types';

export interface StaticRulesetInfo {
	/** the manifest's id */
	id: string;
	/** enabled by default (the manifest's `enabled`) */
	enabled: boolean;
	/** compileStatic's ruleset; null for one that failed to load */
	ruleset: CompiledRuleset | null;
}

export interface ExtensionPermissions {
	/** declarativeNetRequest; without it (declarativeNetRequestWithHostAccess alone) every action needs host access */
	declarativeNetRequest?: boolean;
	declarativeNetRequestFeedback?: boolean;
	activeTab?: boolean;
}

/** what an extension's install leaves the engine, and what it keeps across restarts */
export interface ExtensionState {
	/** the enabled static rulesets, when the extension changed them */
	enabledRulesets?: string[];
	/** updateStaticRules' disabled ids, by ruleset */
	disabledRuleIds?: Record<string, number[]>;
	/** the dynamic rules, as given */
	dynamicRules?: Rule[];
	useActionCountAsBadgeText?: boolean;
}

export interface ExtensionInfo {
	id: string;
	/** larger is more recent; the more recent extension wins a tie between extensions */
	installTime?: number;
	/** chrome-extension://<id>/ or where STomp serves the package; extensionPath redirects resolve against it */
	extensionBase?: string;
	staticRulesets?: StaticRulesetInfo[];
	permissions?: ExtensionPermissions;
	state?: ExtensionState;
}

export interface EngineHooks {
	/**
	 * WebRequestPermissions::CanExtensionAccessURL with the host permission
	 * check for the URL and the initiator: 'denied' for a request the
	 * extension may never see (it is not evaluated when every action needs
	 * host access), 'withheld' for a host it may ask for
	 */
	access?: (extensionId: string, request: DnrRequest) => PageAccess;
	/** a request the extension may not see at all, whatever its permissions (DO_NOT_CHECK_HOST) */
	hidden?: (extensionId: string, request: DnrRequest) => boolean;
	/** onRuleMatchedDebug, when the extension listens */
	debug?: (extensionId: string, info: MatchedRuleInfoDebug) => void;
	/** an extension's access to the request was withheld and an action dropped */
	withheld?: (extensionId: string, request: DnrRequest) => void;
	validTab?: (tabId: number) => boolean;
	/** activeTab granted for the tab */
	activeTabGranted?: (extensionId: string, tabId: number) => boolean;
	badge?: (extensionId: string, tabId: number, count: number) => void;
	/** the state to keep for the extension changed */
	persist?: (extensionId: string, state: ExtensionState) => void;
	/** a response header kept from extensions (ShouldHideResponseHeader) */
	hideResponseHeader?: (url: string, header: string) => boolean;
	now?: () => number;
	/** "Allow access to file URLs" for the extension (off unless granted) */
	fileAccess?: (extensionId: string) => boolean;
	/** Chromium main's restriction of header value matching to host access (off, as in Chrome 157) */
	restrictHeaderValueMatching?: boolean;
}

/** what the request path decided at one stage */
export interface DnrOutcome {
	/** 'block' is ERR_BLOCKED_BY_CLIENT; 'collapse' the same, the element collapsed */
	type: 'none' | 'block' | 'collapse' | 'redirect';
	redirectUrl?: string;
	/** the action that decided it */
	action?: DnrAction;
}

/** a request between its stages (WebRequestInfo's dnr_actions and allow cache) */
export interface DnrRequestState {
	request: DnrRequest;
	params: Params;
	/** the actions in force: one block, redirect or allow, or the modifyHeaders ones */
	actions: DnrAction[];
	/** the request header operations DNR made, for webRequest's conflicts */
	requestHeaderOps?: HeaderOps;
	responseHeaderOps?: HeaderOps;
}

export interface TestMatchRequestDetails {
	url: string;
	initiator?: string;
	method?: RequestMethod;
	type: ResourceType;
	tabId?: number;
	topUrl?: string;
	responseHeaders?: Record<string, string[]>;
}

export interface CommitInfo {
	/** the frame's key: the same `frame` its requests carry */
	frame: string;
	/** the parent frame's key; null for a main frame */
	parent: string | null;
	/** the committed document URL */
	url: string;
	/** the committed origin; the URL's when absent ('null' for an opaque one) */
	origin?: string;
	/** the parent document's origin */
	parentOrigin?: string | null;
	/** the outermost frame's committed origin */
	topOrigin?: string | null;
	isPost?: boolean;
	errorPage?: boolean;
	tabId?: number;
	responseHeaders?: HeaderLines | null;
}

interface Installed {
	info: ExtensionInfo;
	matcher: ExtensionMatcher;
	base: string;
	enabled: Set<string>;
	disabled: Map<string, Set<number>>;
	dynamic: { source: Rule[]; ruleset: CompiledRuleset | null };
	session: { source: Rule[]; ruleset: CompiledRuleset | null };
	badge: boolean;
	matchedRuleCalls: number[];
}

const DEFAULT_ACCESS: PageAccess = 'allowed';

/**
 * URLs no extension's rules see: its own and other extensions' resources
 * (ShouldEvaluateRequest) and the browser's pages, restricted to every
 * extension (PermissionsData::IsRestrictedUrl, WebUI hidden by HideRequest)
 */
const HIDDEN_SCHEMES = new Set([
	'chrome-extension:',
	'chrome:',
	'chrome-untrusted:',
	'chrome-search:',
	'devtools:',
]);

export class DnrEngine {
	private extensions = new Map<string, Installed>();
	private sorted: Installed[] = [];
	private allocations = new Map<string, number>();
	readonly tracker: ActionTracker;
	/** install warnings and errors of the last install, by extension */
	readonly installWarnings = new Map<string, string[]>();
	/** the warnings Chrome shows for a loaded extension (a ruleset left out for the global limit), by extension */
	readonly runtimeWarnings = new Map<string, string[]>();

	constructor(private hooks: EngineHooks = {}) {
		this.tracker = new ActionTracker({
			now: hooks.now,
			canRecord: (extensionId, tabId) => {
				const installed = this.extensions.get(extensionId);
				const permissions = installed?.info.permissions ?? {};
				return (
					!!permissions.declarativeNetRequestFeedback ||
					(tabId !== TAB_ID_NONE && !!permissions.activeTab)
				);
			},
			debug: hooks.debug,
			validTab: hooks.validTab,
			badge: hooks.badge,
			useBadge: (extensionId) => !!this.extensions.get(extensionId)?.badge,
		});
	}

	private now() {
		return this.hooks.now?.() ?? Date.now();
	}

	private resort() {
		// ExtensionRulesetData::operator<: descending install time, then id
		this.sorted = [...this.extensions.values()].sort((a, b) => {
			const ta = a.info.installTime ?? 0;
			const tb = b.info.installTime ?? 0;
			if (ta !== tb) return tb - ta;
			return a.info.id < b.info.id ? 1 : a.info.id > b.info.id ? -1 : 0;
		});
	}

	// --- the global static rule pool (GlobalRulesTracker) ---

	private availableAllocation(extensionId: string) {
		let used = 0;
		for (const [id, allocation] of this.allocations)
			if (id !== extensionId) used += allocation;
		return MAX_STATIC_RULES_PER_PROFILE - used;
	}

	private updateAllocation(extensionId: string, enabledRules: number): boolean {
		const needed = Math.max(0, enabledRules - GUARANTEED_MINIMUM_STATIC_RULES);
		if (needed > this.availableAllocation(extensionId)) return false;
		if (needed) this.allocations.set(extensionId, needed);
		else this.allocations.delete(extensionId);
		return true;
	}

	private rulesetsOf(installed: Installed) {
		return installed.info.staticRulesets ?? [];
	}

	private loadedStatic(installed: Installed, id: string): LoadedRuleset | null {
		const list = this.rulesetsOf(installed);
		const at = list.findIndex((ruleset) => ruleset.id === id);
		const ruleset = list[at]?.ruleset;
		if (!ruleset) return null;
		return {
			id,
			rank: at + 1,
			rules: ruleset.rules,
			disabled: installed.disabled.get(id),
		};
	}

	private persist(installed: Installed) {
		this.hooks.persist?.(installed.info.id, {
			enabledRulesets: [...installed.enabled],
			disabledRuleIds: Object.fromEntries(
				[...installed.disabled].map(([id, set]) => [
					id,
					[...set].sort((a, b) => a - b),
				]),
			),
			dynamicRules: installed.dynamic.source,
			useActionCountAsBadgeText: installed.badge,
		});
	}

	/**
	 * Install (or load at start) an extension's rules: OnInitialRulesetsLoadedFromDisk.
	 * Returns the warnings Chrome would show
	 */
	install(info: ExtensionInfo): string[] {
		const statics = info.staticRulesets ?? [];
		// the manifest's own limits fail the install (DNRManifestHandler)
		const key =
			"Invalid value for key 'declarative_net_request.rule_resources'";
		if (statics.length > MAX_NUMBER_OF_STATIC_RULESETS)
			throw new Error(
				`${key}: The number of rulesets must be less than or equal to ${MAX_NUMBER_OF_STATIC_RULESETS}.`,
			);
		const byDefault = statics.filter((ruleset) => ruleset.enabled);
		if (byDefault.length > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS)
			throw new Error(
				`${key}: The number of enabled rulesets must be less than or equal to ${MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}.`,
			);
		this.uninstall(info.id);
		const warnings: string[] = [];
		// InstallIndexHelper: the enabled rulesets' regex rules over the limit warn
		if (
			byDefault.reduce(
				(count, ruleset) => count + (ruleset.ruleset?.regexCount ?? 0),
				0,
			) > MAX_NUMBER_OF_REGEX_RULES
		)
			warnings.push(LIMIT_MESSAGES.enabledRegexRuleCountExceeded);
		const base = info.extensionBase ?? `chrome-extension://${info.id}/`;
		const state = info.state ?? {};
		const installed: Installed = {
			info,
			matcher: new ExtensionMatcher(info.id, info.installTime ?? 0, {
				hostAccessAlwaysRequired:
					info.permissions?.declarativeNetRequest === false,
				restrictHeaderValueMatching: this.hooks.restrictHeaderValueMatching,
			}),
			base,
			enabled: new Set(
				state.enabledRulesets ??
					statics
						.filter((ruleset) => ruleset.enabled)
						.map((ruleset) => ruleset.id),
			),
			disabled: new Map(
				Object.entries(state.disabledRuleIds ?? {}).map(([id, ids]) => [
					id,
					new Set(ids),
				]),
			),
			dynamic: { source: [], ruleset: null },
			session: { source: [], ruleset: null },
			badge: !!state.useActionCountAsBadgeText,
			matchedRuleCalls: [],
		};
		if (state.dynamicRules?.length) {
			const result = compileUpdate(
				[],
				[],
				state.dynamicRules,
				this.dynamicLimits(installed),
				{
					extensionBase: base,
				},
			);
			if (result.ruleset)
				installed.dynamic = { source: result.source!, ruleset: result.ruleset };
		}
		const loaded: LoadedRuleset[] = [];
		if (installed.dynamic.ruleset)
			loaded.push({
				id: DYNAMIC_RULESET_ID,
				rank: 0,
				rules: installed.dynamic.ruleset.rules,
			});
		let rules = 0;
		let regex = 0;
		let exceeded = false;
		const limit =
			this.availableAllocation(info.id) + GUARANTEED_MINIMUM_STATIC_RULES;
		const actuallyEnabled = new Set<string>();
		for (const ruleset of statics) {
			if (!installed.enabled.has(ruleset.id) || !ruleset.ruleset) continue;
			const next = rules + ruleset.ruleset.ruleCount;
			if (next > limit) {
				exceeded = true;
				continue;
			}
			if (regex + ruleset.ruleset.regexCount > MAX_NUMBER_OF_REGEX_RULES)
				continue;
			rules = next;
			regex += ruleset.ruleset.regexCount;
			actuallyEnabled.add(ruleset.id);
			loaded.push(this.loadedStatic(installed, ruleset.id)!);
		}
		// (not an install warning: the extension's warning on chrome://extensions, Warning::kEnabledRuleCountExceeded)
		this.runtimeWarnings.set(
			info.id,
			exceeded ? [LIMIT_MESSAGES.enabledRuleCountExceeded] : [],
		);
		this.updateAllocation(info.id, rules);
		installed.matcher.addOrUpdate(loaded);
		this.extensions.set(info.id, installed);
		this.resort();
		this.installWarnings.set(info.id, warnings);
		return warnings;
	}

	uninstall(extensionId: string) {
		if (!this.extensions.delete(extensionId)) return;
		this.allocations.delete(extensionId);
		this.tracker.clearExtension(extensionId);
		this.resort();
	}

	private get(extensionId: string): Installed {
		const installed = this.extensions.get(extensionId);
		if (!installed)
			throw new Error(
				`No extension ${extensionId} has declarativeNetRequest rules`,
			);
		return installed;
	}

	// --- chrome.declarativeNetRequest ---

	private regexCount(ruleset: CompiledRuleset | null) {
		return ruleset?.regexCount ?? 0;
	}

	private dynamicLimits(installed: Installed): DynamicLimits {
		return {
			rules: MAX_NUMBER_OF_DYNAMIC_RULES,
			unsafe: MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
			regex:
				MAX_NUMBER_OF_REGEX_RULES - this.regexCount(installed.session.ruleset),
			messages: {
				rules: LIMIT_MESSAGES.dynamicRuleCount,
				unsafe: LIMIT_MESSAGES.dynamicUnsafeRuleCount,
				regex: LIMIT_MESSAGES.dynamicRegexRuleCount,
			},
		};
	}

	private sessionLimits(installed: Installed): DynamicLimits {
		return {
			rules: MAX_NUMBER_OF_SESSION_RULES,
			unsafe: MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
			regex:
				MAX_NUMBER_OF_REGEX_RULES - this.regexCount(installed.dynamic.ruleset),
			messages: {
				rules: LIMIT_MESSAGES.sessionRuleCount,
				unsafe: LIMIT_MESSAGES.sessionUnsafeRuleCount,
				regex: LIMIT_MESSAGES.sessionRegexRuleCount,
			},
		};
	}

	/** updateDynamicRules: resolves, or rejects with Chrome's message */
	async updateDynamicRules(
		extensionId: string,
		options: { removeRuleIds?: number[]; addRules?: unknown[] } = {},
	): Promise<void> {
		const installed = this.get(extensionId);
		const result = compileUpdate(
			installed.dynamic.source,
			options.removeRuleIds,
			options.addRules,
			this.dynamicLimits(installed),
			{ extensionBase: installed.base },
		);
		if (result.error !== undefined) throw new Error(result.error);
		installed.dynamic = { source: result.source!, ruleset: result.ruleset! };
		installed.matcher.addOrUpdate([
			{ id: DYNAMIC_RULESET_ID, rank: 0, rules: result.ruleset!.rules },
		]);
		this.persist(installed);
	}

	async getDynamicRules(
		extensionId: string,
		filter: { ruleIds?: number[] } = {},
	): Promise<Rule[]> {
		return filterRules(this.get(extensionId).dynamic.source, filter);
	}

	async updateSessionRules(
		extensionId: string,
		options: { removeRuleIds?: number[]; addRules?: unknown[] } = {},
	): Promise<void> {
		const installed = this.get(extensionId);
		const result = compileUpdate(
			installed.session.source,
			options.removeRuleIds,
			options.addRules,
			this.sessionLimits(installed),
			{ extensionBase: installed.base, session: true },
		);
		if (result.error !== undefined) throw new Error(result.error);
		installed.session = { source: result.source!, ruleset: result.ruleset! };
		installed.matcher.addOrUpdate([
			{ id: SESSION_RULESET_ID, rank: -1, rules: result.ruleset!.rules },
		]);
	}

	async getSessionRules(
		extensionId: string,
		filter: { ruleIds?: number[] } = {},
	): Promise<Rule[]> {
		return filterRules(this.get(extensionId).session.source, filter);
	}

	async getEnabledRulesets(extensionId: string): Promise<string[]> {
		const installed = this.get(extensionId);
		return installed.matcher
			.list()
			.filter((ruleset) => ruleset.rank > 0)
			.sort((a, b) => a.rank - b.rank)
			.map((ruleset) => ruleset.id);
	}

	/** updateEnabledRulesets (UpdateEnabledStaticRulesetsInternal, OnNewStaticRulesetsLoaded) */
	async updateEnabledRulesets(
		extensionId: string,
		options: { disableRulesetIds?: string[]; enableRulesetIds?: string[] } = {},
	): Promise<void> {
		const installed = this.get(extensionId);
		const statics = this.rulesetsOf(installed);
		const known = new Set(statics.map((ruleset) => ruleset.id));
		const enable = new Set<string>();
		const disable = new Set<string>();
		for (const id of options.enableRulesetIds ?? []) {
			if (!known.has(id)) throw new Error(LIMIT_MESSAGES.invalidRulesetId(id));
			enable.add(id);
		}
		for (const id of options.disableRulesetIds ?? []) {
			if (!known.has(id)) throw new Error(LIMIT_MESSAGES.invalidRulesetId(id));
			if (!enable.has(id)) disable.add(id);
		}
		if (!enable.size && !disable.size) return;
		let count = 0;
		let rules = 0;
		let regex = 0;
		for (const ruleset of installed.matcher.list()) {
			if (
				ruleset.rank <= 0 ||
				disable.has(ruleset.id) ||
				enable.has(ruleset.id)
			)
				continue;
			const compiled = statics[ruleset.rank - 1].ruleset!;
			count++;
			rules += compiled.ruleCount;
			regex += compiled.regexCount;
		}
		const added: LoadedRuleset[] = [];
		for (const ruleset of statics) {
			if (!enable.has(ruleset.id)) continue;
			if (!ruleset.ruleset) throw new Error('Internal error.');
			count++;
			rules += ruleset.ruleset.ruleCount;
			regex += ruleset.ruleset.regexCount;
			added.push(this.loadedStatic(installed, ruleset.id)!);
		}
		if (count > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS)
			throw new Error(LIMIT_MESSAGES.enabledRulesetCount);
		if (regex > MAX_NUMBER_OF_REGEX_RULES)
			throw new Error(LIMIT_MESSAGES.enabledRulesetsRegexRuleCount);
		if (!this.updateAllocation(extensionId, rules))
			throw new Error(LIMIT_MESSAGES.enabledRulesetsRuleCount);
		installed.matcher.remove(disable);
		installed.matcher.addOrUpdate(added);
		for (const id of disable) installed.enabled.delete(id);
		for (const id of enable) installed.enabled.add(id);
		this.persist(installed);
	}

	/** updateStaticRules (PrefsHelper::UpdateDisabledStaticRules) */
	async updateStaticRules(
		extensionId: string,
		options: {
			rulesetId: string;
			disableRuleIds?: number[];
			enableRuleIds?: number[];
		},
	): Promise<void> {
		const installed = this.get(extensionId);
		if (
			!this.rulesetsOf(installed).some(
				(ruleset) => ruleset.id === options.rulesetId,
			)
		)
			throw new Error(LIMIT_MESSAGES.invalidRulesetId(options.rulesetId));
		const current =
			installed.disabled.get(options.rulesetId) ?? new Set<number>();
		const next = new Set(current);
		for (const id of options.disableRuleIds ?? []) next.add(id);
		for (const id of options.enableRuleIds ?? []) next.delete(id);
		if (next.size === current.size && [...next].every((id) => current.has(id)))
			return;
		let total = next.size;
		for (const [id, set] of installed.disabled)
			if (id !== options.rulesetId) total += set.size;
		if (total > MAX_DISABLED_STATIC_RULES)
			throw new Error(LIMIT_MESSAGES.disabledStaticRuleCount);
		if (next.size) installed.disabled.set(options.rulesetId, next);
		else installed.disabled.delete(options.rulesetId);
		installed.matcher.setDisabled(options.rulesetId, next);
		this.persist(installed);
	}

	async getDisabledRuleIds(
		extensionId: string,
		options: { rulesetId: string },
	): Promise<number[]> {
		const installed = this.get(extensionId);
		if (
			!this.rulesetsOf(installed).some(
				(ruleset) => ruleset.id === options.rulesetId,
			)
		)
			throw new Error(LIMIT_MESSAGES.invalidRulesetId(options.rulesetId));
		return [...(installed.disabled.get(options.rulesetId) ?? [])].sort(
			(a, b) => a - b,
		);
	}

	/** getAvailableStaticRuleCount */
	async getAvailableStaticRuleCount(extensionId: string): Promise<number> {
		const installed = this.get(extensionId);
		let enabled = 0;
		for (const ruleset of installed.matcher.list())
			if (ruleset.rank > 0)
				enabled +=
					this.rulesetsOf(installed)[ruleset.rank - 1].ruleset!.ruleCount;
		const available = this.availableAllocation(extensionId);
		return enabled < GUARANTEED_MINIMUM_STATIC_RULES
			? GUARANTEED_MINIMUM_STATIC_RULES - enabled + available
			: available - (enabled - GUARANTEED_MINIMUM_STATIC_RULES);
	}

	/** getMatchedRules, with its permission check and quota (none from a user gesture) */
	async getMatchedRules(
		extensionId: string,
		filter: { tabId?: number; minTimeStamp?: number } = {},
		userGesture = false,
	): Promise<{ rulesMatchedInfo: MatchedRuleInfo[] }> {
		const installed = this.get(extensionId);
		const tabId = filter.tabId;
		if (
			tabId !== undefined &&
			tabId !== TAB_ID_NONE &&
			this.hooks.validTab &&
			!this.hooks.validTab(tabId)
		)
			throw new Error(`No tab with id: ${tabId}.`);
		const permissions = installed.info.permissions ?? {};
		const allowed =
			!!permissions.declarativeNetRequestFeedback ||
			(tabId !== undefined &&
				!!permissions.activeTab &&
				!!this.hooks.activeTabGranted?.(extensionId, tabId));
		if (!allowed)
			throw new Error(
				'The extension must have the declarativeNetRequestFeedback permission or have activeTab granted for the specified tab ID in order to call this function.',
			);
		if (!userGesture) {
			const now = this.now();
			const window = GETMATCHEDRULES_QUOTA_INTERVAL * 60 * 1000;
			installed.matchedRuleCalls = installed.matchedRuleCalls.filter(
				(at) => at > now - window,
			);
			if (
				installed.matchedRuleCalls.length >=
				MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL
			)
				throw new Error(
					'This request exceeds the MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL quota.',
				);
			installed.matchedRuleCalls.push(now);
		}
		return {
			rulesMatchedInfo: this.tracker.getMatchedRules(
				extensionId,
				tabId,
				filter.minTimeStamp ?? 0,
			),
		};
	}

	/** setExtensionActionOptions */
	async setExtensionActionOptions(
		extensionId: string,
		options: {
			displayActionCountAsBadgeText?: boolean;
			tabUpdate?: { tabId: number; increment: number };
		},
	): Promise<void> {
		const installed = this.get(extensionId);
		if (
			options.displayActionCountAsBadgeText !== undefined &&
			options.displayActionCountAsBadgeText !== installed.badge
		) {
			installed.badge = options.displayActionCountAsBadgeText;
			this.persist(installed);
		}
		if (options.tabUpdate) {
			if (!installed.badge)
				throw new Error(LIMIT_MESSAGES.incrementWithoutBadge);
			const { tabId, increment } = options.tabUpdate;
			if (this.hooks.validTab && !this.hooks.validTab(tabId))
				throw new Error(`No tab with id: ${tabId}.`);
			this.tracker.incrementActionCount(extensionId, tabId, increment);
		}
	}

	/** isRegexSupported */
	async isRegexSupported(options: {
		regex: string;
		isCaseSensitive?: boolean;
		requireCapturing?: boolean;
	}): Promise<{ isSupported: boolean; reason?: UnsupportedRegexReason }> {
		const result = compileRE2(options.regex, {
			caseSensitive: options.isCaseSensitive ?? true,
			requireCapturing: options.requireCapturing ?? false,
		});
		return result.ok
			? { isSupported: true }
			: { isSupported: false, reason: result.reason };
	}

	/** testMatchOutcome (DeclarativeNetRequestTestMatchOutcomeFunction) */
	async testMatchOutcome(
		extensionId: string,
		request: TestMatchRequestDetails,
	): Promise<{ matchedRules: MatchedRule[] }> {
		const valid = (url: string) => {
			try {
				new URL(url);
				return true;
			} catch {
				return false;
			}
		};
		if (!valid(request.url)) throw new Error(LIMIT_MESSAGES.invalidTestUrl);
		if (request.initiator !== undefined && !valid(request.initiator))
			throw new Error(LIMIT_MESSAGES.invalidTestInitiator);
		const tabId = request.tabId ?? TAB_ID_NONE;
		if (tabId < TAB_ID_NONE) throw new Error(LIMIT_MESSAGES.invalidTestTabId);
		if (request.topUrl !== undefined && !valid(request.topUrl))
			throw new Error(LIMIT_MESSAGES.invalidTestTopUrl);
		// ParseHeaders: names are tokens; so must the values be (Chrome checks
		// them with IsValidHeaderName); an empty list is one empty value
		const lines: HeaderLines = [];
		for (const [header, values] of Object.entries(
			request.responseHeaders ?? {},
		)) {
			if (!isValidHeaderName(header))
				throw new Error(`Invalid header name "${header}".`);
			if (!Array.isArray(values))
				throw new Error(
					`Values for header "${header}" must be specified as a list.`,
				);
			if (!values.length) lines.push([header, '']);
			for (const value of values) {
				if (typeof value !== 'string' || !isValidHeaderName(value))
					throw new Error(`Invalid header value for header "${header}".`);
				lines.push([header, value]);
			}
		}
		const installed = this.extensions.get(extensionId);
		if (!installed) return { matchedRules: [] };
		const initiatorOrigin =
			request.initiator !== undefined ? originOf(request.initiator) : null;
		const topOrigin =
			request.topUrl !== undefined ? originOf(request.topUrl) : null;
		const initiatorHost = parseOrigin(initiatorOrigin);
		const p = new Params({
			url: request.url,
			initiator: initiatorOrigin,
			type: request.type,
			method: request.method ?? 'get',
			tabId,
			frame: null,
			topHost: parseOrigin(topOrigin) ?? initiatorHost ?? '',
		});
		p.responseHeaders = lines;
		const dnrRequest: DnrRequest = {
			url: request.url,
			initiator: initiatorOrigin,
			type: request.type,
			method: request.method ?? 'get',
			tabId,
		};
		const access =
			this.hooks.access?.(extensionId, dnrRequest) ?? DEFAULT_ACCESS;
		const getActions = (stage: Stage) => {
			const { action } = installed.matcher.getAction(p, stage, access);
			if (action && !isAllow(action)) return [action];
			const modify = installed.matcher.getModifyHeaders(p, stage);
			if (modify.length) return modify;
			return action ? [action] : [];
		};
		const intercepted = (actions: DnrAction[]) =>
			!!actions.length &&
			!isAllow(actions[0]) &&
			actions[0].type !== 'modifyHeaders';
		const report = (actions: DnrAction[]) => ({
			matchedRules: actions.map((action) => ({
				ruleId: action.ruleId,
				rulesetId: action.rulesetId,
			})),
		});
		let before = getActions(STAGE_BEFORE_REQUEST);
		if (intercepted(before)) return report(before);
		const after = getActions(STAGE_HEADERS_RECEIVED);
		const allowPriority =
			after.length && isAllow(after[0]) ? after[0].priority : 0;
		before = before.filter((action) => action.priority >= allowPriority);
		if (!before.length || intercepted(after)) return report(after);
		if (!after.length) return report(before);
		if (isAllow(before[0])) return report(after);
		if (isAllow(after[0])) return report(before);
		return report(
			[...before, ...after].sort((a, b) => (actionGreaterTuple(a, b) ? -1 : 1)),
		);
	}

	// --- the request path ---

	/** the extensions whose rules apply to the request, with their access (ShouldEvaluateRulesetForRequest) */
	private evaluated(request: DnrRequest): [Installed, PageAccess][] {
		const out: [Installed, PageAccess][] = [];
		for (const installed of this.sorted) {
			const id = installed.info.id;
			// another extension's requests, but for a main frame
			if (request.initiator && request.type !== 'main_frame') {
				const initiator = request.initiator;
				if (
					initiator.startsWith('chrome-extension://') &&
					parseOrigin(initiator) !== id
				)
					continue;
			}
			if (this.hooks.hidden?.(id, request)) continue;
			const access = this.hooks.access?.(id, request) ?? DEFAULT_ACCESS;
			if (
				installed.matcher.options.hostAccessAlwaysRequired &&
				access === 'denied'
			)
				continue;
			out.push([installed, access]);
		}
		return out;
	}

	/** RulesetManager::EvaluateRequestInternal */
	private evaluate(state: DnrRequestState, stage: Stage): DnrAction[] {
		const { request, params } = state;
		if (HIDDEN_SCHEMES.has(params.url.protocol)) return [];
		const list = this.evaluated(request);
		if (!list.length) return [];
		// GetAction: block beats redirect beats allow; a tie goes to the more recent extension
		const classOf = (action: DnrAction | null) =>
			!action
				? 0
				: action.type === 'block' || action.type === 'collapse'
					? 3
					: action.type === 'redirect' || action.type === 'upgradeScheme'
						? 2
						: 1;
		let chosen: DnrAction | null = null;
		for (const [installed, access] of list) {
			const { action, withheld } = installed.matcher.getAction(
				params,
				stage,
				access,
			);
			if (withheld) {
				this.hooks.withheld?.(installed.info.id, request);
				continue;
			}
			// a redirect to a file: URL needs "Allow access to file URLs"
			if (
				action?.type === 'redirect' &&
				action.redirectUrl?.startsWith('file:') &&
				!this.hooks.fileAccess?.(installed.info.id)
			)
				continue;
			if (classOf(action) > classOf(chosen)) chosen = action;
		}
		if (chosen && !isAllow(chosen)) return [chosen];
		const modify: DnrAction[] = [];
		for (const [installed, access] of list) {
			if (access === 'denied') continue;
			const actions = installed.matcher.getModifyHeaders(params, stage);
			if (access === 'allowed') modify.push(...actions);
			else if (actions.length)
				this.hooks.withheld?.(installed.info.id, request);
		}
		if (modify.length) return modify;
		return chosen ? [chosen] : [];
	}

	private outcomeOf(action: DnrAction | undefined): DnrOutcome {
		if (!action) return { type: 'none' };
		if (action.type === 'block' || action.type === 'collapse')
			return { type: action.type, action };
		if (action.type === 'redirect' || action.type === 'upgradeScheme')
			return { type: 'redirect', redirectUrl: action.redirectUrl, action };
		return { type: 'none', action };
	}

	/** whether any extension has rules at all: the request path is skipped without */
	get active(): boolean {
		return this.extensions.size > 0;
	}

	/**
	 * onBeforeRequest's DNR step. The state goes on to beforeSendHeaders and
	 * headersReceived; the outcome says whether the request goes out
	 */
	beforeRequest(request: DnrRequest): {
		state: DnrRequestState;
		outcome: DnrOutcome;
	} {
		const params = new Params({
			url: request.url,
			initiator: request.initiator,
			type: request.type,
			method: request.method,
			tabId: request.tabId,
			frame: request.frame,
			topHost: topHostOf(request),
		});
		const state: DnrRequestState = { request, params, actions: [] };
		if (!this.extensions.size) return { state, outcome: { type: 'none' } };
		state.actions = this.evaluate(state, STAGE_BEFORE_REQUEST);
		const first = state.actions[0];
		if (first && first.type !== 'modifyHeaders')
			this.tracker.onRuleMatched(first, request);
		return {
			state,
			outcome: this.outcomeOf(
				first?.type === 'modifyHeaders' ? undefined : first,
			),
		};
	}

	/** onBeforeSendHeaders: the request headers, changed in place; the actions that changed any are matched */
	beforeSendHeaders(state: DnrRequestState, headers: HeaderList): DnrAction[] {
		const modify = state.actions.filter(
			(action) => action.type === 'modifyHeaders' && action.requestHeaders,
		);
		if (!modify.length) return [];
		const result = applyRequestHeaders(headers, state.actions);
		state.requestHeaderOps = result.ops;
		for (const action of result.applied)
			this.tracker.onRuleMatched(action, state.request);
		return result.applied;
	}

	private hasHeaderRules() {
		for (const installed of this.sorted)
			if (installed.matcher.hasRules(STAGE_HEADERS_RECEIVED)) return true;
		return false;
	}

	/**
	 * onHeadersReceived's DNR step: the rules that match on response headers,
	 * then the response header modifications in force. `lines` comes back
	 * changed when a header did
	 */
	headersReceived(
		state: DnrRequestState,
		lines: HeaderLines,
	): { outcome: DnrOutcome; lines: HeaderLines | null } {
		const { request, params } = state;
		if (this.extensions.size && this.hasHeaderRules()) {
			params.responseHeaders = lines;
			const actions = this.evaluate(state, STAGE_HEADERS_RECEIVED);
			const first = actions[0];
			if (first) {
				switch (first.type) {
					case 'block':
					case 'collapse':
					case 'redirect':
					case 'upgradeScheme':
						this.tracker.onRuleMatched(first, request);
						return { outcome: this.outcomeOf(first), lines: null };
					case 'allow':
					case 'allowAllRequests':
						this.eraseOutprioritized(state);
						if (this.shouldRecordAllow(state, first))
							this.tracker.onRuleMatched(first, request);
						break;
					case 'modifyHeaders':
						this.eraseOutprioritized(state);
						if (
							!state.actions.length ||
							state.actions[0].type !== 'modifyHeaders'
						)
							state.actions = actions;
						else
							state.actions = this.mergeModifyHeaders(state.actions, actions);
						break;
				}
			}
		}
		const modify = state.actions.filter(
			(action) => action.type === 'modifyHeaders' && action.responseHeaders,
		);
		if (!modify.length) return { outcome: { type: 'none' }, lines: null };
		const hide = this.hooks.hideResponseHeader;
		const result = applyResponseHeaders(
			lines,
			state.actions,
			hide ? (header) => hide(request.url, header) : undefined,
		);
		state.responseHeaderOps = result.ops;
		for (const action of result.applied)
			this.tracker.onRuleMatched(action, request);
		return { outcome: { type: 'none' }, lines: result.lines };
	}

	/** WebRequestInfo::EraseOutprioritizedDNRActions */
	private eraseOutprioritized(state: DnrRequestState) {
		state.actions = state.actions.filter((action) => {
			const allow = state.params.maxAllow.get(action.extensionId);
			return action.priority >= (allow ? allow.priority : 0);
		});
	}

	/** WebRequestInfo::ShouldRecordMatchedAllowRuleInOnHeadersReceived */
	private shouldRecordAllow(state: DnrRequestState, allow: DnrAction): boolean {
		const actions = state.actions;
		if (!actions.length) return true;
		if (
			actions.every(
				(action) => action.type === 'modifyHeaders' && !action.responseHeaders,
			)
		)
			return true;
		if (isAllow(actions[0]))
			return allow.extensionId !== actions[0].extensionId;
		return false;
	}

	/** RulesetManager::MergeModifyHeaderActions: by install time, extension id, then the action order */
	private mergeModifyHeaders(a: DnrAction[], b: DnrAction[]): DnrAction[] {
		const time = (action: DnrAction) =>
			this.extensions.get(action.extensionId)?.info.installTime ?? 0;
		return [...a, ...b].sort((x, y) => {
			if (time(x) !== time(y)) return time(y) - time(x);
			if (x.extensionId !== y.extensionId)
				return x.extensionId < y.extensionId ? 1 : -1;
			return actionGreaterTuple(x, y) ? -1 : actionGreaterTuple(y, x) ? 1 : 0;
		});
	}

	// --- frames ---

	/**
	 * A main frame that committed in no known tab is `tabId`'s (its document
	 * said so): the matches held for it go to the tab, as at a commit
	 */
	onMainFramePlaced(tabId: number) {
		this.tracker.onMainFrameCommitted(
			tabId,
			[...this.extensions.keys()],
			TAB_ID_NONE,
		);
	}

	/** a frame committed a navigation (OnDidFinishNavigation) */
	onNavigationCommitted(commit: CommitInfo) {
		const main = commit.parent === null;
		const tabId = commit.tabId ?? TAB_ID_NONE;
		if (main && tabId !== TAB_ID_NONE)
			this.tracker.onMainFrameCommitted(tabId, [...this.extensions.keys()]);
		if (!this.extensions.size) return;
		let p: Params | null = null;
		let withHeaders: Params | null = null;
		const type: ResourceType = main ? 'main_frame' : 'sub_frame';
		if (!commit.errorPage) {
			const origin = commit.origin ?? originOf(commit.url);
			const parentOrigin = main ? null : (commit.parentOrigin ?? null);
			const parentHost = parseOrigin(parentOrigin);
			const make = () =>
				new Params({
					url: commit.url,
					initiator: parentOrigin,
					type,
					method: commit.isPost ? 'post' : 'get',
					tabId,
					frame: null,
					topHost:
						parseOrigin(commit.topOrigin ?? (main ? origin : null)) ??
						parentHost ??
						'',
					thirdParty:
						parentHost === null
							? true
							: isThirdParty(parseOrigin(origin) ?? '', parentHost),
				});
			try {
				p = make();
				if (commit.responseHeaders) {
					withHeaders = make();
					withHeaders.responseHeaders = commit.responseHeaders;
				}
			} catch {
				p = null;
			}
		}
		const navigation: DnrRequest = {
			url: commit.url,
			initiator: commit.parentOrigin ?? null,
			type,
			tabId,
		};
		for (const installed of this.sorted) {
			const access =
				this.hooks.access?.(installed.info.id, navigation) ?? DEFAULT_ACCESS;
			installed.matcher.onNavigationCommitted(
				commit.frame,
				commit.parent,
				p,
				withHeaders,
				access === 'allowed',
			);
		}
	}

	/** a frame that loads before it commits (srcdoc, about:blank) takes its parent's allowAllRequests */
	onFrameCreated(frame: string, parent: string) {
		for (const installed of this.sorted)
			installed.matcher.onFrameCreated(frame, parent);
	}

	onFrameRemoved(frame: string) {
		for (const installed of this.sorted)
			installed.matcher.onFrameRemoved(frame);
	}

	onTabRemoved(tabId: number) {
		this.tracker.onTabRemoved(tabId);
	}

	/** the matcher of one extension, for the measurements */
	matcherOf(extensionId: string): ExtensionMatcher | undefined {
		return this.extensions.get(extensionId)?.matcher;
	}
}

const actionGreaterTuple = (a: DnrAction, b: DnrAction) =>
	a.priority !== b.priority
		? a.priority > b.priority
		: (a.rank ?? 0) !== (b.rank ?? 0)
			? (a.rank ?? 0) > (b.rank ?? 0)
			: a.ruleId > b.ruleId;

/** url::Origin::Create(GURL(url)).Serialize() */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return 'null';
	}
}

function filterRules(rules: Rule[], filter: { ruleIds?: number[] }): Rule[] {
	const copy = structuredClone(rules);
	if (!filter.ruleIds) return copy;
	const ids = new Set(filter.ruleIds);
	return copy.filter((rule) => ids.has(rule.id));
}

export { STAGE_BEFORE_REQUEST, STAGE_HEADERS_RECEIVED };
export type { PageAccess };
