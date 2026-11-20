// The omnibox module's pure parts in node (src/omnibox/, the ranker tests
// SystemYA's tests/omni-rank.test.mjs and omni-history.test.mjs had):
//  - matching tiers, folding, multi-word queries, canonical URLs, frecency;
//  - rankAndGroup: an open tab hides its page's history row, about: shows
//    pages only, the default row, the caps, a completion that repeats the
//    query; topPicks: the host's own rows, recent and top sites, open tabs;
//  - the visit history: one visit per page a tab reaches, only this
//    origin's icons, the cap, forget and clear, a bad stored copy;
//  - history and bookmark rows, the empty box's sites;
//  - controller.suggest()'s parts: the engine a name or a template names,
//    the endpoint it asks, an OpenSearch answer's completions.
// Skips when esbuild is not installed, as the other unit suites do.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP omnibox-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}omnibox-unit-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/omnibox/rank.ts`)};
export * from ${JSON.stringify(`${root}src/omnibox/history.ts`)};
export * from ${JSON.stringify(`${root}src/omnibox/sources.ts`)};
export { searchEngine, SEARCH_ENGINES } from ${JSON.stringify(`${root}src/bootstrapper/searchEngines.ts`)};
export { parseSuggestions, suggestUrl } from ${JSON.stringify(`${root}src/controller/suggest.ts`)};
`,
);
const bundle = `${OUT}omnibox-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const O = await import(`${bundle}?${Date.now()}`);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 1_800_000_000_000;
const row = (kind, id, score, extra = {}) => ({
	kind,
	id,
	title: id,
	score,
	...extra,
});
const searchOpts = {
	urlLike: false,
	defaultUrl: 'https://duckduckgo.com/?q=x',
};

// ---- matching ---------------------------------------------------------------
ok(
	'matching tiers: exact, prefix, word prefix, substring',
	O.matchScore('youtube', 'youtube') === 1 &&
		O.matchScore('you', 'youtube') === 0.85 &&
		O.matchScore('tube', 'my tube') === 0.7 &&
		O.matchScore('tub', 'youtube') === 0.5 &&
		O.matchScore('vimeo', 'youtube') === 0,
);
ok(
	'folding ignores case, accents, the scheme, www. and a trailing slash',
	O.fold('https://www.Beyoncé.com/') === 'beyonce.com' &&
		O.matchScore('beyonce', 'Beyoncé') === 1 &&
		O.urlMatch('youtube', 'https://www.youtube.com/') === 1,
	O.fold('https://www.Beyoncé.com/'),
);
ok(
	'a multi-word query needs every word',
	O.matchScore('post malone', 'Post Malone - Better Now') > 0 &&
		O.matchScore('post drake', 'Post Malone - Better Now') === 0,
);
ok(
	'canonical URLs drop the hash and a trailing slash but keep the query',
	O.canonicalUrl('https://YouTube.com/watch?v=1#t=2') ===
		'https://youtube.com/watch?v=1' &&
		O.canonicalUrl('https://example.com/a/') ===
			O.canonicalUrl('https://example.com/a'),
);
{
	const visits = [
		...Array.from({ length: 3 }, (_, i) => ({
			url: 'https://new.example/',
			title: 'New',
			at: now - i * HOUR,
		})),
		...Array.from({ length: 10 }, (_, i) => ({
			url: 'https://old.example/',
			title: 'Old',
			at: now - 60 * DAY - i * HOUR,
		})),
	];
	const sites = O.frecentSites(visits, now);
	ok(
		'frecency: a few recent visits beat many old ones, and the score saturates',
		sites[0].url === 'https://new.example/' &&
			sites[0].frecency > sites[1].frecency &&
			O.scoreUrl(1, 1000) < 1 &&
			O.scoreUrl(1, 1000) > 0.99 &&
			O.scoreUrl(1, 3) > 0.79 &&
			O.scoreUrl(1, 3) < 0.81,
		JSON.stringify(sites.map((s) => [s.url, s.frecency])),
	);
}

