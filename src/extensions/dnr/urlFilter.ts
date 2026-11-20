// urlFilter matching as Chromium's url_pattern_index does it
// (components/url_pattern_index/url_pattern.cc, fuzzy_pattern_matching.cc,
// ngram_extractor.h), on the canonical URL spec: the pattern is split on
// `*` into subpatterns, `^` matches one separator character (and the end
// of the URL when it ends the last subpattern), `|` anchors either end and
// `||` the start of a (sub-)domain of the host. Subpatterns are found
// leftmost-first, which for `*`-only globs is exact. Case-insensitive
// patterns are lowercased once and matched against the lowercased spec.

export const ANCHOR_NONE = 0;
export const ANCHOR_BOUNDARY = 1;
export const ANCHOR_SUBDOMAIN = 2;
export type Anchor = 0 | 1 | 2;

const SEPARATOR = 0x5e; // ^

/** Chromium's IsSeparator: any ASCII but letters, digits, `_ - . %`; `^` is one */
export function isSeparator(code: number): boolean {
	if (code >= 0x80) return false;
	if (code >= 0x30 && code <= 0x39) return false;
	const lower = code | 0x20;
	if (lower >= 0x61 && lower <= 0x7a) return false;
	return code !== 0x5f && code !== 0x2d && code !== 0x2e && code !== 0x25;
}

const fuzzyEqual = (text: number, pattern: number) =>
	text === pattern || (pattern === SEPARATOR && isSeparator(text));

/** whether `sub` occurs (fuzzily) in `text` at `at` */
function fuzzyAt(text: string, at: number, sub: string): boolean {
	for (let i = 0; i < sub.length; i++)
		if (!fuzzyEqual(text.charCodeAt(at + i), sub.charCodeAt(i))) return false;
	return true;
}

/** the leftmost occurrence of `sub` in text[from, end), or -1 (FindFuzzy, or a plain find) */
function find(
	text: string,
	sub: string,
	fuzzy: boolean,
	from: number,
	end: number,
): number {
	if (from > end) return -1;
	if (!sub.length) return from;
	if (!fuzzy) {
		const at = text.indexOf(sub, from);
		return at < 0 || at + sub.length > end ? -1 : at;
	}
	for (let at = from; at + sub.length <= end; at++)
		if (fuzzyAt(text, at, sub)) return at;
	return -1;
}

/** a URL's spec and its host's place in it (GURL's parsed host component) */
export interface UrlInfo {
	spec: string;
	lower: string;
	hostBegin: number;
	hostEnd: number;
}

export function urlInfo(url: URL): UrlInfo {
	const spec = url.href;
	let hostBegin = 0;
	let hostEnd = 0;
	if (url.host) {
		hostBegin = spec.indexOf('//') + 2;
		if (url.username || url.password)
			hostBegin = spec.indexOf('@', hostBegin) + 1;
		hostEnd = hostBegin + url.hostname.length;
	}
	return { spec, lower: lowerAscii(spec), hostBegin, hostEnd };
}

export function lowerAscii(text: string): string {
	return /[A-Z]/.test(text) ? text.toLowerCase() : text;
}

function subdomainAnchored(
	text: string,
	hostBegin: number,
	hostEnd: number,
	at: number,
): boolean {
	return (
		at === hostBegin ||
		(at > hostBegin && at <= hostEnd && text.charCodeAt(at - 1) === 0x2e)
	);
}

/** FindSubdomainAnchoredSubpattern */
function findAnchored(
	text: string,
	hostBegin: number,
	hostEnd: number,
	sub: string,
	fuzzy: boolean,
): number {
	const limit = Math.min(text.length, hostEnd + sub.length);
	for (let at = hostBegin; at <= hostEnd; at++) {
		at = find(text, sub, fuzzy, at, limit);
		if (at < 0 || subdomainAnchored(text, hostBegin, hostEnd, at)) return at;
		at = text.indexOf('.', at);
		if (at < 0 || at >= hostEnd) break;
	}
	return -1;
}

/** DoesTextMatchLastSubpatternInternal, over text[begin, end) */
function lastInternal(
	left: Anchor,
	right: Anchor,
	text: string,
	begin: number,
	end: number,
	hostBegin: number,
	hostEnd: number,
	sub: string,
	fuzzy: boolean,
): boolean {
	const size = end - begin;
	if (left === ANCHOR_NONE)
		return right === ANCHOR_NONE
			? find(text, sub, fuzzy, begin, end) >= 0
			: sub.length <= size && fuzzyAt(text, end - sub.length, sub);
	if (left === ANCHOR_BOUNDARY)
		return right === ANCHOR_NONE
			? sub.length <= size && fuzzyAt(text, begin, sub)
			: size === sub.length && fuzzyAt(text, begin, sub);
	if (hostEnd <= hostBegin) return false;
	if (right === ANCHOR_NONE)
		return findAnchored(text, hostBegin, hostEnd, sub, fuzzy) >= 0;
	return (
		size >= sub.length &&
		subdomainAnchored(text, hostBegin, hostEnd, end - sub.length) &&
		fuzzyAt(text, end - sub.length, sub)
	);
}

function last(
	left: Anchor,
	right: Anchor,
	text: string,
	begin: number,
	end: number,
	hostBegin: number,
	hostEnd: number,
	sub: string,
	fuzzy: boolean,
): boolean {
	if (
		lastInternal(left, right, text, begin, end, hostBegin, hostEnd, sub, fuzzy)
	)
		return true;
	// a trailing separator also matches the end of the text
	if (sub.charCodeAt(sub.length - 1) === SEPARATOR) {
		const shorter = sub.slice(0, -1);
		return lastInternal(
			left,
			ANCHOR_BOUNDARY,
			text,
			begin,
			end,
			hostBegin,
			hostEnd,
			shorter,
			shorter.includes('^'),
		);
	}
	return false;
}

