// One rule, checked and normalized as Chrome indexes it
// (extensions/browser/api/declarative_net_request/indexed_rule.cc
// CreateIndexedRule, flat_ruleset_indexer.cc): the same checks in the same
// order, so a rule Chrome refuses is refused here with Chrome's message, and
// a rule it accepts becomes the record the matcher reads: masks for the
// resource types, methods and party, sorted domain lists, the url pattern
// lowercased unless it is case-sensitive, the regex translated once, the
// redirect resolved or its transform escaped, header names lowercased.

import { sortedDomains } from './domains';
import type { ParseError } from './errors';
import { checkRewriteString, compileRE2 } from './re2';
import type {
	HeaderInfo,
	ModifyHeaderInfo,
	RequestMethod,
	ResourceType,
	Rule,
	RuleActionType,
	URLTransform,
} from './types';
import { ANCHOR_SUBDOMAIN, parseUrlFilter, type Anchor } from './urlFilter';

// flat_rule::ElementType
export const ELEMENT_OTHER = 1;
export const ELEMENT_SCRIPT = 2;
export const ELEMENT_IMAGE = 4;
export const ELEMENT_STYLESHEET = 8;
export const ELEMENT_OBJECT = 16;
export const ELEMENT_XMLHTTPREQUEST = 32;
export const ELEMENT_OBJECT_SUBREQUEST = 64;
export const ELEMENT_SUBDOCUMENT = 128;
export const ELEMENT_PING = 256;
export const ELEMENT_MEDIA = 512;
export const ELEMENT_FONT = 1024;
export const ELEMENT_WEBSOCKET = 2048;
export const ELEMENT_WEBTRANSPORT = 4096;
export const ELEMENT_WEBBUNDLE = 8192;
export const ELEMENT_CSP_REPORT = 16384;
export const ELEMENT_MAIN_FRAME = 32768;
export const ELEMENT_ANY = 65535;
/** kDefaultFlatElementTypesMask: everything but main_frame (and the unused object subrequest) */
export const ELEMENT_DEFAULT = ELEMENT_ANY & ~ELEMENT_MAIN_FRAME;

export const ELEMENT_TYPES: Record<ResourceType, number> = {
	other: ELEMENT_OTHER,
	script: ELEMENT_SCRIPT,
	image: ELEMENT_IMAGE,
	stylesheet: ELEMENT_STYLESHEET,
	object: ELEMENT_OBJECT,
	xmlhttprequest: ELEMENT_XMLHTTPREQUEST,
	sub_frame: ELEMENT_SUBDOCUMENT,
	ping: ELEMENT_PING,
	media: ELEMENT_MEDIA,
	font: ELEMENT_FONT,
	websocket: ELEMENT_WEBSOCKET,
	webtransport: ELEMENT_WEBTRANSPORT,
	webbundle: ELEMENT_WEBBUNDLE,
	csp_report: ELEMENT_CSP_REPORT,
	main_frame: ELEMENT_MAIN_FRAME,
};

// flat_rule::RequestMethod
export const METHOD_CONNECT = 1;
export const METHOD_DELETE = 2;
export const METHOD_GET = 4;
export const METHOD_HEAD = 8;
export const METHOD_OPTIONS = 16;
export const METHOD_PATCH = 32;
export const METHOD_POST = 64;
export const METHOD_PUT = 128;
export const METHOD_OTHER_HTTP = 256;
export const METHOD_NON_HTTP = 512;
export const METHOD_ANY = 1023;

export const METHODS: Record<RequestMethod, number> = {
	connect: METHOD_CONNECT,
	delete: METHOD_DELETE,
	get: METHOD_GET,
	head: METHOD_HEAD,
	options: METHOD_OPTIONS,
	patch: METHOD_PATCH,
	post: METHOD_POST,
	put: METHOD_PUT,
	other: METHOD_OTHER_HTTP,
};

/** GetRequestMethod: a request's method bit (an http(s) URL's method by name, NON_HTTP otherwise) */
export function methodBit(isHttp: boolean, method: string | undefined): number {
	if (!isHttp) return METHOD_NON_HTTP;
	const name = (method || 'get').toLowerCase();
	return name !== 'other' && Object.hasOwn(METHODS, name)
		? METHODS[name as RequestMethod]
		: METHOD_OTHER_HTTP;
}

export const PARTY_FIRST = 1;
export const PARTY_THIRD = 2;

/** GetActionTypePriority */
export const ACTION_RANK: Record<RuleActionType, number> = {
	allow: 5,
	allowAllRequests: 4,
	block: 3,
	upgradeScheme: 2,
	redirect: 1,
	modifyHeaders: 0,
};