// ---- ranking ----------------------------------------------------------------
{
	const ranked = O.rankAndGroup(
		'yout',
		[
			row('url', 'url:yt', 0.8, { url: 'https://www.youtube.com/' }),
			row('tab', 'tab:1', 0.85, { url: 'https://youtube.com' }),
			row('url', 'url:other', 0.6, { url: 'https://youtu.be/x' }),
		],
		searchOpts,
	);
	ok(
		'an open tab for the page hides its history row and sorts first',
		same(
			ranked.rows.map((r) => r.id),
			['default', 'tab:1', 'url:other'],
		),
		JSON.stringify(ranked.rows.map((r) => r.id)),
	);
}
{
	const ranked = O.rankAndGroup(
		'about:se',
		[
			row('page', 'page:settings', 0.9),
			row('url', 'url:x', 0.9, { url: 'https://x.y' }),
			row('game', 'game:a', 0.9),
		],
		{ urlLike: true, defaultUrl: 'about:se' },
	);
	ok(
		'an about: query shows only pages after the default row',
		same(
			ranked.rows.map((r) => r.kind),
			['url', 'page'],
		),
		JSON.stringify(ranked.rows.map((r) => r.kind)),
	);
}
ok(
	'the default row is Go to for an address and Search for words',
	O.defaultRow('example.com', {
		urlLike: true,
		defaultUrl: 'https://example.com',
	}).kind === 'url' &&
		O.defaultRow('how to tie a tie', searchOpts).kind === 'search' &&
		O.rankAndGroup('x', [], searchOpts).rows[0].id === 'default',
);
{
	// a host's own kinds (SystemYA's games and songs) are capped at three
	const many = [
		...Array.from({ length: 8 }, (_, i) =>
			row('url', `url:${i}`, 0.7 - i * 0.01, { url: `https://s${i}.example/` }),
		),
		...Array.from({ length: 6 }, (_, i) =>
			row('completion', `c:${i}`, 0.55 - i * 0.02),
		),
		row('game', 'game:1', 0.95),
		...Array.from({ length: 5 }, (_, i) =>
			row('song', `song:${i}`, 0.6 - i * 0.01),
		),
	];
	const ranked = O.rankAndGroup('s', many, searchOpts);
	const count = (kind) => ranked.rows.filter((r) => r.kind === kind).length;
	ok(
		'caps: ten rows after the default, each kind capped, groups ordered by their best row',
		ranked.rows.length === 11 &&
			ranked.groups[1].key === 'game' &&
			count('url') === 4 &&
			count('song') === 3 &&
			// one game, four sites and three songs fill eight of the ten
			count('completion') === 2,
		JSON.stringify(ranked.rows.map((r) => r.id)),
	);
}
{
	const ranked = O.rankAndGroup(
		'Weather',
		[
			row('completion', 'c:1', 0.55, { title: 'weather' }),
			row('completion', 'c:2', 0.53, { title: 'weather tomorrow' }),
		],
		searchOpts,
	);
	ok(
		'a completion that only repeats the query is dropped',
		same(
			ranked.rows.map((r) => r.id),
			['default', 'c:2'],
		),
	);
}
{
	const picks = O.topPicks({
		jump: [
			row('game', 'game:a', 1),
			row('game', 'game:b', 1),
			row('song', 'song:1', 1),
		],
		recentSites: [
			row('url', 'url:1', 1),
			row('url', 'url:2', 1),
			row('url', 'url:3', 1),
		],
		topSites: [
			row('url', 'url:1', 1),
			row('url', 'url:4', 1),
			row('url', 'url:5', 1),
			row('url', 'url:6', 1),
			row('url', 'url:7', 1),
		],
		openTabs: [
			row('tab', 'tab:1', 1),
			row('tab', 'tab:2', 1),
			row('tab', 'tab:3', 1),
		],
	});
	ok(
		'top picks: jump back in, top sites and open tabs, at most eight, no default row',
		picks.rows.length === 8 &&
			same(
				picks.groups.map((g) => g.key),
				['jump', 'top'],
			) &&
			same(
				picks.groups[0].rows.map((r) => r.id),
				['game:a', 'game:b', 'song:1', 'url:1', 'url:2'],
			) &&
			// url:1 was already shown under Jump back in
			same(
				picks.groups[1].rows.map((r) => r.id),
				['url:4', 'url:5', 'url:6'],
			) &&
			picks.rows.every((r) => r.id !== 'default') &&
			O.topPicks({ recentSites: [], topSites: [], openTabs: [] }).rows
				.length === 0,
		JSON.stringify(picks.groups),
	);
	const tabsOnly = O.topPicks({
		recentSites: [],
		topSites: [],
		openTabs: [
			row('tab', 'tab:1', 1),
			row('tab', 'tab:2', 1),
			row('tab', 'tab:3', 1),
		],
	});
	ok(
		'top picks with only open tabs: two of them',
		same(
			tabsOnly.groups.map((g) => [g.key, g.rows.length]),
			[['tab', 2]],
		),
	);
}

