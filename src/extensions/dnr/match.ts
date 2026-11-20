// The matcher: Chrome's RulesetMatcher, CompositeMatcher and RulesetManager
// (extensions/browser/api/declarative_net_request) over an index of the
// shape url_pattern_index uses. An extension's rulesets are indexed in
// groups: the rulesets a change adds get a group of their own, so an
// update (updateDynamicRules, a ruleset enabled) indexes only what it adds,
// and what it removes is skipped until its group is rebuilt (once most of
// the group is gone) or merged (once an extension has many).
//
// Every rule of an extension, of every ruleset, is filed once per stage
// (before the request, or with its response headers) under one key: the
// rarest five-character n-gram of its urlFilter (Chromium's
// GetMostDistinctiveNGram), else each of its requestDomains, else each of
// its initiatorDomains, else a short list every request scans. Regex rules
// are filed under an n-gram of each literal the regex cannot match without
// (re2.ts), so most of them are never run. A request computes its URL's
// n-grams and host suffixes once and visits each bucket they name; each
// rule is visited at most once.
//
// What comes out is what Chrome decides, rule for rule: the highest
// priority rule of each ruleset's main index, of its allowAllRequests index
// and of its regex rules (an upgrade of an https URL or a redirect to the
// same URL still masks the rules under it), the frame's allowAllRequests
// state, the allow rules carried from the stage before, then the
// extensions against each other (block, then redirect, then allow, the most
// recently installed winning a tie) and the modifyHeaders rules above every
// allow.

import { getDomain } from '../../suffix';
import { transformUrl, upgradeUrl, type HeaderLines } from './actions';
import {
	bucketKey,
	domainHash,
	hostMatchesLists,
	suffixHashes,
} from './domains';
import type { IndexedRule } from './indexRule';
import {
	ELEMENT_IMAGE,
	ELEMENT_MAIN_FRAME,
	ELEMENT_SUBDOCUMENT,
	ELEMENT_TYPES,
	ELEMENT_WEBSOCKET,
	ELEMENT_WEBTRANSPORT,
	isBeforeRequestRule,
	methodBit,
	PARTY_FIRST,
	PARTY_THIRD,
	type HeaderCondition,
} from './indexRule';
import { replaceFirst } from './re2';
import type { DnrAction, DnrRequest, ResourceType } from './types';
import {
	matchPattern,
	NGRAM_SIZE,
	patternNgrams,
	preparePattern,
	textNgrams,
	urlInfo,
	type UrlInfo,
	type UrlPattern,
} from './urlFilter';

export const STAGE_BEFORE_REQUEST = 0;
export const STAGE_HEADERS_RECEIVED = 1;
export type Stage = 0 | 1;

/** PermissionsData::PageAccess */
export type PageAccess = 'allowed' | 'withheld' | 'denied';

const KIND_MAIN = 0;
const KIND_ALLOW_ALL = 1;
const KIND_MODIFY = 2;

/** url::kMaxURLChars: the url pattern index ignores longer URLs (the regex rules do not) */
const MAX_URL_CHARS = 2 * 1024 * 1024;

/** a rule loaded into an extension's index */
class Entry {
	seen = 0;
	readonly kind: number;
	readonly priority: number;
	readonly id: number;
	readonly rank: number;
	readonly pattern: UrlPattern | null;
	regex: RegExp | null = null;
	constructor(
		readonly rule: IndexedRule,
		readonly ruleset: RulesetState,
		rank: number,
	) {
		this.kind =
			rule.action === 'modifyHeaders'
				? KIND_MODIFY
				: rule.action === 'allowAllRequests'
					? KIND_ALLOW_ALL
					: KIND_MAIN;
		this.priority = rule.priority;
		this.id = rule.id;
		this.rank = rank;
		this.pattern =
			rule.regex === undefined
				? preparePattern(rule.pattern ?? '', rule.left ?? 0, rule.right ?? 0)
				: null;
	}
	/** the RE2 translation, compiled on first use */
	get re(): RegExp {
		return (this.regex ??= new RegExp(this.rule.regex!, this.rule.regexFlags));
	}
}

/** (index priority, ruleset id, rule id), larger first: Chrome's RequestAction order */
const entryGreater = (a: Entry, b: Entry) =>
	a.priority !== b.priority
		? a.priority > b.priority
		: a.rank !== b.rank
			? a.rank > b.rank
			: a.id > b.id;
const entryOrder = (a: Entry, b: Entry) =>
	entryGreater(a, b) ? -1 : entryGreater(b, a) ? 1 : 0;

export const actionGreater = (a: DnrAction, b: DnrAction) =>
	a.priority !== b.priority
		? a.priority > b.priority
		: (a.rank ?? 0) !== (b.rank ?? 0)
			? (a.rank ?? 0) > (b.rank ?? 0)
			: a.ruleId > b.ruleId;