/** IsRuleSafe: the actions that count against no unsafe rule limit */
export const isSafeAction = (type: RuleActionType | undefined) =>
	type === 'block' ||
	type === 'allow' ||
	type === 'allowAllRequests' ||
	type === 'upgradeScheme';

/** ComputeIndexedRulePriority, with its 32 bit shift kept (priorities from 2^24 wrap) */
export const indexPriority = (priority: number, type: RuleActionType) =>
	(((priority << 8) >>> 0) | ACTION_RANK[type]) >>> 0;

/** a response header condition, values lowercased, empty value lists dropped as Chrome stores them */
export interface HeaderCondition {
	header: string;
	values?: string[];
	excludedValues?: string[];
}

/** a transform as Chrome stores it: empty components mean "clear", query params escaped */
export interface IndexedTransform {
	scheme?: string;
	host?: string;
	clearPort?: boolean;
	port?: string;
	clearPath?: boolean;
	path?: string;
	clearQuery?: boolean;
	query?: string;
	removeParams?: string[];
	addOrReplaceParams?: { key: string; value: string; replaceOnly: boolean }[];
	clearFragment?: boolean;
	fragment?: string;
	username?: string;
	password?: string;
}

export interface IndexedHeader {
	header: string;
	operation: 'append' | 'set' | 'remove';
	value?: string;
}

/**
 * A rule as the matcher reads it. Plain data (structured-clone and JSON
 * safe), so a compiled ruleset is stored and sent as is
 */
export interface IndexedRule {
	id: number;
	/** the index priority: priority << 8 | the action's rank */
	priority: number;
	action: RuleActionType;
	matchCase?: boolean;
	/** urlFilter, anchors stripped, lowercased unless matchCase */
	pattern?: string;
	left?: Anchor;
	right?: Anchor;
	/** regexFilter as a JS RegExp source and flags (re2.ts) */
	regex?: string;
	regexFlags?: string;
	/** lowercased literals one of which a URL must contain for the regex to match, null for none known */
	regexAtoms?: string[] | null;
	/** lowercased literals a URL must contain every one of */
	regexRequired?: string[];
	regexSubstitution?: string;
	/** the regexFilter itself, for a substitution whose group spans the RegExp would get wrong (re2.ts exact) */
	regexFilter?: string;
	elementTypes: number;
	methods: number;
	/** PARTY_FIRST | PARTY_THIRD */
	party: number;
	initiatorDomains?: string[];
	excludedInitiatorDomains?: string[];
	requestDomains?: string[];
	excludedRequestDomains?: string[];
	topDomains?: string[];
	excludedTopDomains?: string[];
	tabIds?: number[];
	excludedTabIds?: number[];
	responseHeaders?: HeaderCondition[];
	excludedResponseHeaders?: HeaderCondition[];
	/** a header condition matches on a value that needs host access (Chromium main's restriction) */
	headerValuesNeedHostAccess?: boolean;
	redirectUrl?: string;
	transform?: IndexedTransform;
	requestHeaders?: IndexedHeader[];
	responseHeadersToModify?: IndexedHeader[];
}

/** what CreateIndexedRule knows of the ruleset a rule is in */
export interface IndexContext {
	/** the base extensionPath redirects resolve against, chrome-extension://<id>/ */
	extensionBase: string;
	/** session rules may use tabIds */
	session?: boolean;
}

export type IndexResult =
	| { ok: true; rule: IndexedRule; regexSize?: number }
	| { ok: false; error: ParseError; detail?: string };

// The JSON shape the generated parser (Rule::FromValue) accepts. Unknown keys
// are ignored, as Chrome ignores them; wrong types and unknown enum values
// are refused.

const RESOURCE_TYPES = new Set(Object.keys(ELEMENT_TYPES));
const REQUEST_METHODS = new Set(Object.keys(METHODS));
const ACTION_TYPES = new Set(Object.keys(ACTION_RANK));
const OPERATIONS = new Set(['append', 'set', 'remove']);
const DOMAIN_TYPES = new Set(['firstParty', 'thirdParty']);

class SchemaError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown) =>
	typeof value === 'number' &&
	Number.isInteger(value) &&
	Math.abs(value) <= 2147483647;

/** base::Value::GetTypeName of a JSON value */
const typeName = (value: unknown) =>
	value === null
		? 'null'
		: Array.isArray(value)
			? 'list'
			: typeof value === 'object'
				? 'dictionary'
				: typeof value === 'number'
					? Number.isInteger(value)
						? 'integer'
						: 'double'
					: typeof value;