// ---- the visit history ------------------------------------------------------
const fakeStore = () => {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		map,
	};
};
{
	const store = fakeStore();
	const history = O.visitHistory({ store });
	const tab = {};
	history.record(tab, { url: 'https://a.example/' }, 1);
	// the same page reported again, now with its title: the same visit
	history.record(tab, { url: 'https://a.example/', title: 'A' }, 2);
	history.record(tab, { url: 'https://a.example/' }, 3);
	history.record(tab, { url: 'about:blank' }, 4);
	history.record(tab, { url: 'https://b.example/', title: 'B' }, 5);
	// another tab on the same page is another visit
	history.record({}, { url: 'https://b.example/' }, 6);
	const visits = history.visits();
	ok(
		'a visit is recorded once per page a tab reaches, newest first, web pages only',
		same(
			visits.map((v) => [v.url, v.title, v.at]),
			[
				['https://b.example/', '', 6],
				['https://b.example/', 'B', 5],
				['https://a.example/', 'A', 1],
			],
		) && new Set(visits.map((v) => v.id)).size === 3,
		JSON.stringify(visits),
	);
	ok(
		'the history is kept under omnibox:visits, a name of no package or proxy',
		store.map.has('omnibox:visits') &&
			!/stomp|sysce|epoxy|libcurl|powermouse|adblock|rewriter|proxy/i.test(
				'omnibox:visits',
			),
		JSON.stringify([...store.map.keys()]),
	);
	history.forget('https://b.example');
	ok(
		'forget drops every visit of the page',
		same(
			history.visits().map((v) => v.url),
			['https://a.example/'],
		),
	);
}
{
	const store = fakeStore();
	const history = O.visitHistory({ store });
	history.record(
		{},
		{ url: 'https://a.example/', icon: 'https://a.example/favicon.ico' },
	);
	history.record(
		{},
		{ url: 'https://b.example/', icon: 'data:image/png;base64,AA' },
	);
	ok(
		"only this origin's icons are kept",
		same(
			history.visits().map((v) => v.icon ?? null),
			['data:image/png;base64,AA', null],
		),
	);
}
{
	const store = fakeStore();
	const history = O.visitHistory({ store, cap: 50 });
	for (let i = 0; i < 75; i++)
		history.record({}, { url: `https://s${i}.example/` }, i);
	const visits = history.visits();
	ok(
		'the history keeps the newest visits up to the cap',
		visits.length === 50 &&
			visits[0].url === 'https://s74.example/' &&
			visits.at(-1).url === 'https://s25.example/',
	);
}
{
	const store = fakeStore();
	const history = O.visitHistory({ store });
	const tab = {};
	history.record(tab, { url: 'https://a.example/' });
	history.clear();
	const cleared =
		history.visits().length === 0 && !store.map.has('omnibox:visits');
	// the tab's last visit went with it: the same page again is a new visit
	history.record(tab, { url: 'https://a.example/', title: 'A' });
	const again = history.visits().length === 1;
	store.setItem('omnibox:visits', '{not json');
	const bad = history.visits().length === 0;
	store.setItem('omnibox:visits', JSON.stringify([{ url: 1 }, null]));
	const wrong = history.visits().length === 0;
	ok(
		'clearing forgets every visit, and a bad stored copy reads as none',
		cleared && again && bad && wrong,
		JSON.stringify({ cleared, again, bad, wrong }),
	);
}