/** GetMaxPriorityAction: ties go to the second */
export function maxAction(
	a: DnrAction | null,
	b: DnrAction | null,
): DnrAction | null {
	if (!a) return b;
	if (!b) return a;
	return actionGreater(a, b) ? a : b;
}

export const isAllow = (action: DnrAction) =>
	action.type === 'allow' || action.type === 'allowAllRequests';

/** an n-gram this many rules' patterns hold is one most URLs hold too */
const COMMON_NGRAM = 256;

/**
 * Buckets by a small integer key (an n-gram's or a domain's hash), once
 * built: open addressing over Int32Arrays (NGramHashTableProber's shape),
 * behind a bitmap of the keys small enough to stay in cache, so the ~100
 * probes of a URL's n-grams mostly stop at one bit
 */
class IntTable {
	private keys: Int32Array;
	private slots: Int32Array;
	private bits: Int32Array;
	private bitMask: number;
	private lists: Entry[][] = [];
	private mask: number;
	readonly size: number;

	constructor(map: Map<number, Entry[]>) {
		let capacity = 16;
		while (capacity < map.size * 2) capacity *= 2;
		this.mask = capacity - 1;
		this.keys = new Int32Array(capacity).fill(-1);
		this.slots = new Int32Array(capacity);
		// eight bits a key: about one probe in eight passes the bitmap in vain
		let bits = 1024;
		while (bits < map.size * 8) bits *= 2;
		this.bits = new Int32Array(bits >>> 5);
		this.bitMask = bits - 1;
		this.size = map.size;
		for (const [key, list] of map) {
			const bit = (key >>> 7) & this.bitMask;
			this.bits[bit >>> 5] |= 1 << (bit & 31);
			let at = key & this.mask;
			while (this.keys[at] !== -1) at = (at + 1) & this.mask;
			this.keys[at] = key;
			this.slots[at] = this.lists.length;
			this.lists.push(list);
		}
	}

	get(key: number): Entry[] | undefined {
		const bit = (key >>> 7) & this.bitMask;
		if (!(this.bits[bit >>> 5] & (1 << (bit & 31)))) return undefined;
		const keys = this.keys;
		for (let at = key & this.mask; ; at = (at + 1) & this.mask) {
			const found = keys[at];
			if (found === key) return this.lists[this.slots[at]];
			if (found === -1) return undefined;
		}
	}

	values(): Entry[][] {
		return this.lists;
	}
}

/** one stage's buckets */
class StageIndex {
	table = new IntTable(new Map());
	requestTable = new IntTable(new Map());
	initiatorTable = new IntTable(new Map());
	readonly ngrams = new Map<number, Entry[]>();
	private requestDomains = new Map<number, Entry[]>();
	private initiatorDomains = new Map<number, Entry[]>();
	readonly fallback: Entry[] = [];
	count = 0;

	private file<K>(map: Map<K, Entry[]>, key: K, entry: Entry) {
		const list = map.get(key);
		if (list) list.push(entry);
		else map.set(key, [entry]);
	}

	private pending: Entry[] = [];
	/** how many rules' patterns hold each n-gram: a common one ("https", ".com/") is a poor key */
	private frequency = new Map<number, number>();

	/**
	 * The key n-gram among `grams`: the one the fewest patterns hold (a
	 * stand-in for how rarely URLs hold it), then the smallest bucket
	 * (Chromium's GetMostDistinctiveNGram takes the smallest bucket alone)
	 */
	private rarest(grams: number[]): number | null {
		let best: number | null = null;
		let bestFrequency = Infinity;
		let bestSize = Infinity;
		for (const gram of grams) {
			const frequency = this.frequency.get(gram) ?? 0;
			if (frequency > bestFrequency) continue;
			const size = this.ngrams.get(gram)?.length ?? 0;
			if (frequency < bestFrequency || size < bestSize) {
				best = gram;
				bestFrequency = frequency;
				bestSize = size;
			}
		}
		return best;
	}

	add(entry: Entry) {
		this.count++;
		this.pending.push(entry);
		const rule = entry.rule;
		const grams =
			rule.regex !== undefined
				? [...(rule.regexRequired ?? []), ...(rule.regexAtoms ?? [])].flatMap(
						(atom) => patternNgrams(atom),
					)
				: patternNgrams(rule.pattern ?? '');
		for (const gram of new Set(grams))
			this.frequency.set(gram, (this.frequency.get(gram) ?? 0) + 1);
	}