/**
 * the json_schema_compiler's error: "'id': expected id, got string" (the
 * generated code names an integer by its key, a dictionary and a list by
 * their type), when the value is known
 */
function expect(ok: boolean, path: string, what: string, ...value: [unknown?]) {
	if (ok) return;
	throw new SchemaError(
		`'${path}': expected ${what}${value.length ? `, got ${typeName(value[0])}` : ''}`,
	);
}
function optString(object: Record<string, unknown>, key: string, path: string) {
	if (object[key] !== undefined)
		expect(
			typeof object[key] === 'string',
			`${path}.${key}`,
			'string',
			object[key],
		);
}
function optBool(object: Record<string, unknown>, key: string, path: string) {
	if (object[key] !== undefined)
		expect(
			typeof object[key] === 'boolean',
			`${path}.${key}`,
			'boolean',
			object[key],
		);
}
function optList(
	object: Record<string, unknown>,
	key: string,
	path: string,
	item: (value: unknown) => boolean,
	what: string,
) {
	const value = object[key];
	if (value === undefined) return;
	expect(Array.isArray(value), `${path}.${key}`, 'list', value);
	(value as unknown[]).forEach((entry, i) =>
		expect(item(entry), `${path}.${key}[${i}]`, what),
	);
}
const isString = (value: unknown) => typeof value === 'string';

function checkHeaderInfo(value: unknown) {
	if (!isObject(value)) return false;
	if (typeof value.header !== 'string') return false;
	for (const key of ['values', 'excludedValues'])
		if (
			value[key] !== undefined &&
			!(Array.isArray(value[key]) && (value[key] as unknown[]).every(isString))
		)
			return false;
	return true;
}

function checkModifyHeaderInfo(value: unknown) {
	if (!isObject(value)) return false;
	if (typeof value.header !== 'string') return false;
	if (!OPERATIONS.has(value.operation as string)) return false;
	for (const key of ['value', 'regexFilter', 'regexSubstitution'])
		if (value[key] !== undefined && typeof value[key] !== 'string')
			return false;
	if (value.regexOptions !== undefined) {
		if (!isObject(value.regexOptions)) return false;
		const matchAll = value.regexOptions.matchAll;
		if (matchAll !== undefined && typeof matchAll !== 'boolean') return false;
	}
	return true;
}

/** throws SchemaError when `value` is not a Rule */
export function checkSchema(value: unknown): asserts value is Rule {
	expect(isObject(value), 'rule', 'dictionary', value);
	const rule = value as Record<string, unknown>;
	expect(isInt(rule.id), 'id', 'id', rule.id);
	if (rule.priority !== undefined)
		expect(isInt(rule.priority), 'priority', 'priority', rule.priority);
	expect(isObject(rule.condition), 'condition', 'dictionary', rule.condition);
	expect(isObject(rule.action), 'action', 'dictionary', rule.action);
	const condition = rule.condition as Record<string, unknown>;
	optString(condition, 'urlFilter', 'condition');
	optString(condition, 'regexFilter', 'condition');
	optBool(condition, 'isUrlFilterCaseSensitive', 'condition');
	for (const key of [
		'initiatorDomains',
		'excludedInitiatorDomains',
		'requestDomains',
		'excludedRequestDomains',
		'topDomains',
		'excludedTopDomains',
		'domains',
		'excludedDomains',
	])
		optList(condition, key, 'condition', isString, 'string');
	for (const key of ['resourceTypes', 'excludedResourceTypes'])
		optList(
			condition,
			key,
			'condition',
			(entry) => RESOURCE_TYPES.has(entry as string),
			'ResourceType',
		);
	for (const key of ['requestMethods', 'excludedRequestMethods'])
		optList(
			condition,
			key,
			'condition',
			(entry) => REQUEST_METHODS.has(entry as string),
			'RequestMethod',
		);
	if (condition.domainType !== undefined)
		expect(
			DOMAIN_TYPES.has(condition.domainType as string),
			'condition.domainType',
			'DomainType',
		);
	for (const key of ['tabIds', 'excludedTabIds'])
		optList(condition, key, 'condition', isInt, 'integer');
	for (const key of ['responseHeaders', 'excludedResponseHeaders'])
		optList(condition, key, 'condition', checkHeaderInfo, 'HeaderInfo');
	const action = rule.action as Record<string, unknown>;
	expect(
		ACTION_TYPES.has(action.type as string),
		'action.type',
		'RuleActionType',
	);
	if (action.redirect !== undefined) {
		expect(
			isObject(action.redirect),
			'action.redirect',
			'dictionary',
			action.redirect,
		);
		const redirect = action.redirect as Record<string, unknown>;
		optString(redirect, 'url', 'action.redirect');
		optString(redirect, 'extensionPath', 'action.redirect');
		optString(redirect, 'regexSubstitution', 'action.redirect');
		if (redirect.transform !== undefined) {
			expect(
				isObject(redirect.transform),
				'action.redirect.transform',
				'dictionary',
				redirect.transform,
			);
			const transform = redirect.transform as Record<string, unknown>;
			for (const key of [
				'scheme',
				'host',
				'port',
				'path',
				'query',
				'fragment',
				'username',
				'password',
			])
				optString(transform, key, 'action.redirect.transform');
			if (transform.queryTransform !== undefined) {
				const path = 'action.redirect.transform.queryTransform';
				expect(
					isObject(transform.queryTransform),
					path,
					'dictionary',
					transform.queryTransform,
				);
				const query = transform.queryTransform as Record<string, unknown>;
				optList(query, 'removeParams', path, isString, 'string');
				optList(
					query,
					'addOrReplaceParams',
					path,
					(entry) =>
						isObject(entry) &&
						typeof entry.key === 'string' &&
						typeof entry.value === 'string' &&
						(entry.replaceOnly === undefined ||
							typeof entry.replaceOnly === 'boolean'),
					'QueryKeyValue',
				);
			}
		}
	}
	for (const key of ['requestHeaders', 'responseHeaders'])
		optList(action, key, 'action', checkModifyHeaderInfo, 'ModifyHeaderInfo');
}

