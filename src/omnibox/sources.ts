/**
 * Rows of what a host knows, scored for the omnibox's ranker (after
 * SystemYA src/systemya/omni/sources.ts): its bookmarks, its history and
 * its open tabs. Each takes what it reads as an argument, so a host keeps
 * them wherever it likes.
 */
import {
	canonicalUrl,
	frecentSites,
	hostOf,
	scoreUrl,
	urlMatch,
	type FrecentSite,
	type HistoryEntry,
	type PickParts,
	type Suggestion,
} from './rank';

export interface Bookmark {
	url: string;
	title?: string;
	icon?: string | null;
}

export interface OpenTab {
	/** stable while the tab is open */
	id: string | number;
	url: string;
	title?: string;
	icon?: string | null;
	/** switch to the tab */
	activate(): void;
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

/**
 * Only icons this origin serves or holds: a site's own icon address would be
 * fetched by the host's page, outside the transport
 */
export const safeIcon = (icon: unknown): string | undefined =>
	typeof icon === 'string' &&
	(icon.startsWith('data:image/') || /^\/(?!\/)[\w./-]+$/.test(icon))
		? icon
		: undefined;

export const siteRow = (
	url: string,
	title: string | undefined,
	icon: string | undefined,
	score: number,
): Suggestion => ({
	kind: 'url',
	id: `url:${canonicalUrl(url)}`,
	title: title || hostOf(url),
	subtitle: hostOf(url),
	icon,
	url,
	displayUrl: url,
	score,
	fill: url,
});

/** a bookmark counts as a site the user goes to often, whatever the history says */
const BOOKMARK_FRECENCY = 4.5;

export const bookmarkRows = (q: string, list: Bookmark[]): Suggestion[] =>
	list
		.filter((b) => isWeb(b.url))
		.map((b) =>
			siteRow(
				b.url,
				b.title,
				safeIcon(b.icon),
				scoreUrl(urlMatch(q, b.url, b.title), BOOKMARK_FRECENCY),
			),
		);

/** the open tabs as "Switch to tab" rows; an open tab beats its page's history row */
export const tabRows = (q: string, tabs: OpenTab[]): Suggestion[] =>
	tabs
		.filter((tab) => isWeb(tab.url))
		.map((tab) => ({
			kind: 'tab',
			id: `tab:${tab.id}`,
			title: tab.title || hostOf(tab.url),
			subtitle: hostOf(tab.url),
			icon: safeIcon(tab.icon),
			url: tab.url,
			score: q ? urlMatch(q, tab.url, tab.title) * 1.05 : 1,
			fill: tab.url,
			run: () => tab.activate(),
		}));

/** history grouped by page, rebuilt only when the list of visits is another */
let frecentFor: { visits: unknown; sites: FrecentSite[] } | null = null;
const frecent = (visits: HistoryEntry[]) => {
	if (!frecentFor || frecentFor.visits !== visits)
		frecentFor = { visits, sites: frecentSites(visits) };
	return frecentFor.sites;
};

/** the history's sites, by frecency; `forget(url)` makes them removable with Shift+Delete */
export const historyRows = (
	q: string,
	visits: HistoryEntry[],
	forget?: (url: string) => void,
): Suggestion[] =>
	frecent(visits).map((s) => ({
		...siteRow(
			s.url,
			s.title,
			safeIcon(s.icon),
			scoreUrl(urlMatch(q, s.url, s.title), s.frecency),
		),
		...(forget && { forget: () => forget(s.url) }),
	}));

/** the empty box's sites: the latest and the most frecent, leaving out pages open in a tab */
export function historyPicks(
	visits: HistoryEntry[],
	openUrls: string[] = [],
): Pick<PickParts, 'recentSites' | 'topSites'> {
	const open = new Set(openUrls.map(canonicalUrl));
	const all = frecent(visits).filter((s) => !open.has(s.canonical));
	return {
		recentSites: [...all]
			.sort((a, b) => b.lastAt - a.lastAt)
			.map((s) => siteRow(s.url, s.title, safeIcon(s.icon), 1)),
		topSites: all.map((s) => siteRow(s.url, s.title, safeIcon(s.icon), 1)),
	};
}