	private place(entry: Entry) {
		const rule = entry.rule;
		const keyed = (
			domains: string[] | undefined,
			map: Map<number, Entry[]>,
		) => {
			if (!domains) return false;
			const keys = new Set(domains.map(bucketKey));
			keys.delete('');
			if (!keys.size) return false;
			for (const key of new Set([...keys].map(domainHash)))
				this.file(map, key, entry);
			return true;
		};
		const byDomains = () =>
			keyed(rule.requestDomains, this.requestDomains) ||
			keyed(rule.initiatorDomains, this.initiatorDomains);
		// a key only common n-grams offer ("ps://", ".com/") is one nearly
		// every URL holds: a domain list sorts the rule out sooner
		const ngram = (gram: number | null) => {
			if (gram === null) return false;
			if ((this.frequency.get(gram) ?? 0) >= COMMON_NGRAM && byDomains())
				return true;
			this.file(this.ngrams, gram, entry);
			return true;
		};
		if (rule.regex !== undefined) {
			// a literal every match holds: the rarest n-gram of any of them
			const required = (rule.regexRequired ?? []).flatMap((atom) =>
				patternNgrams(atom),
			);
			if (ngram(this.rarest(required))) return;
			// one of several literals: filed under each
			const atoms = rule.regexAtoms;
			if (
				atoms &&
				atoms.length &&
				atoms.every((atom) => atom.length >= NGRAM_SIZE)
			) {
				for (const atom of atoms)
					this.file(this.ngrams, this.rarest(patternNgrams(atom))!, entry);
				return;
			}
		} else if (ngram(this.rarest(patternNgrams(rule.pattern ?? '')))) return;
		if (!byDomains()) this.fallback.push(entry);
	}

	finish() {
		for (const entry of this.pending) this.place(entry);
		this.pending = [];
		this.frequency.clear();
		for (const list of this.ngrams.values()) list.sort(entryOrder);
		this.table = new IntTable(this.ngrams);
		this.ngrams.clear();
		for (const list of this.requestDomains.values()) list.sort(entryOrder);
		for (const list of this.initiatorDomains.values()) list.sort(entryOrder);
		this.requestTable = new IntTable(this.requestDomains);
		this.initiatorTable = new IntTable(this.initiatorDomains);
		this.requestDomains.clear();
		this.initiatorDomains.clear();
		this.fallback.sort(entryOrder);
	}
}

/** a ruleset as an extension's matcher holds it */
export interface LoadedRuleset {
	/** the public id: the manifest's, '_dynamic' or '_session' */
	id: string;
	/** Chrome's numeric ruleset id: the manifest ordinal from 1, 0 dynamic, -1 session */
	rank: number;
	rules: IndexedRule[];
	/** updateStaticRules' disabled rule ids (Chrome applies them to url rules only) */
	disabled?: Set<number>;
}

interface RulesetState extends LoadedRuleset {
	/** allowAllRequests actions by frame (RulesetMatcherBase::allowlisted_frames_) */
	frames: Map<string, DnrAction>;
	/** its place in the extension's list (the per-request scratch is by place) */
	slot: number;
	/** still in the list: a removed or replaced ruleset's entries stay in their group, skipped */
	live: boolean;
	/** its rules per stage */
	stageCounts: [number, number];
}

/** the index of some of an extension's rulesets, built together */
class Group {
	readonly stages: [StageIndex, StageIndex] = [
		new StageIndex(),
		new StageIndex(),
	];
	constructor(readonly rulesets: RulesetState[]) {
		for (const ruleset of rulesets)
			for (const rule of ruleset.rules)
				this.stages[isBeforeRequestRule(rule) ? 0 : 1].add(
					new Entry(rule, ruleset, ruleset.rank),
				);
		this.stages[0].finish();
		this.stages[1].finish();
	}
	get live(): number {
		let rules = 0;
		for (const ruleset of this.rulesets)
			if (ruleset.live) rules += ruleset.rules.length;
		return rules;
	}
	get total(): number {
		let rules = 0;
		for (const ruleset of this.rulesets) rules += ruleset.rules.length;
		return rules;
	}
}

/** an extension with more groups than this has them merged into one */
const MAX_GROUPS = 6;

/** a request as the matcher reads it, computed once (RequestParams) */
export class Params {
	readonly url: URL;
	readonly info: UrlInfo;
	readonly host: string;
	readonly element: number;
	readonly method: number;
	readonly thirdParty: boolean;
	/** null for an opaque or absent initiator */
	readonly initiatorHost: string | null;
	readonly tabId: number;
	readonly topHost: string;
	readonly frame: string | null;
	readonly type: ResourceType;
	responseHeaders: HeaderLines | null = null;
	/** per extension: the highest priority allow action matched so far, across stages */
	readonly maxAllow = new Map<string, DnrAction | null>();
	/** per extension: whether it may see the request's header values */
	readonly hostAccess = new Map<string, boolean>();
	private grams: Int32Array | null = null;
	private gramCount = 0;
	private suffixes: Int32Array | null = null;
	private suffixCount = 0;
	private initiatorSuffixes: Int32Array | null = null;
	private initiatorSuffixCount = 0;
	/** a visit mark no entry holds yet */
	epoch = 0;

