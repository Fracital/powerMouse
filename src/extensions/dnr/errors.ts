// Chrome's rule parse errors (ParseResult) and the messages it gives for
// them (GetParseError in extensions/browser/api/declarative_net_request/
// utils.cc, the strings of constants.cc), word for word: an extension that
// shows or matches the message sees what Chrome would say.

const rule = (id: number) => `Rule with id ${id}`;
const emptyList = (id: number, key: string) =>
	`${rule(id)} cannot have an empty list as the value for ${key} key.`;
const emptyKey = (id: number, key: string) =>
	`${rule(id)} cannot have an empty value for ${key} key.`;
const nonAscii = (id: number, key: string) =>
	`${rule(id)} cannot have non-ascii characters as part of "${key}" key.`;
const invalidKey = (id: number, key: string) =>
	`${rule(id)} specifies an incorrect value for the "${key}" key.`;
const deprecated = (id: number, old: string, key: string) =>
	`${rule(id)} cannot use deprecated field "${old}". Use "${key}" instead.`;

const MESSAGES = {
	ERROR_REQUEST_METHOD_DUPLICATED: (id: number) =>
		`${rule(id)} includes and excludes the same request method.`,
	ERROR_RESOURCE_TYPE_DUPLICATED: (id: number) =>
		`${rule(id)} includes and excludes the same resource.`,
	ERROR_INVALID_RULE_ID: (id: number) =>
		`${rule(id)} has an invalid value for id key. This should be greater than or equal to 1.`,
	ERROR_INVALID_RULE_PRIORITY: (id: number) =>
		`${rule(id)} has an invalid value for priority key. This should be greater than or equal to 1.`,
	ERROR_NO_APPLICABLE_RESOURCE_TYPES: (id: number) =>
		`${rule(id)} is not applicable to any resource type.`,
	ERROR_EMPTY_DOMAINS_LIST: (id: number) => emptyList(id, 'domains'),
	ERROR_EMPTY_INITIATOR_DOMAINS_LIST: (id: number) =>
		emptyList(id, 'initiatorDomains'),
	ERROR_EMPTY_REQUEST_DOMAINS_LIST: (id: number) =>
		emptyList(id, 'requestDomains'),
	ERROR_EMPTY_TOP_DOMAINS_LIST: (id: number) => emptyList(id, 'topDomains'),
	ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED: (id: number) =>
		deprecated(id, 'domains', 'initiatorDomains'),
	ERROR_EXCLUDED_DOMAINS_AND_EXCLUDED_INITIATOR_DOMAINS_BOTH_SPECIFIED: (
		id: number,
	) => deprecated(id, 'excludedDomains', 'excludedInitiatorDomains'),
	ERROR_EMPTY_RESOURCE_TYPES_LIST: (id: number) =>
		emptyList(id, 'resourceTypes'),
	ERROR_EMPTY_REQUEST_METHODS_LIST: (id: number) =>
		emptyList(id, 'requestMethods'),
	ERROR_EMPTY_URL_FILTER: (id: number) => emptyKey(id, 'urlFilter'),
	ERROR_INVALID_REDIRECT_URL: (id: number) =>
		`${rule(id)} does not provide a valid URL for action.redirect.url key.`,
	ERROR_DUPLICATE_IDS: (id: number) => `${rule(id)} does not have a unique ID.`,
	ERROR_NON_ASCII_URL_FILTER: (id: number) => nonAscii(id, 'urlFilter'),
	ERROR_NON_ASCII_DOMAIN: (id: number) => nonAscii(id, 'domains'),
	ERROR_NON_ASCII_EXCLUDED_DOMAIN: (id: number) =>
		nonAscii(id, 'excludedDomains'),
	ERROR_NON_ASCII_INITIATOR_DOMAIN: (id: number) =>
		nonAscii(id, 'initiatorDomains'),
	ERROR_NON_ASCII_EXCLUDED_INITIATOR_DOMAIN: (id: number) =>
		nonAscii(id, 'excludedInitiatorDomains'),
	ERROR_NON_ASCII_REQUEST_DOMAIN: (id: number) =>
		nonAscii(id, 'requestDomains'),
	ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN: (id: number) =>
		nonAscii(id, 'excludedRequestDomains'),
	ERROR_NON_ASCII_TOP_DOMAIN: (id: number) => nonAscii(id, 'topDomains'),
	ERROR_NON_ASCII_EXCLUDED_TOP_DOMAIN: (id: number) =>
		nonAscii(id, 'excludedTopDomains'),
	ERROR_INVALID_URL_FILTER: (id: number) => invalidKey(id, 'urlFilter'),
	ERROR_INVALID_REDIRECT: (id: number) => invalidKey(id, 'action.redirect'),
	ERROR_INVALID_EXTENSION_PATH: (id: number) =>
		invalidKey(id, 'action.redirect.extensionPath'),
	ERROR_INVALID_TRANSFORM_SCHEME: (id: number) =>
		`${invalidKey(id, 'action.redirect.transform.scheme')} Allowed values are: [http, https, ftp, chrome-extension].`,
	ERROR_INVALID_TRANSFORM_PORT: (id: number) =>
		invalidKey(id, 'action.redirect.transform.port'),
	ERROR_INVALID_TRANSFORM_QUERY: (id: number) =>
		invalidKey(id, 'action.redirect.transform.query'),
	ERROR_INVALID_TRANSFORM_FRAGMENT: (id: number) =>
		invalidKey(id, 'action.redirect.transform.fragment'),
	ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED: (id: number) =>
		`${rule(id)} cannot specify both "action.redirect.transform.query" and "action.redirect.transform.queryTransform" keys.`,
	ERROR_JAVASCRIPT_REDIRECT: (id: number) =>
		`${invalidKey(id, 'action.redirect.url')} Redirects to javascript urls are not supported.`,
	ERROR_EMPTY_REGEX_FILTER: (id: number) => emptyKey(id, 'regexFilter'),
	ERROR_NON_ASCII_REGEX_FILTER: (id: number) => nonAscii(id, 'regexFilter'),
	ERROR_INVALID_REGEX_FILTER: (id: number) => invalidKey(id, 'regexFilter'),
	ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED: (id: number) =>
		`${rule(id)} does not specify a value for "action.requestHeaders" or "action.responseHeaders" key. At least one of these keys must be specified with a non-empty list.`,
	ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST: (id: number) =>
		emptyList(id, 'action.requestHeaders'),
	ERROR_EMPTY_MODIFY_RESPONSE_HEADERS_LIST: (id: number) =>
		emptyList(id, 'action.responseHeaders'),
	ERROR_INVALID_HEADER_TO_MODIFY_NAME: (id: number) =>
		`${rule(id)} must specify a valid header name to be modified.`,
	ERROR_INVALID_HEADER_TO_MODIFY_VALUE: (id: number) =>
		`${rule(id)} must provide a valid header value to be appended/set.`,
	ERROR_HEADER_VALUE_NOT_SPECIFIED: (id: number) =>
		`${rule(id)} must provide a value for a header to be appended/set.`,
	ERROR_HEADER_VALUE_PRESENT: (id: number) =>
		`${rule(id)} must not provide a header value for a header to be removed.`,
	ERROR_APPEND_INVALID_REQUEST_HEADER: (id: number) =>
		`${rule(id)} specifies an invalid request header to be appended. Only standard HTTP request headers that can specify multiple values for a single entry are supported.`,
	ERROR_REGEX_TOO_LARGE: (id: number) =>
		`${rule(id)} was skipped as the "regexFilter" value exceeded the 2KB memory limit when compiled. Learn more: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules`,
	ERROR_MULTIPLE_FILTERS_SPECIFIED: (id: number) =>
		`${rule(id)} can only specify one of "urlFilter" or "regexFilter" keys.`,
	ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER: (id: number) =>
		`${rule(id)} can't specify the "regexSubstitution" key without specifying the "regexFilter" key.`,
	ERROR_INVALID_REGEX_SUBSTITUTION: (id: number) =>
		invalidKey(id, 'action.redirect.regexSubstitution'),
	ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE: (id: number) =>
		`${rule(id)} is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.`,
	ERROR_EMPTY_TAB_IDS_LIST: (id: number) => emptyList(id, 'tabIds'),
	ERROR_TAB_IDS_ON_NON_SESSION_RULE: (id: number) =>
		`${rule(id)} specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.`,
	ERROR_TAB_ID_DUPLICATED: (id: number) =>
		`${rule(id)} includes and excludes the same tab ID.`,
	ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST: (id: number) =>
		emptyList(id, 'condition.responseHeaders'),
	ERROR_EMPTY_EXCLUDED_RESPONSE_HEADER_MATCHING_LIST: (id: number) =>
		emptyList(id, 'condition.excludedResponseHeaders'),
	ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME: (id: number) =>
		`${rule(id)} must specify a valid header name for "condition.responseHeaders" key`,
	ERROR_INVALID_MATCHING_EXCLUDED_RESPONSE_HEADER_NAME: (id: number) =>
		`${rule(id)} must specify a valid header name for "condition.excludedResponseHeaders" key`,
	ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE: (id: number) =>
		`${rule(id)} must specify a valid header value for "condition.responseHeaders" key`,
	ERROR_MATCHING_RESPONSE_HEADER_DUPLICATED: (id: number) =>
		`${rule(id)} includes and excludes the same response header.`,
	ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS: (id: number) =>
		`${rule(id)} which matches on response headers cannot modify request headers.`,
	/**
	 * not one of Chrome's ParseResults: the rule does not have the shape of
	 * the API's Rule type, which Chrome's generated schema code refuses
	 * before it parses (the message names the key, as Chrome's does)
	 */
	ERROR_SCHEMA: (id: number) => `${rule(id)} does not match the Rule type.`,
} as const;

