// Matched rules, as Chrome's ActionTracker keeps them
// (extensions/browser/api/declarative_net_request/action_tracker.cc): per
// extension and tab, recorded only for an extension with
// declarativeNetRequestFeedback (or activeTab and a tab), a main frame
// navigation's matches held until it commits, the rules of a tab that is
// no longer the document's moved to the unknown tab and dropped five
// minutes on; getMatchedRules filters by tab and time, the action count
// leaves allow rules out, onRuleMatchedDebug reports every match.

import {
	NON_ACTIVE_TAB_RULE_LIFESPAN_MS,
	TAB_ID_NONE,
	type DnrAction,
	type DnrRequest,
} from './types';

/** MatchedRule */
export interface MatchedRule {
	ruleId: number;
	rulesetId: string;
}

/** MatchedRuleInfo, as getMatchedRules answers it */
export interface MatchedRuleInfo {
	rule: MatchedRule;
	timeStamp: number;
	tabId: number;
}

export interface RequestDetails {
	requestId: string;
	url: string;
	initiator?: string;
	method: string;
	frameId: number;
	documentId?: string;
	parentFrameId: number;
	tabId: number;
	type: string;
}

export interface MatchedRuleInfoDebug {
	rule: { ruleId: number; rulesetId: string };
	request: RequestDetails;
}

interface Tracked {
	rules: MatchedRuleInfo[];
	actionCount: number;
}

export interface TrackerHooks {
	now?: () => number;
	/** whether the extension may read its matches (feedback, or activeTab for a tab) */
	canRecord: (extensionId: string, tabId: number) => boolean;
	/** onRuleMatchedDebug, for an extension listening */
	debug?: (extensionId: string, info: MatchedRuleInfoDebug) => void;
	/** IsValidTabId: a request of a tab that is gone counts as the unknown tab's */
	validTab?: (tabId: number) => boolean;
	/** the badge: setExtensionActionOptions({displayActionCountAsBadgeText}) */
	badge?: (extensionId: string, tabId: number, count: number) => void;
	useBadge?: (extensionId: string) => boolean;
}

const key = (extensionId: string, tabId: number) => `${extensionId}\n${tabId}`;

export class ActionTracker {
	private tracked = new Map<string, Tracked>();
	private pending = new Map<string, Tracked>();

	constructor(private hooks: TrackerHooks) {}

	private now() {
		return this.hooks.now?.() ?? Date.now();
	}

	/** ActionTracker::OnRuleMatched */
	onRuleMatched(action: DnrAction, request: DnrRequest) {
		const requestTab = request.tabId ?? TAB_ID_NONE;
		const tabId =
			requestTab !== TAB_ID_NONE &&
			this.hooks.validTab &&
			!this.hooks.validTab(requestTab)
				? TAB_ID_NONE
				: requestTab;
		this.hooks.debug?.(action.extensionId, {
			rule: { ruleId: action.ruleId, rulesetId: action.rulesetId },
			request: {
				requestId: request.requestId ?? '',
				url: request.url,
				...(request.initiator ? { initiator: request.initiator } : {}),
				method: (request.method ?? 'GET').toUpperCase(),
				frameId: request.frameId ?? (request.type === 'main_frame' ? 0 : -1),
				...(request.documentId ? { documentId: request.documentId } : {}),
				parentFrameId: request.parentFrameId ?? -1,
				tabId,
				type: request.type,
			},
		});
		const record = this.hooks.canRecord(action.extensionId, tabId);
		const count =
			tabId !== TAB_ID_NONE &&
			action.type !== 'allow' &&
			action.type !== 'allowAllRequests';
		const add = (info: Tracked, counted = count) => {
			if (record)
				info.rules.push({
					rule: { ruleId: action.ruleId, rulesetId: action.rulesetId },
					timeStamp: this.now(),
					tabId,
				});
			if (counted) info.actionCount++;
		};
		if (request.type === 'main_frame') {
			// held for the navigation's commit (one of no known tab is counted
			// too: its tab may be told before it commits, onMainFramePlaced)
			const pendingKey = key(action.extensionId, tabId);
			let info = this.pending.get(pendingKey);
			if (!info)
				this.pending.set(pendingKey, (info = { rules: [], actionCount: 0 }));
			add(info, action.type !== 'allow' && action.type !== 'allowAllRequests');
			return;
		}
		const trackedKey = key(action.extensionId, tabId);
		let info = this.tracked.get(trackedKey);
		if (!info)
			this.tracked.set(trackedKey, (info = { rules: [], actionCount: 0 }));
		add(info);
		if (count && this.hooks.useBadge?.(action.extensionId))
			this.hooks.badge?.(action.extensionId, tabId, info.actionCount);
	}