// net::HttpUtil
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const isValidHeaderName = (name: string) => TOKEN.test(name);
export const isValidHeaderValue = (value: string) => !/[\0\r\n]/.test(value);

/** kDNRRequestHeaderAppendAllowList: the request headers append may touch, and the delimiter it joins with */
export const REQUEST_APPEND_DELIMITERS: Record<string, string> = {
	accept: ', ',
	'accept-encoding': ', ',
	'accept-language': ', ',
	'access-control-request-headers': ', ',
	'cache-control': ', ',
	connection: ', ',
	'content-language': ', ',
	cookie: '; ',
	forwarded: ', ',
	'if-match': ', ',
	'if-none-match': ', ',
	'keep-alive': ', ',
	range: ', ',
	te: ', ',
	trailer: '',
	'transfer-encoding': ', ',
	upgrade: ', ',
	'user-agent': ' ',
	via: ', ',
	'want-digest': ', ',
	'x-forwarded-for': ', ',
};

const isAscii = (text: string) => !/[^\0-\x7f]/.test(text);

/** GURL validity, as near as WHATWG parsing gets */
export function parseUrl(text: string): URL | null {
	try {
		return new URL(text);
	} catch {
		return null;
	}
}

/** base::EscapeQueryParamValue(text, use_plus=true): kQueryCharmap keeps A-Z a-z 0-9 !'()*-._~ */
export function escapeQueryParam(text: string): string {
	let safe = text;
	try {
		return encodeURIComponent(safe).replace(/%20/g, '+');
	} catch {
		// a lone surrogate: Chrome's string came through UTF-8 as U+FFFD
		safe = safe.replace(
			/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
			'�',
		);
		return encodeURIComponent(safe).replace(/%20/g, '+');
	}
}

const ALLOWED_TRANSFORM_SCHEMES = new Set([
	'http',
	'https',
	'ftp',
	'chrome-extension',
]);

/** base::StringToUint and a 65535 bound */
const isValidPort = (port: string | undefined) =>
	port === undefined ||
	port === '' ||
	(/^\+?\d+$/.test(port) && Number(port) <= 65535);

const emptyOrStartsWith = (text: string | undefined, start: string) =>
	text === undefined || text === '' || text[0] === start;

function validateTransform(transform: URLTransform): ParseError | null {
	if (
		transform.scheme !== undefined &&
		!ALLOWED_TRANSFORM_SCHEMES.has(transform.scheme)
	)
		return 'ERROR_INVALID_TRANSFORM_SCHEME';
	if (!isValidPort(transform.port)) return 'ERROR_INVALID_TRANSFORM_PORT';
	if (!emptyOrStartsWith(transform.query, '?'))
		return 'ERROR_INVALID_TRANSFORM_QUERY';
	if (!emptyOrStartsWith(transform.fragment, '#'))
		return 'ERROR_INVALID_TRANSFORM_FRAGMENT';
	if (transform.query !== undefined && transform.queryTransform !== undefined)
		return 'ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED';
	return null;
}