	constructor(
		request: Pick<
			DnrRequest,
			'url' | 'initiator' | 'type' | 'method' | 'tabId' | 'frame'
		> & {
			/** the top-level frame or initiator host, as RequestParams works it out */
			topHost: string;
			/** a navigation's frame evaluated at commit: third party by origin */
			thirdParty?: boolean;
		},
	) {
		this.url = new URL(request.url);
		this.info = urlInfo(this.url);
		this.host = this.url.hostname;
		this.type = request.type;
		this.element = ELEMENT_TYPES[request.type];
		const http =
			this.url.protocol === 'http:' || this.url.protocol === 'https:';
		this.method = methodBit(http, request.method);
		const initiator = parseOrigin(request.initiator);
		this.initiatorHost = initiator;
		this.thirdParty = request.thirdParty ?? isThirdParty(this.host, initiator);
		this.tabId = request.tabId ?? -1;
		this.topHost = request.topHost;
		this.frame = request.frame ?? null;
	}

	/** the URL's n-gram hashes; ngramCount of them */
	get ngrams(): Int32Array {
		if (!this.grams) {
			this.grams = new Int32Array(
				Math.max(0, this.info.lower.length - NGRAM_SIZE + 1),
			);
			this.gramCount = textNgrams(this.info.lower, this.grams);
		}
		return this.grams;
	}
	get ngramCount(): number {
		void this.ngrams;
		return this.gramCount;
	}
	/** domainHash of the host and its parent domains; hostSuffixCount of them */
	get hostSuffixes(): Int32Array {
		if (!this.suffixes) {
			this.suffixes = new Int32Array(this.host.length + 1);
			this.suffixCount = suffixHashes(this.host, this.suffixes);
		}
		return this.suffixes;
	}
	get hostSuffixCount(): number {
		void this.hostSuffixes;
		return this.suffixCount;
	}
	get initiatorHostSuffixes(): Int32Array {
		if (!this.initiatorSuffixes) {
			const host = this.initiatorHost ?? '';
			this.initiatorSuffixes = new Int32Array(host.length + 1);
			this.initiatorSuffixCount =
				this.initiatorHost === null
					? 0
					: suffixHashes(host, this.initiatorSuffixes);
		}
		return this.initiatorSuffixes;
	}
	get initiatorHostSuffixCount(): number {
		void this.initiatorHostSuffixes;
		return this.initiatorSuffixCount;
	}
}

/** an origin's host, or null for an opaque or absent one */
export function parseOrigin(origin: string | null | undefined): string | null {
	if (!origin || origin === 'null') return null;
	try {
		const url = new URL(origin);
		// chrome-extension is a standard scheme to Chrome, its origin the extension id;
		// WHATWG URL calls every non-special origin opaque
		if (url.protocol === 'chrome-extension:') return url.hostname || null;
		// url::Origin of a URL without a tuple (data:, about:) is opaque
		if (url.origin === 'null') return null;
		return url.hostname;
	} catch {
		return null;
	}
}

/**
 * IsThirdPartyRequest: !SameDomainOrHost(url, initiator) with private
 * registries counted; an opaque or absent initiator is third party
 */
export function isThirdParty(
	host: string,
	initiatorHost: string | null,
): boolean {
	if (initiatorHost === null) return true;
	if (!host || !initiatorHost) return true;
	if (host === initiatorHost) return false;
	const a = registrable(host);
	return !a || a !== registrable(initiatorHost);
}

/** getDomain by host, kept for the hosts a page keeps asking about (the public suffix walk is a tenth of a match) */
const registrableCache = new Map<string, string | null>();
function registrable(host: string): string | null {
	let domain = registrableCache.get(host);
	if (domain === undefined) {
		if (registrableCache.size >= 4096) registrableCache.clear();
		domain = getDomain(host, true) || null;
		registrableCache.set(host, domain);
	}
	return domain;
}

/** base::MatchPattern: `*` any run, `?` one character or none */
function matchHeaderPattern(text: string, pattern: string): boolean {
	const memo = new Map<number, boolean>();
	const step = (t: number, p: number): boolean => {
		const key = t * (pattern.length + 1) + p;
		const known = memo.get(key);
		if (known !== undefined) return known;
		let result: boolean;
		if (p === pattern.length) result = t === text.length;
		else if (pattern[p] === '*')
			result = step(t, p + 1) || (t < text.length && step(t + 1, p));
		else if (pattern[p] === '?')
			result = step(t, p + 1) || (t < text.length && step(t + 1, p + 1));
		// a backslash makes the next character literal (`\*`, `\?`, `\\`)
		else if (pattern[p] === '\\' && p + 1 < pattern.length)
			result =
				t < text.length && text[t] === pattern[p + 1] && step(t + 1, p + 2);
		else
			result = t < text.length && text[t] === pattern[p] && step(t + 1, p + 1);
		memo.set(key, result);
		return result;
	};
	return step(0, 0);
}