// ---- rows of the host's sources ---------------------------------------------
{
	const t = Date.now();
	const visits = [
		{ id: '1', url: 'https://news.example/', title: 'News', at: t - 1000 },
		{ id: '2', url: 'https://often.example/', title: 'Often', at: t - 2000 },
		{ id: '3', url: 'https://often.example/', title: 'Often', at: t - 3000 },
		{ id: '4', url: 'https://often.example/', title: 'Often', at: t - 4000 },
	];
	const forgotten = [];
	const rows = O.historyRows('often', visits, (url) => forgotten.push(url));
	const often = rows.find((r) => r.url === 'https://often.example/');
	often.forget();
	const picks = O.historyPicks(visits, ['https://news.example']);
	ok(
		'history ranks by frecency and the empty box gets the latest and the most visited',
		often.score > 0.79 &&
			often.score < 0.81 &&
			rows.find((r) => r.url === 'https://news.example/').score === 0 &&
			same(
				picks.recentSites.map((r) => r.url),
				['https://often.example/'],
			) &&
			same(
				picks.topSites.map((r) => r.url),
				['https://often.example/'],
			) &&
			same(forgotten, ['https://often.example/']),
		JSON.stringify(rows.map((r) => [r.url, r.score])),
	);
}
{
	const rows = O.bookmarkRows('redd', [
		{
			url: 'https://www.reddit.com/',
			title: 'Reddit',
			icon: '/pm/icons/reddit.png',
		},
		{ url: 'javascript:alert(1)', title: 'Reddit' },
	]);
	ok(
		'a bookmark is a site row, web addresses only, scored as a site visited often',
		rows.length === 1 &&
			rows[0].kind === 'url' &&
			rows[0].icon === '/pm/icons/reddit.png' &&
			rows[0].score > 0.6,
		JSON.stringify(rows),
	);
}
{
	let activated = 0;
	const rows = O.tabRows('bookm', [
		{
			id: 7,
			url: 'https://a.example/b',
			title: 'bookmark a',
			activate: () => activated++,
		},
		{ id: 8, url: 'about:blank', title: 'blank', activate: () => {} },
	]);
	rows[0].run();
	ok(
		'an open tab is a Switch to tab row that activates it',
		rows.length === 1 &&
			rows[0].kind === 'tab' &&
			rows[0].id === 'tab:7' &&
			rows[0].score > 0.7 &&
			activated === 1,
		JSON.stringify(rows),
	);
}
ok(
	'only icons of this origin or data URLs are shown',
	O.safeIcon('/pm/icons/a.png') === '/pm/icons/a.png' &&
		O.safeIcon('data:image/png;base64,AA') === 'data:image/png;base64,AA' &&
		O.safeIcon('//evil.example/a.png') === undefined &&
		O.safeIcon('https://site.example/favicon.ico') === undefined,
);

// ---- controller.suggest()'s parts ---------------------------------------------
ok(
	'an engine by its id or by a SearchBuilder template of it, null for another',
	O.searchEngine('brave')?.id === 'brave' &&
		O.searchEngine('https://search.brave.com/search?q=%s')?.id === 'brave' &&
		O.searchEngine('https://google.com/search?q=%s')?.id === 'google' &&
		O.searchEngine('https://example.com/?q=%s') === null &&
		O.searchEngine('brave.com') === null,
);
ok(
	"Startpage asks DuckDuckGo's completions; every endpoint is https with %s",
	O.searchEngine('startpage').suggest ===
		O.searchEngine('duckduckgo').suggest &&
		O.SEARCH_ENGINES.every(
			(e) => e.suggest.startsWith('https://') && e.suggest.includes('%s'),
		),
);
ok(
	'the endpoint: the engine named, Google by default, or the one given',
	O.suggestUrl('a b&c', { engine: 'bing' }).href ===
		'https://www.bing.com/osjson.aspx?query=a%20b%26c' &&
		O.suggestUrl('x', {}).hostname === 'www.google.com' &&
		O.suggestUrl('x', { endpoint: 'http://127.0.0.1:1/s?q=%s' }).href ===
			'http://127.0.0.1:1/s?q=x',
);
{
	const refused = [
		{ engine: 'altavista' },
		{ endpoint: 'https://a.example/s' },
		{ endpoint: 'javascript:%s' },
	].map((options) => {
		try {
			O.suggestUrl('x', options);
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	});
	ok(
		'an unknown engine, an endpoint without %s or off the web is a TypeError',
		refused.every(Boolean),
		JSON.stringify(refused),
	);
}
ok(
	"an OpenSearch answer's completions: trimmed, once each, not the query, at most the limit",
	same(
		O.parseSuggestions(
			[
				'Wea',
				['wea', ' weather  now ', 'Weather now', { phrase: 'weasel' }, 7],
			],
			'wea',
		),
		['weather now', 'weasel'],
	) &&
		O.parseSuggestions(['q', ['a', 'b', 'c']], 'q', 2).length === 2 &&
		O.parseSuggestions({ s: ['a'] }, 'q').length === 0 &&
		O.parseSuggestions(null, 'q').length === 0,
);

await done();