/** BuildTransformOffset */
function indexTransform(transform: URLTransform): IndexedTransform {
	const out: IndexedTransform = {};
	if (transform.scheme !== undefined) out.scheme = transform.scheme;
	if (transform.host !== undefined) out.host = transform.host;
	if (transform.port === '') out.clearPort = true;
	else if (transform.port !== undefined) out.port = transform.port;
	if (transform.path === '') out.clearPath = true;
	else if (transform.path !== undefined) out.path = transform.path;
	if (transform.query === '') out.clearQuery = true;
	else if (transform.query !== undefined) out.query = transform.query.slice(1);
	if (transform.fragment === '') out.clearFragment = true;
	else if (transform.fragment !== undefined)
		out.fragment = transform.fragment.slice(1);
	if (transform.username !== undefined) out.username = transform.username;
	if (transform.password !== undefined) out.password = transform.password;
	const query = transform.queryTransform;
	if (query?.removeParams) {
		// escaped, sorted by code unit and deduplicated (a std::set<std::string>)
		const set = [...new Set(query.removeParams.map(escapeQueryParam))].sort(
			(a, b) => (a < b ? -1 : a > b ? 1 : 0),
		);
		if (set.length) out.removeParams = set;
	}
	if (query?.addOrReplaceParams?.length)
		out.addOrReplaceParams = query.addOrReplaceParams.map((pair) => ({
			key: escapeQueryParam(pair.key),
			value: escapeQueryParam(pair.value),
			replaceOnly: !!pair.replaceOnly,
		}));
	return out;
}

interface RegexCheck {
	error?: ParseError;
	source?: string;
	flags?: string;
	atoms?: string[] | null;
	required?: string[];
	exact?: boolean;
	size?: number;
}

/** ValidateRegex */
function validateRegex(
	caseSensitive: boolean,
	filter: string | undefined,
	substitution: string | undefined,
): RegexCheck {
	if (filter === undefined)
		return substitution !== undefined
			? { error: 'ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER' }
			: {};
	if (filter === '') return { error: 'ERROR_EMPTY_REGEX_FILTER' };
	if (!isAscii(filter)) return { error: 'ERROR_NON_ASCII_REGEX_FILTER' };
	const compiled = compileRE2(filter, {
		caseSensitive,
		requireCapturing: substitution !== undefined,
	});
	if (!compiled.ok)
		return {
			error:
				compiled.reason === 'memoryLimitExceeded'
					? 'ERROR_REGEX_TOO_LARGE'
					: 'ERROR_INVALID_REGEX_FILTER',
		};
	if (
		substitution !== undefined &&
		!checkRewriteString(substitution, compiled.groups)
	)
		return { error: 'ERROR_INVALID_REGEX_SUBSTITUTION' };
	return {
		source: compiled.source,
		flags: compiled.flags,
		atoms: compiled.anyOf,
		required: compiled.required,
		exact: compiled.exact,
		size: compiled.programSize,
	};
}

function validateModifyHeaders(
	headers: ModifyHeaderInfo[],
	request: boolean,
): ParseError | null {
	if (!headers.length)
		return request
			? 'ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST'
			: 'ERROR_EMPTY_MODIFY_RESPONSE_HEADERS_LIST';
	for (const info of headers) {
		if (!isValidHeaderName(info.header))
			return 'ERROR_INVALID_HEADER_TO_MODIFY_NAME';
		if (
			request &&
			info.operation === 'append' &&
			!(info.header.toLowerCase() in REQUEST_APPEND_DELIMITERS)
		)
			return 'ERROR_APPEND_INVALID_REQUEST_HEADER';
		if (info.value !== undefined) {
			if (!isValidHeaderValue(info.value))
				return 'ERROR_INVALID_HEADER_TO_MODIFY_VALUE';
			if (info.operation === 'remove') return 'ERROR_HEADER_VALUE_PRESENT';
		} else if (info.operation === 'append' || info.operation === 'set')
			return 'ERROR_HEADER_VALUE_NOT_SPECIFIED';
		const regex = validateRegex(
			false,
			info.regexFilter,
			info.regexSubstitution,
		);
		if (regex.error) return regex.error;
	}
	return null;
}

function validateHeaderMatching(
	included: HeaderInfo[],
	excluded: HeaderInfo[],
): ParseError | null {
	const valuesValid = (info: HeaderInfo) =>
		(info.values || []).every(isValidHeaderValue) &&
		(info.excludedValues || []).every(isValidHeaderValue);
	const names = new Set<string>();
	for (const info of included) {
		if (!isValidHeaderName(info.header))
			return 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME';
		if (!valuesValid(info))
			return 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE';
		names.add(info.header);
	}
	for (const info of excluded) {
		if (!isValidHeaderName(info.header))
			return 'ERROR_INVALID_MATCHING_EXCLUDED_RESPONSE_HEADER_NAME';
		if (!valuesValid(info))
			return 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE';
		if (!info.values && !info.excludedValues && names.has(info.header))
			return 'ERROR_MATCHING_RESPONSE_HEADER_DUPLICATED';
	}
	return null;
}