/** MatchesHeaderConditions */
/** HttpUtil::IsNonCoalescingHeader: the headers a comma does not split */
const NON_COALESCING = new Set([
	'date',
	'expires',
	'last-modified',
	'location',
	'retry-after',
	'set-cookie',
	'www-authenticate',
	'proxy-authenticate',
	'strict-transport-security',
]);

const trimLWS = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * the values HttpResponseHeaders::EnumerateHeader yields for one line: a
 * coalescing header's line split at the commas outside double quotes
 * (HttpUtil::ValuesIterator), each trimmed of spaces and tabs
 */
function pushValues(values: string[], name: string, value: string) {
	if (!value.includes(',') || NON_COALESCING.has(name)) {
		values.push(value);
		return;
	}
	let start = 0;
	let quoted = false;
	for (let at = 0; at <= value.length; at++) {
		const code = value.charCodeAt(at);
		if (code === 34) quoted = !quoted;
		else if (at === value.length || (code === 44 && !quoted)) {
			values.push(trimLWS(value.slice(start, at)));
			start = at + 1;
		}
	}
}

function matchesHeaderConditions(
	lines: HeaderLines,
	conditions: HeaderCondition[],
): boolean {
	for (const condition of conditions) {
		const name = condition.header.toLowerCase();
		const values: string[] = [];
		for (const [header, value] of lines)
			if (header.toLowerCase() === name) pushValues(values, name, value);
		if (!values.length) continue;
		if (!condition.values && !condition.excludedValues) return true;
		const has = (pattern: string) =>
			values.some((value) => matchHeaderPattern(value.toLowerCase(), pattern));
		if (condition.excludedValues?.some(has)) continue;
		if (!condition.values || condition.values.some(has)) return true;
	}
	return false;
}

export interface MatcherOptions {
	/** declarativeNetRequestWithHostAccess without declarativeNetRequest: every action needs host access */
	hostAccessAlwaysRequired?: boolean;
	/** Chromium main's kDeclarativeNetRequestRestrictResponseHeaderValueMatching (not in effect in Chrome 157) */
	restrictHeaderValueMatching?: boolean;
}

/** per request scratch an extension's matcher fills in one pass */
interface Found {
	main: (Entry | null)[];
	allowAll: (Entry | null)[];
	regex: (Entry | null)[];
	modify: Entry[];
}

/** one extension's rulesets (CompositeMatcher) */
export class ExtensionMatcher {
	private rulesets: RulesetState[] = [];
	private groups: Group[] = [];
	/** added, not indexed yet: the next request indexes them, as a group */
	private pending: RulesetState[] = [];
	private epoch = 0;

	constructor(
		readonly id: string,
		readonly installTime: number,
		readonly options: MatcherOptions = {},
	) {}

	/** the rulesets, in the order Chrome's matcher holds them (session, static, dynamic) */
	list(): readonly LoadedRuleset[] {
		return this.rulesets;
	}

	/** AddOrUpdateRulesets: a ruleset of the same id is replaced (its frame state lost) and goes last */
	addOrUpdate(rulesets: LoadedRuleset[]) {
		this.drop(new Set(rulesets.map((ruleset) => ruleset.id)));
		for (const ruleset of rulesets) {
			const stageCounts: [number, number] = [0, 0];
			for (const rule of ruleset.rules)
				stageCounts[isBeforeRequestRule(rule) ? 0 : 1]++;
			const state: RulesetState = {
				...ruleset,
				frames: new Map(),
				slot: 0,
				live: true,
				stageCounts,
			};
			this.rulesets.push(state);
			this.pending.push(state);
		}
		this.reslot();
	}

	remove(ids: Iterable<string>) {
		this.drop(new Set(ids));
		this.reslot();
	}

	private drop(ids: Set<string>) {
		this.rulesets = this.rulesets.filter((ruleset) => {
			if (!ids.has(ruleset.id)) return true;
			ruleset.live = false;
			return false;
		});
		this.pending = this.pending.filter((ruleset) => ruleset.live);
	}

	private reslot() {
		this.rulesets.forEach((ruleset, slot) => (ruleset.slot = slot));
	}

	setDisabled(rulesetId: string, disabled: Set<number>) {
		const ruleset = this.rulesets.find(
			(candidate) => candidate.id === rulesetId,
		);
		if (ruleset) ruleset.disabled = disabled;
	}

	hasRules(stage: Stage): boolean {
		return this.rulesets.some((ruleset) => ruleset.stageCounts[stage] > 0);
	}

	/** index what changed now rather than on the next request */
	prepare() {
		this.build();
	}

