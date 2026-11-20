/**
 * The omnibox's ranking (SystemYA src/systemya/omni/rank.ts, after Fracital's
 * src/libs/omni/rank.ts), kept pure (no stores, no DOM) so a test can run it
 * in node (test/suites/omnibox-unit.mjs). Sources (sources.ts) turn what
 * they know into scored Suggestions with the helpers here; rankAndGroup then
 * dedupes, caps each kind, orders the groups and puts the default row ("Go
 * to ..." or "Search ... for ...") first. topPicks builds the empty box's
 * list.
 */

/**
 * What a row is: a site (history or a bookmark), an open tab, a page of the
 * host's own, the default row's search, an engine's completion, or a kind
 * of the host's (capped at three rows like a tab).
 */
export type SuggestionKind =
	'url' | 'tab' | 'page' | 'search' | 'completion' | (string & {});
/** A group's header: a kind, or one of the empty-box sections. */
export type GroupKey = SuggestionKind | 'default' | 'jump' | 'top';

export interface Suggestion {
	kind: SuggestionKind;
	/** Stable ("url:<canonical>", "tab:<id>", "completion:<text>"); unique among the rows. */
	id: string;
	/** A data value: the site's title, the completion's text. */
	title: string;
	/** A data value: the host, the about: address. */
	subtitle?: string;
	/** A favicon or artwork URL, a thumbnail data URI, or an icon node. */
	icon?: string | Node;
	/** Where picking it goes; absent for rows that act instead (switch to a tab). */
	url?: string;
	displayUrl?: string;
	run?: () => void;
	score: number;
	/** What Tab puts in the box; defaults to url, then title. */
	fill?: string;
	/** Shift+Delete on the highlighted row calls it (a history row forgets its page), and the box ranks again. */
	forget?: () => void;
}

export interface SuggestionGroup {
	key: GroupKey;
	rows: Suggestion[];
}

export interface Ranked {
	groups: SuggestionGroup[];
	/** Every row in display order (the default row first), for keyboard navigation. */
	rows: Suggestion[];
}

/** Rows per kind when there's a query; a host's own kind gets DEFAULT_CAP. */
const CAPS: Record<string, number> = {
	tab: 3,
	url: 4,
	page: 2,
	completion: 4,
	search: 0,
};
const DEFAULT_CAP = 3;
/** Rows after the default row. */
const MAX_ROWS = 10;
const MAX_PICKS = 8;

/** Lowercase, unaccented, single-spaced, without a web address's scheme, "www." and trailing slash. */
export const fold = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/^https?:\/\/(www\.)?/, '')
		.replace(/\/+$/, '')
		.replace(/\s+/g, ' ')
		.trim();

const WORD_BREAK = /[\s./:_\-?=&#]+/;

const tierOf = (word: string, text: string) => {
	if (text === word) return 1;
	if (text.startsWith(word)) return 0.85;
	if (text.split(WORD_BREAK).some((t) => t.startsWith(word))) return 0.7;
	if (text.includes(word)) return 0.5;
	return 0;
};

/** How well `text` matches the typed `q`: exact 1, prefix 0.85, word prefix 0.7, substring 0.5, else 0. Every word of a multi-word query must hit. */
export function matchScore(q: string, text: string): number {
	const fq = fold(q);
	const ft = fold(text);
	if (!fq || !ft) return 0;
	const words = fq.split(' ');
	if (words.length === 1) return tierOf(fq, ft);
	let total = 0;
	for (const w of words) {
		const t = tierOf(w, ft);
		if (!t) return 0;
		total += t;
	}
	return total / words.length;
}

export const hostOf = (url: string) => {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
};

/** The same page under one key: scheme, host (without "www."), path and query, without the hash or a trailing slash. */
export const canonicalUrl = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
	} catch {
		return fold(url);
	}
};

/** The best of matching the site's name ("youtube"), its host, the whole address and the title. */
export const urlMatch = (q: string, url: string, title?: string) => {
	const host = hostOf(url);
	return Math.max(
		matchScore(q, host.replace(/\.[^.]+$/, '')),
		matchScore(q, host),
		matchScore(q, url),
		title ? matchScore(q, title) : 0,
	);
};

const HOUR = 3_600_000;
/** What one visit is worth by its age (Firefox's frecency buckets). */
export const recencyWeight = (ageMs: number) =>
	ageMs < 4 * HOUR
		? 1
		: ageMs < 24 * HOUR
			? 0.7
			: ageMs < 7 * 24 * HOUR
				? 0.5
				: ageMs < 30 * 24 * HOUR
					? 0.3
					: 0.1;
/** 0..1 from a frecency sum; three recent visits are about 0.5. */
export const saturate = (frecency: number) => frecency / (frecency + 3);
/** A site's score from how well it matches and how often it's visited lately. */
export const scoreUrl = (match: number, frecency: number) =>
	match * (0.6 + 0.4 * saturate(frecency));

export interface HistoryEntry {
	url: string;
	title: string;
	icon?: string;
	at: number;
}
export interface FrecentSite {
	url: string;
	canonical: string;
	title: string;
	icon?: string;
	frecency: number;
	lastAt: number;
	visits: number;
}