export type ParseError = keyof typeof MESSAGES;

export function parseErrorMessage(
	error: ParseError,
	id: number,
	detail?: string,
): string {
	return error === 'ERROR_SCHEMA' && detail ? detail : MESSAGES[error](id);
}

/** the messages of rule-count and ruleset errors (constants.cc) */
export const LIMIT_MESSAGES = {
	dynamicRuleCount: 'Dynamic rule count exceeded.',
	dynamicUnsafeRuleCount: 'Dynamic unsafe rule count exceeded.',
	dynamicRegexRuleCount: 'Dynamic rule count for regex rules exceeded.',
	sessionRuleCount: 'Session rule count exceeded.',
	sessionUnsafeRuleCount: 'Session unsafe rule count exceeded.',
	sessionRegexRuleCount: 'Session rule count for regex rules exceeded.',
	invalidRulesetId: (id: string) => `Invalid ruleset id: ${id}.`,
	enabledRulesetsRuleCount:
		'The set of enabled rulesets exceeds the rule count limit.',
	enabledRulesetsRegexRuleCount:
		'The set of enabled rulesets exceeds the regular expression rule count limit.',
	enabledRulesetCount:
		'The number of enabled static rulesets exceeds the enabled ruleset count limit.',
	disabledStaticRuleCount:
		'The number of disabled static rules exceeds the disabled rule count limit.',
	incrementWithoutBadge:
		'Cannot increment action count unless displaying action count as badge text.',
	invalidTestUrl: 'Invalid test request URL.',
	invalidTestInitiator: 'Invalid test request initiator.',
	invalidTestTabId: 'Invalid test request tab ID.',
	invalidTestTopUrl: 'Invalid test request top URL.',
	listNotPassed: 'Rules file must contain a list.',
	ruleCountExceeded: 'Rule count exceeded. Some rules were ignored.',
	regexRuleCountExceeded:
		'Regular expression rule count exceeded. Some rules were ignored.',
	enabledRuleCountExceeded:
		'The number of enabled rules exceeds the API limits. Some rulesets will be ignored.',
	enabledRegexRuleCountExceeded:
		'The number of enabled regular expression rules exceeds the API limits. Some rulesets will be ignored.',
	ruleNotParsed: (where: string, error: string) =>
		`Rule with ${where} couldn't be parsed. Parse error: ${error}.`,
	tooManyParseFailures: (n: number) =>
		`Too many rule parse failures; Reporting the first ${n}.`,
	indexingRuleLimit: (id: string) =>
		`Ruleset with id ${id} exceeds the indexing rule limit and will be ignored.`,
} as const;