	/**
	 * Indexes what was added since the last request, as one group; a group
	 * most of whose rules are gone is rebuilt from the rest, and too many
	 * groups (each costs a request its probes) are merged
	 */
	private build() {
		if (this.pending.length) {
			this.groups.push(new Group(this.pending));
			this.pending = [];
		}
		let changed = false;
		this.groups = this.groups.flatMap((group) => {
			const live = group.live;
			if (live === group.total) return [group];
			changed = true;
			if (!live) return [];
			if (live * 2 >= group.total) return [group];
			return [new Group(group.rulesets.filter((ruleset) => ruleset.live))];
		});
		if (this.groups.length > MAX_GROUPS)
			this.groups = [
				new Group(
					this.groups.flatMap((group) =>
						group.rulesets.filter((ruleset) => ruleset.live),
					),
				),
			];
		else if (changed)
			this.groups = this.groups.filter((group) => group.live > 0);
	}

	private embedderMatches(rule: IndexedRule, p: Params): boolean {
		if (rule.tabIds && !rule.tabIds.includes(p.tabId)) return false;
		if (rule.excludedTabIds && rule.excludedTabIds.includes(p.tabId))
			return false;
		if (
			(rule.topDomains || rule.excludedTopDomains) &&
			!hostMatchesLists(p.topHost, rule.topDomains, rule.excludedTopDomains)
		)
			return false;
		if (p.responseHeaders) {
			if (
				rule.headerValuesNeedHostAccess &&
				this.options.restrictHeaderValueMatching &&
				!p.hostAccess.get(this.id)
			)
				return false;
			if (
				rule.excludedResponseHeaders &&
				matchesHeaderConditions(p.responseHeaders, rule.excludedResponseHeaders)
			)
				return false;
			if (
				rule.responseHeaders &&
				!matchesHeaderConditions(p.responseHeaders, rule.responseHeaders)
			)
				return false;
		}
		return true;
	}

	/** FindMatchAmongCandidates and DoesRuleMetadataMatchRequest, for one rule */
	private matches(entry: Entry, p: Params): boolean {
		const rule = entry.rule;
		if (!(rule.elementTypes & p.element)) return false;
		if (!(rule.methods & p.method)) return false;
		if (!(rule.party & (p.thirdParty ? PARTY_THIRD : PARTY_FIRST)))
			return false;
		if (
			(rule.tabIds ||
				rule.excludedTabIds ||
				rule.topDomains ||
				rule.excludedTopDomains ||
				rule.responseHeaders ||
				rule.excludedResponseHeaders) &&
			!this.embedderMatches(rule, p)
		)
			return false;
		if (entry.pattern) {
			if (p.info.spec.length > MAX_URL_CHARS) return false;
			const text = rule.matchCase ? p.info.spec : p.info.lower;
			if (!matchPattern(entry.pattern, text, p.info.hostBegin, p.info.hostEnd))
				return false;
		}
		if (p.initiatorHost === null) {
			if (rule.initiatorDomains) return false;
		} else if (
			(rule.initiatorDomains || rule.excludedInitiatorDomains) &&
			!hostMatchesLists(
				p.initiatorHost,
				rule.initiatorDomains,
				rule.excludedInitiatorDomains,
			)
		)
			return false;
		if (
			(rule.requestDomains || rule.excludedRequestDomains) &&
			!hostMatchesLists(
				p.host,
				rule.requestDomains,
				rule.excludedRequestDomains,
			)
		)
			return false;
		if (entry.pattern) {
			if (entry.ruleset.disabled?.has(rule.id)) return false;
		} else if (!entry.re.test(p.info.spec)) return false;
		return true;
	}

	private visit(entry: Entry, p: Params, found: Found, allowAllOnly: boolean) {
		if (entry.seen === this.epoch) return;
		entry.seen = this.epoch;
		if (!entry.ruleset.live) return;
		const place = entry.ruleset.slot;
		if (entry.kind === KIND_MODIFY) {
			if (!allowAllOnly && this.matches(entry, p)) found.modify.push(entry);
			return;
		}
		if (allowAllOnly && entry.kind !== KIND_ALLOW_ALL) return;
		const slots = entry.pattern
			? entry.kind === KIND_ALLOW_ALL
				? found.allowAll
				: found.main
			: allowAllOnly
				? found.allowAll
				: found.regex;
		const top = slots[place];
		if (top && !entryGreater(entry, top)) return;
		if (this.matches(entry, p)) slots[place] = entry;
	}

	private scan(p: Params, stage: Stage, allowAllOnly = false): Found {
		this.build();
		this.epoch++;
		const size = this.rulesets.length;
		const found: Found = {
			main: new Array(size).fill(null),
			allowAll: new Array(size).fill(null),
			regex: new Array(size).fill(null),
			modify: [],
		};
		const walk = (list: Entry[] | undefined) => {
			if (list)
				for (const entry of list) this.visit(entry, p, found, allowAllOnly);
		};
		for (const group of this.groups)
			this.scanIndex(group.stages[stage], p, walk);
		return found;
	}