/** CanMatchResponseHeaderValuesWithoutHostPermissions: CORS-safelisted response headers and content-encoding */
const VALUES_WITHOUT_HOST_ACCESS = new Set([
	'cache-control',
	'content-language',
	'content-length',
	'content-type',
	'expires',
	'last-modified',
	'pragma',
	'content-encoding',
]);

function indexHeaderConditions(infos: HeaderInfo[]): HeaderCondition[] {
	return infos.map((info) => {
		const out: HeaderCondition = { header: info.header };
		// BuildVectorOfSharedStringsImpl stores no empty list: [] reads as absent
		if (info.values?.length)
			out.values = info.values.map((v) => v.toLowerCase());
		if (info.excludedValues?.length)
			out.excludedValues = info.excludedValues.map((v) => v.toLowerCase());
		return out;
	});
}

const needsHostAccess = (infos: HeaderInfo[]) =>
	infos.some(
		(info) =>
			(!!info.values?.length || !!info.excludedValues?.length) &&
			!VALUES_WITHOUT_HOST_ACCESS.has(info.header.toLowerCase()),
	);

function canonicalize(
	domains: string[] | undefined,
): string[] | null | undefined {
	if (!domains) return undefined;
	if (!domains.every(isAscii)) return null;
	return sortedDomains(domains);
}

const maskOf = <T extends string>(
	list: T[] | undefined,
	table: Record<T, number>,
) => (list || []).reduce((mask, entry) => mask | table[entry], 0);

const indexHeaders = (headers: ModifyHeaderInfo[]): IndexedHeader[] =>
	headers.map((info) => {
		const out: IndexedHeader = {
			header: info.header.toLowerCase(),
			operation: info.operation,
		};
		if (info.operation !== 'remove' && info.value !== undefined)
			out.value = info.value;
		return out;
	});