/** a urlFilter, parsed and prepared once (UrlFilterParser and UrlPattern) */
export interface UrlPattern {
	/** the subpatterns between the wildcards, empty ones left out */
	subs: string[];
	/** which of them hold a `^` */
	fuzzy: boolean[];
	left: Anchor;
	right: Anchor;
}

/**
 * UrlFilterParser: the anchors and the pattern between them. The pattern
 * is lowercased by the caller when it is case-insensitive. Returns the
 * pattern text too, for the n-gram index
 */
export function parseUrlFilter(filter: string): {
	pattern: string;
	left: Anchor;
	right: Anchor;
} {
	let index = 0;
	let left: Anchor = ANCHOR_NONE;
	if (filter[0] === '|') {
		index = 1;
		left = ANCHOR_BOUNDARY;
		if (filter[1] === '|') {
			index = 2;
			left = ANCHOR_SUBDOMAIN;
		}
	}
	let end = filter.length;
	let right: Anchor = ANCHOR_NONE;
	// a right anchor is a `|` that ends the filter and is not its first character
	if (end > 0 && filter[end - 1] === '|' && end - 1 >= index && end - 1 > 0) {
		end--;
		right = ANCHOR_BOUNDARY;
	}
	return { pattern: filter.slice(index, end), left, right };
}

export function preparePattern(
	pattern: string,
	left: Anchor,
	right: Anchor,
): UrlPattern {
	// "|*xyz" is "*xyz", "xyz*|" is "xyz*"
	if (pattern[0] === '*') left = ANCHOR_NONE;
	if (pattern[pattern.length - 1] === '*') right = ANCHOR_NONE;
	const subs = pattern.split('*').filter((sub) => sub.length > 0);
	return { subs, fuzzy: subs.map((sub) => sub.includes('^')), left, right };
}

/** UrlPattern::MatchesUrl (IsCaseSensitiveMatch) on text, which is the spec or its lowercase */
export function matchPattern(
	pattern: UrlPattern,
	text: string,
	hostBegin: number,
	hostEnd: number,
): boolean {
	const { subs, fuzzy, left, right } = pattern;
	if (!subs.length) return left === ANCHOR_NONE || right === ANCHOR_NONE;
	if (subs.length === 1)
		return last(
			left,
			right,
			text,
			0,
			text.length,
			hostBegin,
			hostEnd,
			subs[0],
			fuzzy[0],
		);
	let begin = 0;
	let next = 0;
	if (left === ANCHOR_BOUNDARY) {
		if (!(subs[0].length <= text.length && fuzzyAt(text, 0, subs[0])))
			return false;
		begin = subs[0].length;
		next = 1;
	} else if (left === ANCHOR_SUBDOMAIN) {
		if (hostEnd <= hostBegin) return false;
		const at = findAnchored(text, hostBegin, hostEnd, subs[0], fuzzy[0]);
		if (at < 0) return false;
		begin = at + subs[0].length;
		next = 1;
	}
	for (; next < subs.length - 1; next++) {
		const at = find(text, subs[next], fuzzy[next], begin, text.length);
		if (at < 0) return false;
		begin = at + subs[next].length;
	}
	return last(
		ANCHOR_NONE,
		right,
		text,
		begin,
		text.length,
		0,
		0,
		subs[subs.length - 1],
		fuzzy[subs.length - 1],
	);
}

/** url_pattern_index's n-gram size */
export const NGRAM_SIZE = 5;

/**
 * A five-byte n-gram as a small integer: the last four bytes in `low`, the
 * first in `high`, mixed into 30 bits (a V8 small integer, which a Map and
 * an Int32Array key cheaply; Chromium keys its table by the uint64). Two
 * n-grams sharing a hash share a bucket, which only adds candidates
 */
function ngramHash(high: number, low: number): number {
	// murmur3's finalizer, so the low bits a table indexes by are mixed
	let x = low ^ Math.imul(high + 0x100, 0x9e3779b1);
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) & 0x3fffffff;
}

/**
 * Every n-gram of the pattern that crosses no `*` or `^`, lowercased, hashed
 * (ngramHash), in order
 */
export function patternNgrams(pattern: string): number[] {
	const out: number[] = [];
	let run = 0;
	let low = 0;
	for (let i = 0; i < pattern.length; i++) {
		let code = pattern.charCodeAt(i);
		if (code === 0x2a || code === SEPARATOR || code >= 0x80) {
			run = 0;
			low = 0;
			continue;
		}
		if (code >= 0x41 && code <= 0x5a) code |= 0x20;
		const high = low >>> 24;
		low = (low << 8) | code;
		if (++run >= NGRAM_SIZE) out.push(ngramHash(high, low));
	}
	return out;
}

/** every n-gram of a lowercased spec, hashed, in order (the matcher's probes); returns the count */
export function textNgrams(lower: string, out: Int32Array): number {
	let low = 0;
	let count = 0;
	for (let i = 0; i < lower.length; i++) {
		const high = low >>> 24;
		low = (low << 8) | (lower.charCodeAt(i) & 0xff);
		if (i >= NGRAM_SIZE - 1) out[count++] = ngramHash(high, low);
	}
	return count;
}