	private scanIndex(
		index: StageIndex,
		p: Params,
		walk: (list: Entry[] | undefined) => void,
	) {
		if (!index.count) return;
		if (index.table.size) {
			const grams = p.ngrams;
			const table = index.table;
			for (let i = 0, count = p.ngramCount; i < count; i++)
				walk(table.get(grams[i]));
		}
		if (index.requestTable.size) {
			const hashes = p.hostSuffixes;
			for (let i = 0, count = p.hostSuffixCount; i < count; i++)
				walk(index.requestTable.get(hashes[i]));
		}
		if (index.initiatorTable.size && p.initiatorHost !== null) {
			const hashes = p.initiatorHostSuffixes;
			for (let i = 0, count = p.initiatorHostSuffixCount; i < count; i++)
				walk(index.initiatorTable.get(hashes[i]));
		}
		walk(index.fallback);
	}

	private actionFor(entry: Entry, p: Params): DnrAction | null {
		const rule = entry.rule;
		const ruleset = entry.ruleset;
		const base = (type: DnrAction['type']): DnrAction => ({
			type,
			extensionId: this.id,
			rulesetId: ruleset.id,
			ruleId: rule.id,
			priority: rule.priority,
			rank: ruleset.rank,
		});
		switch (rule.action) {
			case 'block':
				return base(
					p.element === ELEMENT_IMAGE || p.element === ELEMENT_SUBDOCUMENT
						? 'collapse'
						: 'block',
				);
			case 'allow':
				return base('allow');
			case 'allowAllRequests':
				return base('allowAllRequests');
			case 'upgradeScheme': {
				const upgraded = upgradeUrl(p.url);
				if (upgraded === null) return null;
				return { ...base('upgradeScheme'), redirectUrl: upgraded };
			}
			case 'redirect': {
				let target: string | null;
				if (rule.regexSubstitution !== undefined) {
					target = replaceFirst(
						p.info.spec,
						rule.regexFilter !== undefined
							? {
									pattern: rule.regexFilter,
									options: {
										caseSensitive: !!rule.matchCase,
										requireCapturing: true,
									},
								}
							: entry.re,
						rule.regexSubstitution,
					);
					if (target === null) return null;
					if (/^javascript:/i.test(target.trimStart())) return null;
				} else if (rule.redirectUrl !== undefined) target = rule.redirectUrl;
				else target = transformUrl(p.url, rule.transform!);
				// CreateRedirectAction
				if (
					p.element === ELEMENT_WEBSOCKET ||
					p.element === ELEMENT_WEBTRANSPORT
				)
					return null;
				if (target === null) return null;
				let href: string;
				try {
					href = new URL(target).href;
				} catch {
					return null;
				}
				if (href === p.info.spec) return null;
				return { ...base('redirect'), redirectUrl: href };
			}
			default:
				return null;
		}
	}

	private modifyAction(entry: Entry): DnrAction {
		const rule = entry.rule;
		const ruleset = entry.ruleset;
		return {
			type: 'modifyHeaders',
			extensionId: this.id,
			rulesetId: ruleset.id,
			ruleId: rule.id,
			priority: rule.priority,
			rank: ruleset.rank,
			...(rule.requestHeaders ? { requestHeaders: rule.requestHeaders } : {}),
			...(rule.responseHeadersToModify
				? { responseHeaders: rule.responseHeadersToModify }
				: {}),
		};
	}

	/** the found modifyHeaders entries, kept for getModifyHeaders after getAction */
	private lastFound: { p: Params; stage: Stage; found: Found } | null = null;

	private foundFor(p: Params, stage: Stage): Found {
		const last = this.lastFound;
		if (last && last.p === p && last.stage === stage) return last.found;
		const found = this.scan(p, stage);
		this.lastFound = { p, stage, found };
		return found;
	}