	/**
	 * ResetTrackedInfoForTab: a main frame commits in the tab. `heldIn`: the
	 * tab its matches were held under (none, for a navigation whose tab was
	 * told only once it committed)
	 */
	onMainFrameCommitted(
		tabId: number,
		extensionIds: Iterable<string>,
		heldIn = tabId,
	) {
		this.transferToUnknown(tabId);
		for (const extensionId of extensionIds) {
			const pendingKey = key(extensionId, heldIn);
			const info = this.pending.get(pendingKey) ?? {
				rules: [],
				actionCount: 0,
			};
			this.pending.delete(pendingKey);
			if (heldIn !== tabId) for (const rule of info.rules) rule.tabId = tabId;
			this.tracked.set(key(extensionId, tabId), info);
			if (this.hooks.useBadge?.(extensionId))
				this.hooks.badge?.(extensionId, tabId, info.actionCount);
		}
	}

	/** a navigation that never commits */
	clearPending(tabId: number) {
		for (const pendingKey of [...this.pending.keys()])
			if (pendingKey.endsWith(`\n${tabId}`)) this.pending.delete(pendingKey);
	}

	private transferToUnknown(tabId: number) {
		for (const [trackedKey, info] of this.tracked) {
			const [extensionId, tab] = trackedKey.split('\n');
			if (Number(tab) !== tabId || !info.rules.length) continue;
			const unknownKey = key(extensionId, TAB_ID_NONE);
			let unknown = this.tracked.get(unknownKey);
			if (!unknown)
				this.tracked.set(unknownKey, (unknown = { rules: [], actionCount: 0 }));
			unknown.rules.push(...info.rules);
			info.rules = [];
		}
	}

	/** ClearTabData: the tab closed */
	onTabRemoved(tabId: number) {
		this.transferToUnknown(tabId);
		for (const trackedKey of [...this.tracked.keys()])
			if (trackedKey.endsWith(`\n${tabId}`) && tabId !== TAB_ID_NONE)
				this.tracked.delete(trackedKey);
		this.clearPending(tabId);
	}

	clearExtension(extensionId: string) {
		for (const map of [this.tracked, this.pending])
			for (const trackedKey of [...map.keys()])
				if (trackedKey.startsWith(`${extensionId}\n`)) map.delete(trackedKey);
	}

	/** TrimRulesFromNonActiveTabs */
	private trim() {
		const now = this.now();
		for (const [trackedKey, info] of this.tracked) {
			if (!trackedKey.endsWith(`\n${TAB_ID_NONE}`)) continue;
			info.rules = info.rules.filter(
				(rule) => rule.timeStamp > now - NON_ACTIVE_TAB_RULE_LIFESPAN_MS,
			);
		}
	}

	/** ActionTracker::GetMatchedRules */
	getMatchedRules(
		extensionId: string,
		tabId?: number,
		minTimeStamp = 0,
	): MatchedRuleInfo[] {
		this.trim();
		const out: MatchedRuleInfo[] = [];
		const take = (info: Tracked | undefined, tab: number) => {
			for (const rule of info?.rules ?? [])
				if (rule.timeStamp >= minTimeStamp)
					out.push({
						rule: { ...rule.rule },
						timeStamp: rule.timeStamp,
						tabId: tab,
					});
		};
		if (tabId !== undefined)
			take(this.tracked.get(key(extensionId, tabId)), tabId);
		else
			for (const [trackedKey, info] of this.tracked) {
				const [id, tab] = trackedKey.split('\n');
				if (id === extensionId) take(info, Number(tab));
			}
		return out;
	}

	actionCount(extensionId: string, tabId: number): number {
		return this.tracked.get(key(extensionId, tabId))?.actionCount ?? 0;
	}

	/** IncrementActionCountForTab (setExtensionActionOptions' tabUpdate) */
	incrementActionCount(extensionId: string, tabId: number, increment: number) {
		const trackedKey = key(extensionId, tabId);
		let info = this.tracked.get(trackedKey);
		if (!info)
			this.tracked.set(trackedKey, (info = { rules: [], actionCount: 0 }));
		const next = Math.max(info.actionCount + increment, 0);
		if (next === info.actionCount) return;
		info.actionCount = next;
		this.hooks.badge?.(extensionId, tabId, next);
	}
}