/** History grouped by page, most frecent first. */
export function frecentSites(
	visits: HistoryEntry[],
	now = Date.now(),
): FrecentSite[] {
	const byPage = new Map<string, FrecentSite>();
	for (const v of visits) {
		if (!/^https?:\/\//i.test(v.url)) continue;
		const canonical = canonicalUrl(v.url);
		const w = recencyWeight(Math.max(0, now - v.at));
		const site = byPage.get(canonical);
		if (site) {
			site.frecency += w;
			site.visits += 1;
			if (v.at > site.lastAt) {
				site.lastAt = v.at;
				site.url = v.url;
				if (v.title) site.title = v.title;
				if (v.icon) site.icon = v.icon;
			}
		} else
			byPage.set(canonical, {
				url: v.url,
				canonical,
				title: v.title || hostOf(v.url),
				icon: v.icon,
				frecency: w,
				lastAt: v.at,
				visits: 1,
			});
	}
	return [...byPage.values()].sort(
		(a, b) => b.frecency - a.frecency || b.lastAt - a.lastAt,
	);
}

export interface RankOptions {
	/** The typed text reads as an address, not a search: its URL (SearchBuilder's rules, box.ts) is no results page of the engine. */
	urlLike: boolean;
	/** Where the default row goes: the address as typed, or the search engine's results. */
	defaultUrl: string;
}

/** The row that's always first: open what was typed. */
export const defaultRow = (query: string, opts: RankOptions): Suggestion => ({
	kind: opts.urlLike ? 'url' : 'search',
	id: 'default',
	title: query,
	url: opts.defaultUrl,
	displayUrl: query,
	score: 1.1,
	fill: query,
});

/** Dedupes, caps and orders candidates for a query; the default row is first, then groups by their best row. */
export function rankAndGroup(
	query: string,
	candidates: Suggestion[],
	opts: RankOptions,
): Ranked {
	const fq = fold(query);
	const aboutOnly = fq.startsWith('about:');
	const openPages = new Set(
		candidates
			.filter((c) => c.kind === 'tab' && c.url)
			.map((c) => canonicalUrl(c.url as string)),
	);
	const seen = new Set<string>();
	const kept = candidates
		.filter((c) => c.score > 0 && (!aboutOnly || c.kind === 'page'))
		// An open tab for the page beats reopening it from history; a completion that just repeats the query says nothing.
		.filter(
			(c) => !(c.kind === 'url' && c.url && openPages.has(canonicalUrl(c.url))),
		)
		.filter((c) => !(c.kind === 'completion' && fold(c.title) === fq))
		.filter((c) => !seen.has(c.id) && seen.add(c.id))
		.sort((a, b) => b.score - a.score);
	const perKind = new Map<SuggestionKind, number>();
	const rows: Suggestion[] = [];
	for (const c of kept) {
		if (rows.length >= MAX_ROWS) break;
		const n = perKind.get(c.kind) ?? 0;
		if (n >= (CAPS[c.kind] ?? DEFAULT_CAP)) continue;
		perKind.set(c.kind, n + 1);
		rows.push(c);
	}
	const groups: SuggestionGroup[] = [
		{ key: 'default', rows: [defaultRow(query, opts)] },
	];
	const byKind = new Map<SuggestionKind, Suggestion[]>();
	for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
	// Rows arrive best first, so a group's first row is its best; order the groups by it.
	for (const [kind, list] of [...byKind.entries()].sort(
		(a, b) => b[1][0].score - a[1][0].score,
	))
		groups.push({ key: kind, rows: list });
	return { groups, rows: groups.flatMap((g) => g.rows) };
}

export interface PickParts {
	/** The host's own rows to go back to (SystemYA's games and last song), shown first, three at most. */
	jump?: Suggestion[];
	/** Most recent first; sites open in a tab are left out by the caller. */
	recentSites: Suggestion[];
	/** Most frecent first. */
	topSites: Suggestion[];
	openTabs: Suggestion[];
}

/** The empty box's list: what to go back to, the sites visited most, and the other open tabs. Empty when there's nothing. */
export function topPicks(parts: PickParts): Ranked {
	const used = new Set<string>();
	const take = (list: Suggestion[], n: number) => {
		const out: Suggestion[] = [];
		for (const s of list) {
			if (out.length >= n) break;
			if (used.has(s.id)) continue;
			used.add(s.id);
			out.push(s);
		}
		return out;
	};
	const jump = [...take(parts.jump ?? [], 3), ...take(parts.recentSites, 2)];
	const top = take(parts.topSites, 4);
	const tabs = take(parts.openTabs, 2);
	const groups: SuggestionGroup[] = [];
	let left = MAX_PICKS;
	for (const [key, list] of [
		['jump', jump],
		['top', top],
		['tab', tabs],
	] as [GroupKey, Suggestion[]][]) {
		const rows = list.slice(0, left);
		left -= rows.length;
		if (rows.length) groups.push({ key, rows });
	}
	return { groups, rows: groups.flatMap((g) => g.rows) };
}