	/** CompositeMatcher::GetAction */
	getAction(
		p: Params,
		stage: Stage,
		access: PageAccess,
	): { action: DnrAction | null; withheld: boolean } {
		p.hostAccess.set(this.id, access === 'allowed');
		if (!p.maxAllow.has(this.id)) p.maxAllow.set(this.id, null);
		const found = this.foundFor(p, stage);
		let final: DnrAction | null = p.maxAllow.get(this.id) ?? null;
		this.rulesets.forEach((ruleset, place) => {
			const own = maxAction(
				maxAction(
					found.main[place] ? this.actionFor(found.main[place]!, p) : null,
					found.allowAll[place]
						? this.actionFor(found.allowAll[place]!, p)
						: null,
				),
				found.regex[place] ? this.actionFor(found.regex[place]!, p) : null,
			);
			const action = maxAction(
				own,
				p.frame !== null ? (ruleset.frames.get(p.frame) ?? null) : null,
			);
			const allow = p.maxAllow.get(this.id);
			if (!action || action.priority <= (allow ? allow.priority : 0)) return;
			if (isAllow(action)) p.maxAllow.set(this.id, action);
			final = maxAction(final, action);
		});
		if (!final) return { action: null, withheld: false };
		const needsAccess =
			!!this.options.hostAccessAlwaysRequired ||
			(final as DnrAction).type === 'redirect';
		if (!needsAccess || access === 'allowed')
			return { action: final, withheld: false };
		return { action: null, withheld: access === 'withheld' && !isAllow(final) };
	}

	/** CompositeMatcher::GetModifyHeadersActions: above the highest allow, highest first */
	getModifyHeaders(p: Params, stage: Stage): DnrAction[] {
		const found = this.foundFor(p, stage);
		const allow = p.maxAllow.get(this.id);
		const floor = allow ? allow.priority : 0;
		return found.modify
			.filter((entry) => entry.priority > floor)
			.sort(entryOrder)
			.map((entry) => this.modifyAction(entry));
	}

	/**
	 * GetAllowAllRequestsAction for a committed frame, both stages when it
	 * has response headers, per ruleset
	 */
	private frameActions(
		p: Params,
		withHeaders: Params | null,
	): (DnrAction | null)[] {
		const out: (DnrAction | null)[] = this.rulesets.map(() => null);
		const take = (params: Params, stage: Stage) => {
			const found = this.scan(params, stage, true);
			this.rulesets.forEach((_, place) => {
				const entry = found.allowAll[place];
				if (entry)
					out[place] = maxAction(out[place], this.actionFor(entry, params));
			});
		};
		take(p, STAGE_BEFORE_REQUEST);
		if (withHeaders) take(withHeaders, STAGE_HEADERS_RECEIVED);
		return out;
	}

	/** RulesetMatcherBase::OnDidFinishNavigation */
	onNavigationCommitted(
		frame: string,
		parent: string | null,
		p: Params | null,
		withHeaders: Params | null,
		hostAccess: boolean,
	) {
		this.build();
		if (p) p.hostAccess.set(this.id, hostAccess);
		if (withHeaders) withHeaders.hostAccess.set(this.id, hostAccess);
		const own = p
			? this.frameActions(p, withHeaders)
			: this.rulesets.map(() => null);
		this.rulesets.forEach((ruleset, place) => {
			const inherited =
				parent !== null ? (ruleset.frames.get(parent) ?? null) : null;
			const action = maxAction(inherited, own[place]);
			ruleset.frames.delete(frame);
			if (action) ruleset.frames.set(frame, action);
		});
	}

	/** RulesetMatcherBase::OnRenderFrameCreated: a frame that loads before it commits takes its parent's */
	onFrameCreated(frame: string, parent: string) {
		for (const ruleset of this.rulesets) {
			const action = ruleset.frames.get(parent);
			if (action && !ruleset.frames.has(frame))
				ruleset.frames.set(frame, action);
		}
	}

	onFrameRemoved(frame: string) {
		for (const ruleset of this.rulesets) ruleset.frames.delete(frame);
	}

	/** the rules of each stage, for limits and the reports */
	counts() {
		let beforeRequest = 0;
		let headersReceived = 0;
		for (const ruleset of this.rulesets) {
			beforeRequest += ruleset.stageCounts[0];
			headersReceived += ruleset.stageCounts[1];
		}
		return { beforeRequest, headersReceived };
	}

	/** how the rules were filed, for the measurements: per group, per stage */
	indexStats() {
		this.build();
		return this.groups.map((group) =>
			group.stages.map((stage) => ({
				rules: stage.count,
				ngramBuckets: stage.table.size,
				requestDomainBuckets: stage.requestTable.size,
				initiatorDomainBuckets: stage.initiatorTable.size,
				fallback: stage.fallback.length,
				largestBucket: [
					stage.table,
					stage.requestTable,
					stage.initiatorTable,
				].reduce(
					(largest, table) =>
						table
							.values()
							.reduce((most, list) => Math.max(most, list.length), largest),
					0,
				),
			})),
		);
	}
}

/** the top-level frame or initiator host of a request (RequestParams' WebRequestInfo constructor) */
export function topHostOf(request: DnrRequest): string {
	if (request.type === 'main_frame') {
		try {
			return new URL(request.url).hostname;
		} catch {
			return '';
		}
	}
	const top = parseOrigin(request.topUrl ?? null);
	return top ?? parseOrigin(request.initiator) ?? '';
}

export const isMainFrame = (element: number) => element === ELEMENT_MAIN_FRAME;
