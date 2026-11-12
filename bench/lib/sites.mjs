// The real-site corpus for the site-support scenario: public pages a person
// opens without signing in, picked to cover what a proxy has to get right.
// Categories follow the brief (search, news, video, social read-only pages,
// docs, shopping, maps, games, single-page apps, sites behind Cloudflare or
// another bot wall, and sites that lean on WebSocket, WebRTC, workers, WASM
// or service workers). `features` names what a page is known to use, for
// the per-feature breakdown; `search` is the scripted search interaction
// (a selector to type into, then Enter) where the page has an obvious box.
//
// Volume: each site is loaded natively twice and once per proxied row, plus
// one follow-up navigation per load for the link or search interaction,
// spread over the whole run. No sign-in, no challenge is ever answered: a
// challenge page is recorded as the result.

export const SITES = [
	// search
	{
		id: 'google',
		url: 'https://www.google.com/',
		category: 'search',
		search: {
			selector: 'textarea[name=q], input[name=q]',
			text: 'web browser history',
		},
	},
	{
		id: 'bing',
		url: 'https://www.bing.com/',
		category: 'search',
		search: { selector: '#sb_form_q', text: 'web browser history' },
	},
	{
		id: 'duckduckgo',
		url: 'https://duckduckgo.com/',
		category: 'search',
		search: { selector: 'input[name=q]', text: 'web browser history' },
	},
	{
		id: 'brave-search',
		url: 'https://search.brave.com/',
		category: 'search',
		search: {
			selector: 'textarea[name=q], input[name=q]',
			text: 'web browser history',
		},
	},
	{
		id: 'startpage',
		url: 'https://www.startpage.com/',
		category: 'search',
		search: { selector: 'input[name=query]', text: 'web browser history' },
	},
	{
		id: 'yahoo',
		url: 'https://search.yahoo.com/',
		category: 'search',
		search: { selector: 'input[name=p]', text: 'web browser history' },
	},
	// news
	{ id: 'bbc', url: 'https://www.bbc.com/news', category: 'news' },
	{ id: 'cnn', url: 'https://www.cnn.com/', category: 'news' },
	{
		id: 'nytimes',
		url: 'https://www.nytimes.com/',
		category: 'news',
		features: ['bot-wall'],
	},
	{
		id: 'guardian',
		url: 'https://www.theguardian.com/international',
		category: 'news',
	},
	{
		id: 'reuters',
		url: 'https://www.reuters.com/',
		category: 'news',
		features: ['bot-wall'],
	},
	{ id: 'apnews', url: 'https://apnews.com/', category: 'news' },
	{ id: 'npr', url: 'https://www.npr.org/', category: 'news' },
	{ id: 'aljazeera', url: 'https://www.aljazeera.com/', category: 'news' },
	// video and audio
	{
		id: 'youtube',
		url: 'https://www.youtube.com/',
		category: 'video',
		features: ['workers'],
		search: {
			selector: 'input[name=search_query]',
			text: 'web browser history',
		},
	},
	{
		id: 'twitch',
		url: 'https://www.twitch.tv/directory',
		category: 'video',
		features: ['websocket', 'wasm'],
	},
	{
		id: 'vimeo',
		url: 'https://vimeo.com/watch',
		category: 'video',
		features: ['cloudflare'],
	},
	{ id: 'dailymotion', url: 'https://www.dailymotion.com/', category: 'video' },
	{
		id: 'soundcloud',
		url: 'https://soundcloud.com/discover',
		category: 'video',
	},
	{ id: 'archive', url: 'https://archive.org/', category: 'video' },
	// social pages readable without an account
	{
		id: 'reddit',
		url: 'https://www.reddit.com/r/programming/',
		category: 'social',
		features: ['bot-wall'],
	},
	{
		id: 'hackernews',
		url: 'https://news.ycombinator.com/',
		category: 'social',
	},
	{
		id: 'mastodon',
		url: 'https://mastodon.social/explore',
		category: 'social',
		features: ['websocket', 'service-worker'],
	},
	{
		id: 'bluesky',
		url: 'https://bsky.app/',
		category: 'social',
		features: ['spa'],
	},
	{
		id: 'tumblr',
		url: 'https://www.tumblr.com/explore/trending',
		category: 'social',
	},
	{
		id: 'x',
		url: 'https://x.com/',
		category: 'social',
		features: ['spa', 'service-worker'],
	},
	{ id: 'lobsters', url: 'https://lobste.rs/', category: 'social' },
	{
		id: 'quora',
		url: 'https://www.quora.com/',
		category: 'social',
		features: ['cloudflare'],
	},
	// documentation and reference
	{
		id: 'wikipedia',
		url: 'https://en.wikipedia.org/wiki/Web_browser',
		category: 'docs',
		search: { selector: 'input[name=search]', text: 'proxy server' },
	},
	{
		id: 'mdn',
		url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
		category: 'docs',
	},
	{ id: 'python-docs', url: 'https://docs.python.org/3/', category: 'docs' },
	{ id: 'github', url: 'https://github.com/nodejs/node', category: 'docs' },
	{
		id: 'stackoverflow',
		url: 'https://stackoverflow.com/questions',
		category: 'docs',
		features: ['cloudflare'],
	},
	{
		id: 'ms-learn',
		url: 'https://learn.microsoft.com/en-us/',
		category: 'docs',
	},
	{
		id: 'react-dev',
		url: 'https://react.dev/',
		category: 'docs',
		features: ['spa'],
	},
	{ id: 'w3schools', url: 'https://www.w3schools.com/', category: 'docs' },
	// shopping
	{
		id: 'amazon',
		url: 'https://www.amazon.com/',
		category: 'shopping',
		features: ['bot-wall'],
		search: { selector: '#twotabsearchtextbox', text: 'usb cable' },
	},
	{
		id: 'ebay',
		url: 'https://www.ebay.com/',
		category: 'shopping',
		features: ['bot-wall'],
		search: { selector: '#gh-ac', text: 'usb cable' },
	},
	{
		id: 'etsy',
		url: 'https://www.etsy.com/',
		category: 'shopping',
		features: ['bot-wall'],
	},
	{
		id: 'walmart',
		url: 'https://www.walmart.com/',
		category: 'shopping',
		features: ['bot-wall'],
	},
	{ id: 'ikea', url: 'https://www.ikea.com/us/en/', category: 'shopping' },
	{
		id: 'bestbuy',
		url: 'https://www.bestbuy.com/',
		category: 'shopping',
		features: ['bot-wall'],
	},
	// maps
	{
		id: 'google-maps',
		url: 'https://www.google.com/maps',
		category: 'maps',
		features: ['workers', 'wasm', 'webgl'],
	},
	{
		id: 'openstreetmap',
		url: 'https://www.openstreetmap.org/',
		category: 'maps',
	},
	{ id: 'bing-maps', url: 'https://www.bing.com/maps', category: 'maps' },
	// games
	{ id: 'poki', url: 'https://poki.com/', category: 'games' },
	{ id: 'crazygames', url: 'https://www.crazygames.com/', category: 'games' },
	{
		id: 'lichess',
		url: 'https://lichess.org/',
		category: 'games',
		features: ['websocket', 'wasm', 'workers'],
	},
	{
		id: 'chess',
		url: 'https://www.chess.com/play',
		category: 'games',
		features: ['websocket', 'cloudflare'],
	},
	{ id: '2048', url: 'https://play2048.co/', category: 'games' },
	{
		id: 'krunker',
		url: 'https://krunker.io/',
		category: 'games',
		features: ['websocket', 'wasm', 'webgl'],
	},
	{ id: 'neal-fun', url: 'https://neal.fun/', category: 'games' },
	// single-page apps
	{
		id: 'excalidraw',
		url: 'https://excalidraw.com/',
		category: 'apps',
		features: ['spa', 'service-worker', 'workers'],
	},
	{
		id: 'drawio',
		url: 'https://app.diagrams.net/',
		category: 'apps',
		features: ['spa', 'service-worker'],
	},
	{
		id: 'photopea',
		url: 'https://www.photopea.com/',
		category: 'apps',
		features: ['wasm', 'workers'],
	},
	{
		id: 'vscode-dev',
		url: 'https://vscode.dev/',
		category: 'apps',
		features: ['spa', 'service-worker', 'workers'],
	},
	{
		id: 'squoosh',
		url: 'https://squoosh.app/',
		category: 'apps',
		features: ['wasm', 'workers', 'service-worker'],
	},
	{
		id: 'spotify',
		url: 'https://open.spotify.com/',
		category: 'apps',
		features: ['spa', 'websocket'],
	},
	{
		id: 'discord',
		url: 'https://discord.com/',
		category: 'apps',
		features: ['cloudflare'],
	},
	{ id: 'notion', url: 'https://www.notion.com/', category: 'apps' },
	{ id: 'figma', url: 'https://www.figma.com/', category: 'apps' },
	{
		id: 'google-docs',
		url: 'https://docs.google.com/document/u/0/',
		category: 'apps',
	},
	// behind Cloudflare (or another challenge vendor)
	{
		id: 'medium',
		url: 'https://medium.com/',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	{
		id: 'canva',
		url: 'https://www.canva.com/',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	{
		id: 'chatgpt',
		url: 'https://chatgpt.com/',
		category: 'cloudflare',
		features: ['cloudflare', 'spa'],
	},
	{
		id: 'nowsecure',
		url: 'https://nowsecure.nl/',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	{
		id: 'cloudflare',
		url: 'https://www.cloudflare.com/',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	{
		id: 'npmjs',
		url: 'https://www.npmjs.com/package/react',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	{
		id: 'glassdoor',
		url: 'https://www.glassdoor.com/',
		category: 'cloudflare',
		features: ['cloudflare'],
	},
	// pages built on WebSocket, WebRTC, workers, WASM or service workers
	{
		id: 'pyodide',
		url: 'https://pyodide.org/en/stable/console.html',
		category: 'platform',
		features: ['wasm', 'workers'],
	},
	{
		id: 'jitsi',
		url: 'https://meet.jit.si/',
		category: 'platform',
		features: ['webrtc', 'websocket'],
	},
	{
		id: 'whatsapp',
		url: 'https://web.whatsapp.com/',
		category: 'platform',
		features: ['websocket', 'service-worker', 'workers'],
	},
	{
		id: 'speedtest',
		url: 'https://www.speedtest.net/',
		category: 'platform',
		features: ['websocket'],
	},
	{
		id: 'webglsamples',
		url: 'https://webglsamples.org/aquarium/aquarium.html',
		category: 'platform',
		features: ['webgl'],
	},
	{
		id: 'wasm-doom',
		url: 'https://silentspacemarine.com/',
		category: 'platform',
		features: ['wasm'],
	},
	{
		id: 'godbolt',
		url: 'https://godbolt.org/',
		category: 'platform',
		features: ['workers', 'spa'],
	},
	{
		id: 'webrtc-samples',
		url: 'https://webrtc.github.io/samples/src/content/datachannel/basic/',
		category: 'platform',
		features: ['webrtc'],
	},
	{
		id: 'stackblitz',
		url: 'https://stackblitz.com/',
		category: 'platform',
		features: ['service-worker', 'wasm'],
	},
	// everyday sites
	{ id: 'weather', url: 'https://weather.com/', category: 'misc' },
	{
		id: 'imdb',
		url: 'https://www.imdb.com/chart/top/',
		category: 'misc',
		features: ['bot-wall'],
	},
	{ id: 'craigslist', url: 'https://sfbay.craigslist.org/', category: 'misc' },
	{ id: 'nasa', url: 'https://www.nasa.gov/', category: 'misc' },
	{ id: 'apple', url: 'https://www.apple.com/', category: 'misc' },
	{
		id: 'booking',
		url: 'https://www.booking.com/',
		category: 'misc',
		features: ['bot-wall'],
	},
	{ id: 'espn', url: 'https://www.espn.com/', category: 'misc' },
];

/**
 * Sites for the repeat-timed real-site loads (speed): large, stable,
 * no bot wall seen natively, light enough to load five times per row.
 */
export const TIMED_SITES = [
	'wikipedia',
	'mdn',
	'github',
	'hackernews',
	'bbc',
	'python-docs',
];