/** IndexedRule::CreateIndexedRule */
export function indexRule(input: unknown, context: IndexContext): IndexResult {
	try {
		checkSchema(input);
	} catch (error) {
		if (error instanceof SchemaError)
			return { ok: false, error: 'ERROR_SCHEMA', detail: error.message };
		throw error;
	}
	const rule = input;
	const { condition, action } = rule;
	if (rule.id < 1) return { ok: false, error: 'ERROR_INVALID_RULE_ID' };
	const priority = rule.priority ?? 1;
	if (priority < 1) return { ok: false, error: 'ERROR_INVALID_RULE_PRIORITY' };

	const out: IndexedRule = {
		id: rule.id,
		priority: indexPriority(priority, action.type),
		action: action.type,
		elementTypes: 0,
		methods: 0,
		party: 0,
	};

	let regexSubstitution: string | undefined;
	if (action.type === 'redirect') {
		const redirect = action.redirect;
		if (!redirect) return { ok: false, error: 'ERROR_INVALID_REDIRECT' };
		if (redirect.url !== undefined) {
			const url = parseUrl(redirect.url);
			if (!url) return { ok: false, error: 'ERROR_INVALID_REDIRECT_URL' };
			if (url.protocol === 'javascript:')
				return { ok: false, error: 'ERROR_JAVASCRIPT_REDIRECT' };
			out.redirectUrl = redirect.url;
		} else if (redirect.extensionPath !== undefined) {
			if (redirect.extensionPath[0] !== '/')
				return { ok: false, error: 'ERROR_INVALID_EXTENSION_PATH' };
			let resolved: URL;
			try {
				resolved = new URL(redirect.extensionPath, context.extensionBase);
			} catch {
				return { ok: false, error: 'ERROR_INVALID_EXTENSION_PATH' };
			}
			out.redirectUrl = resolved.href;
		} else if (redirect.transform !== undefined) {
			const error = validateTransform(redirect.transform);
			if (error) return { ok: false, error };
			out.transform = indexTransform(redirect.transform);
		} else if (redirect.regexSubstitution !== undefined) {
			if (redirect.regexSubstitution === '')
				return { ok: false, error: 'ERROR_INVALID_REGEX_SUBSTITUTION' };
			regexSubstitution = redirect.regexSubstitution;
		} else return { ok: false, error: 'ERROR_INVALID_REDIRECT' };
	}

	const emptyChecks: [unknown[] | undefined, ParseError][] = [
		[condition.domains, 'ERROR_EMPTY_DOMAINS_LIST'],
		[condition.initiatorDomains, 'ERROR_EMPTY_INITIATOR_DOMAINS_LIST'],
		[condition.requestDomains, 'ERROR_EMPTY_REQUEST_DOMAINS_LIST'],
		[condition.topDomains, 'ERROR_EMPTY_TOP_DOMAINS_LIST'],
		[condition.resourceTypes, 'ERROR_EMPTY_RESOURCE_TYPES_LIST'],
		[condition.requestMethods, 'ERROR_EMPTY_REQUEST_METHODS_LIST'],
		[condition.tabIds, 'ERROR_EMPTY_TAB_IDS_LIST'],
	];
	for (const [list, error] of emptyChecks)
		if (list && !list.length) return { ok: false, error };

	if (!context.session && (condition.tabIds || condition.excludedTabIds))
		return { ok: false, error: 'ERROR_TAB_IDS_ON_NON_SESSION_RULE' };
	if (condition.urlFilter !== undefined && condition.regexFilter !== undefined)
		return { ok: false, error: 'ERROR_MULTIPLE_FILTERS_SPECIFIED' };

	const matchCase = !!condition.isUrlFilterCaseSensitive;
	const regex = validateRegex(
		matchCase,
		condition.regexFilter,
		regexSubstitution,
	);
	if (regex.error) return { ok: false, error: regex.error };

	if (condition.urlFilter !== undefined) {
		if (condition.urlFilter === '')
			return { ok: false, error: 'ERROR_EMPTY_URL_FILTER' };
		if (!isAscii(condition.urlFilter))
			return { ok: false, error: 'ERROR_NON_ASCII_URL_FILTER' };
	}

	if (matchCase) out.matchCase = true;
	out.party =
		condition.domainType === 'firstParty'
			? 1
			: condition.domainType === 'thirdParty'
				? 2
				: 3;

	// ComputeRequestMethods
	const includedMethods = maskOf(condition.requestMethods, METHODS);
	const excludedMethods = maskOf(condition.excludedRequestMethods, METHODS);
	if (includedMethods & excludedMethods)
		return { ok: false, error: 'ERROR_REQUEST_METHOD_DUPLICATED' };
	out.methods = includedMethods
		? includedMethods
		: excludedMethods
			? METHOD_ANY & ~excludedMethods
			: METHOD_ANY;

	// ComputeElementTypes
	const includedTypes = maskOf(condition.resourceTypes, ELEMENT_TYPES);
	const excludedTypes = maskOf(condition.excludedResourceTypes, ELEMENT_TYPES);
	if (excludedTypes === (ELEMENT_ANY & ~ELEMENT_OBJECT_SUBREQUEST))
		return { ok: false, error: 'ERROR_NO_APPLICABLE_RESOURCE_TYPES' };
	if (includedTypes & excludedTypes)
		return { ok: false, error: 'ERROR_RESOURCE_TYPE_DUPLICATED' };
	if (action.type === 'allowAllRequests') {
		const frames = ELEMENT_MAIN_FRAME | ELEMENT_SUBDOCUMENT;
		if (!includedTypes || (includedTypes | frames) !== frames)
			return {
				ok: false,
				error: 'ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE',
			};
	}
	out.elementTypes = includedTypes
		? includedTypes
		: excludedTypes
			? ELEMENT_ANY & ~excludedTypes
			: ELEMENT_DEFAULT;

	if (condition.domains && condition.initiatorDomains)
		return {
			ok: false,
			error: 'ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED',
		};
	if (condition.excludedDomains && condition.excludedInitiatorDomains)
		return {
			ok: false,
			error:
				'ERROR_EXCLUDED_DOMAINS_AND_EXCLUDED_INITIATOR_DOMAINS_BOTH_SPECIFIED',
		};

	const domainLists: [
		string[] | undefined,
		ParseError,
		keyof Pick<
			IndexedRule,
			| 'initiatorDomains'
			| 'excludedInitiatorDomains'
			| 'requestDomains'
			| 'excludedRequestDomains'
			| 'topDomains'
			| 'excludedTopDomains'
		>,
	][] = [
		[condition.domains, 'ERROR_NON_ASCII_DOMAIN', 'initiatorDomains'],
		[
			condition.initiatorDomains,
			'ERROR_NON_ASCII_INITIATOR_DOMAIN',
			'initiatorDomains',
		],
		[
			condition.excludedDomains,
			'ERROR_NON_ASCII_EXCLUDED_DOMAIN',
			'excludedInitiatorDomains',
		],
		[
			condition.excludedInitiatorDomains,
			'ERROR_NON_ASCII_EXCLUDED_INITIATOR_DOMAIN',
			'excludedInitiatorDomains',
		],
		[
			condition.requestDomains,
			'ERROR_NON_ASCII_REQUEST_DOMAIN',
			'requestDomains',
		],
		[
			condition.excludedRequestDomains,
			'ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN',
			'excludedRequestDomains',
		],
		[condition.topDomains, 'ERROR_NON_ASCII_TOP_DOMAIN', 'topDomains'],
		[
			condition.excludedTopDomains,
			'ERROR_NON_ASCII_EXCLUDED_TOP_DOMAIN',
			'excludedTopDomains',
		],
	];
	for (const [list, error, key] of domainLists) {
		const sorted = canonicalize(list);
		if (sorted === null) return { ok: false, error };
		// an empty list is stored as none (excluded lists may be empty)
		if (sorted?.length) out[key] = sorted;
	}

	// tab ids: a sorted set; excluded ones are dropped when included ones are given
	const tabIds = condition.tabIds
		? [...new Set(condition.tabIds)].sort((a, b) => a - b)
		: [];
	const excludedTabIds = condition.excludedTabIds
		? [...new Set(condition.excludedTabIds)].sort((a, b) => a - b)
		: [];
	if (tabIds.some((id) => excludedTabIds.includes(id)))
		return { ok: false, error: 'ERROR_TAB_ID_DUPLICATED' };
	if (tabIds.length) out.tabIds = tabIds;
	else if (excludedTabIds.length) out.excludedTabIds = excludedTabIds;

	// response header matching (kDeclarativeNetRequestResponseHeaderMatching is on)
	if (condition.responseHeaders && !condition.responseHeaders.length)
		return { ok: false, error: 'ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST' };
	if (
		condition.excludedResponseHeaders &&
		!condition.excludedResponseHeaders.length
	)
		return {
			ok: false,
			error: 'ERROR_EMPTY_EXCLUDED_RESPONSE_HEADER_MATCHING_LIST',
		};
	{
		const error = validateHeaderMatching(
			condition.responseHeaders || [],
			condition.excludedResponseHeaders || [],
		);
		if (error) return { ok: false, error };
	}
	if (condition.responseHeaders)
		out.responseHeaders = indexHeaderConditions(condition.responseHeaders);
	if (condition.excludedResponseHeaders)
		out.excludedResponseHeaders = indexHeaderConditions(
			condition.excludedResponseHeaders,
		);
	if (
		needsHostAccess(condition.responseHeaders || []) ||
		needsHostAccess(condition.excludedResponseHeaders || [])
	)
		out.headerValuesNeedHostAccess = true;

	if (condition.regexFilter !== undefined) {
		out.regex = regex.source;
		out.regexFlags = regex.flags;
		out.regexAtoms = regex.atoms ?? null;
		if (regex.required?.length) out.regexRequired = regex.required;
		if (regexSubstitution !== undefined) {
			out.regexSubstitution = regexSubstitution;
			if (!regex.exact) out.regexFilter = condition.regexFilter;
		}
	} else {
		const parsed = parseUrlFilter(condition.urlFilter ?? '');
		// url_pattern_index doesn't support "||*xyz"
		if (parsed.left === ANCHOR_SUBDOMAIN && parsed.pattern[0] === '*')
			return { ok: false, error: 'ERROR_INVALID_URL_FILTER' };
		out.pattern = matchCase ? parsed.pattern : parsed.pattern.toLowerCase();
		if (parsed.left) out.left = parsed.left;
		if (parsed.right) out.right = parsed.right;
	}

	if (action.type === 'modifyHeaders') {
		if (!action.requestHeaders && !action.responseHeaders)
			return { ok: false, error: 'ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED' };
		if (action.requestHeaders) {
			if (out.responseHeaders || out.excludedResponseHeaders)
				return {
					ok: false,
					error: 'ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS',
				};
			const error = validateModifyHeaders(action.requestHeaders, true);
			if (error) return { ok: false, error };
			out.requestHeaders = indexHeaders(action.requestHeaders);
		}
		if (action.responseHeaders) {
			const error = validateModifyHeaders(action.responseHeaders, false);
			if (error) return { ok: false, error };
			out.responseHeadersToModify = indexHeaders(action.responseHeaders);
		}
	}

	return { ok: true, rule: out, regexSize: regex.size };
}

/** IsBeforeRequestRule: a rule with no response header condition matches before the request goes out */
export const isBeforeRequestRule = (rule: IndexedRule) =>
	!rule.responseHeaders && !rule.excludedResponseHeaders;
