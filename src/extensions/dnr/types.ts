// The chrome.declarativeNetRequest data types and constants, as Chrome 157
// defines them (extensions/common/api/declarative_net_request.webidl), and
// the request and action shapes the matcher speaks (docs/extensions-dnr.md).

export type ResourceType =
	| 'main_frame'
	| 'sub_frame'
	| 'stylesheet'
	| 'script'
	| 'image'
	| 'font'
	| 'object'
	| 'xmlhttprequest'
	| 'ping'
	| 'csp_report'
	| 'media'
	| 'websocket'
	| 'webtransport'
	| 'webbundle'
	| 'other';

export type RequestMethod =
	| 'connect'
	| 'delete'
	| 'get'
	| 'head'
	| 'options'
	| 'patch'
	| 'post'
	| 'put'
	| 'other';

export type DomainType = 'firstParty' | 'thirdParty';
export type HeaderOperation = 'append' | 'set' | 'remove';
export type RuleActionType =
	| 'block'
	| 'redirect'
	| 'allow'
	| 'upgradeScheme'
	| 'modifyHeaders'
	| 'allowAllRequests';
export type UnsupportedRegexReason = 'syntaxError' | 'memoryLimitExceeded';

export interface QueryKeyValue {
	key: string;
	value: string;
	replaceOnly?: boolean;
}
export interface QueryTransform {
	removeParams?: string[];
	addOrReplaceParams?: QueryKeyValue[];
}
export interface URLTransform {
	scheme?: string;
	host?: string;
	port?: string;
	path?: string;
	query?: string;
	queryTransform?: QueryTransform;
	fragment?: string;
	username?: string;
	password?: string;
}
export interface Redirect {
	extensionPath?: string;
	transform?: URLTransform;
	url?: string;
	regexSubstitution?: string;
}
export interface HeaderInfo {
	header: string;
	values?: string[];
	excludedValues?: string[];
}
export interface RuleCondition {
	urlFilter?: string;
	regexFilter?: string;
	isUrlFilterCaseSensitive?: boolean;
	initiatorDomains?: string[];
	excludedInitiatorDomains?: string[];
	requestDomains?: string[];
	excludedRequestDomains?: string[];
	topDomains?: string[];
	excludedTopDomains?: string[];
	/** deprecated: initiatorDomains */
	domains?: string[];
	/** deprecated: excludedInitiatorDomains */
	excludedDomains?: string[];
	resourceTypes?: ResourceType[];
	excludedResourceTypes?: ResourceType[];
	requestMethods?: RequestMethod[];
	excludedRequestMethods?: RequestMethod[];
	domainType?: DomainType;
	tabIds?: number[];
	excludedTabIds?: number[];
	responseHeaders?: HeaderInfo[];
	excludedResponseHeaders?: HeaderInfo[];
}
export interface ModifyHeaderInfo {
	header: string;
	operation: HeaderOperation;
	value?: string;
	/** [nodoc] in Chrome, behind kDeclarativeNetRequestHeaderSubstitution */
	regexFilter?: string;
	regexSubstitution?: string;
	regexOptions?: { matchAll?: boolean };
}
export interface RuleAction {
	type: RuleActionType;
	redirect?: Redirect;
	requestHeaders?: ModifyHeaderInfo[];
	responseHeaders?: ModifyHeaderInfo[];
}
export interface Rule {
	id: number;
	priority?: number;
	condition: RuleCondition;
	action: RuleAction;
}

export interface MatchedRule {
	ruleId: number;
	rulesetId: string;
	/** set when more than one extension's rules are asked (testMatchOutcome answers without it) */
	extensionId?: string;
}

/** a request as the matcher sees it (Chrome's WebRequestInfo / RequestParams, the parts DNR reads) */
export interface DnrRequest {
	/** the real URL, as it goes out */
	url: string;
	/**
	 * the serialized origin of the document or worker that started it; null
	 * or absent for none (a navigation the user started), 'null' for an
	 * opaque one
	 */
	initiator?: string | null;
	type: ResourceType;
	/** the HTTP method, any case; defaults to GET */
	method?: string;
	/** the tab, TAB_ID_NONE (-1) when the request belongs to none */
	tabId?: number;
	/** the outermost frame's document URL (topDomains); a main_frame request is its own */
	topUrl?: string | null;
	/**
	 * the frame whose allowAllRequests state the request inherits: for a
	 * subresource, the document that makes it; for a sub_frame navigation,
	 * the frame's parent; nothing for a main_frame one
	 */
	frame?: string | null;
	/** reported in onRuleMatchedDebug's request details */
	requestId?: string;
	frameId?: number;
	parentFrameId?: number;
	documentId?: string;
}

/** what a stage of the matcher decided for one extension's rule (Chrome's RequestAction) */
export interface DnrAction {
	type:
		| 'block'
		| 'collapse'
		| 'allow'
		| 'allowAllRequests'
		| 'redirect'
		| 'upgradeScheme'
		| 'modifyHeaders';
	extensionId: string;
	rulesetId: string;
	ruleId: number;
	/** the rule's index priority: priority * 256 + its action type's rank */
	priority: number;
	/** redirect and upgradeScheme: where the request goes instead */
	redirectUrl?: string;
	requestHeaders?: ModifyHeaderInfo[];
	responseHeaders?: ModifyHeaderInfo[];
	/** internal: the ruleset's numeric id, for Chrome's tie order */
	rank?: number;
}

export const TAB_ID_NONE = -1;
export const DYNAMIC_RULESET_ID = '_dynamic';
export const SESSION_RULESET_ID = '_session';

export const GUARANTEED_MINIMUM_STATIC_RULES = 30000;
export const MAX_NUMBER_OF_DYNAMIC_RULES = 30000;
export const MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 5000;
export const MAX_NUMBER_OF_SESSION_RULES = 5000;
export const MAX_NUMBER_OF_UNSAFE_SESSION_RULES = 5000;
/** deprecated in Chrome: there is no combined limit any more */
export const MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES = 5000;
export const MAX_NUMBER_OF_REGEX_RULES = 1000;
export const MAX_NUMBER_OF_STATIC_RULESETS = 100;
export const MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50;
export const GETMATCHEDRULES_QUOTA_INTERVAL = 10;
export const MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL = 20;
/** the global pool of static rules above each extension's guaranteed minimum (kMaxStaticRulesPerProfile) */
export const MAX_STATIC_RULES_PER_PROFILE = 300000;
/** kMaxDisabledStaticRules */
export const MAX_DISABLED_STATIC_RULES = 5000;
/** how long a matched rule of no active tab is kept for getMatchedRules (ActionTracker) */
export const NON_ACTIVE_TAB_RULE_LIFESPAN_MS = 5 * 60 * 1000;
