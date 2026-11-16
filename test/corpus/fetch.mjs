// Collects the real-site rewrite corpus that test/corpus/check.mjs checks:
// the scripts the login and home pages of heavy sites load, fetched with
// plain HTTP (no browser, no login, no challenge). For each page: its HTML,
// every <script> in it (inline and external, classic and module), the
// scripts its <link rel=modulepreload|preload as=script> name, the static
// and literal dynamic imports of each module (a few levels deep) and the
// workers a script names by a literal URL. Each script is stored once under
// its sha256 and listed in manifest.json with the URL it came from, its
// kind, size and the date it was fetched.
//
//   node test/corpus/fetch.mjs <out dir> [site ...]
//
// Never run from CI: it reaches third-party sites. A page that answers with
// a bot check (Cloudflare's `cf-mitigated: challenge`, a challenge-platform
// script) is recorded as such and none of its scripts are fetched.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

export const SITES = {
	discord: ['https://discord.com/login', 'https://discord.com/'],
	youtube: [
		'https://www.youtube.com/',
		'https://www.youtube.com/watch?v=jNQXAC9IVRw',
	],
	google: [
		'https://www.google.com/',
		'https://www.google.com/search?q=weather',
	],
	gmail: ['https://accounts.google.com/ServiceLogin?service=mail'],
	x: ['https://x.com/', 'https://x.com/i/flow/login'],
	reddit: ['https://www.reddit.com/'],
	github: ['https://github.com/', 'https://github.com/login'],
	facebook: ['https://www.facebook.com/'],
	instagram: ['https://www.instagram.com/'],
	tiktok: ['https://www.tiktok.com/'],
	twitch: ['https://www.twitch.tv/'],
	spotify: ['https://open.spotify.com/'],
	netflix: ['https://www.netflix.com/login'],
	amazon: ['https://www.amazon.com/'],
	ebay: ['https://www.ebay.com/'],
	wikipedia: ['https://en.wikipedia.org/wiki/Main_Page'],
	cnn: ['https://www.cnn.com/'],
	nytimes: ['https://www.nytimes.com/'],
	docs: ['https://docs.google.com/'],
	office: ['https://www.office.com/', 'https://outlook.live.com/mail/'],
	notion: ['https://www.notion.so/login'],
	figma: ['https://www.figma.com/login'],
	slack: ['https://slack.com/signin', 'https://app.slack.com/'],
	zoom: ['https://zoom.us/signin'],
	cloudflare: ['https://dash.cloudflare.com/login'],
	roblox: ['https://www.roblox.com/login'],
	crazygames: ['https://www.crazygames.com/'],
	kits4beats: ['https://kits4beats.com/'],
	linkedin: ['https://www.linkedin.com/login'],
	pinterest: ['https://www.pinterest.com/'],
	yahoo: ['https://www.yahoo.com/'],
	bing: ['https://www.bing.com/', 'https://www.bing.com/search?q=weather'],
	duckduckgo: ['https://duckduckgo.com/'],
	chatgpt: ['https://chatgpt.com/'],
	claude: ['https://claude.ai/login'],
	stackoverflow: ['https://stackoverflow.com/questions'],
	medium: ['https://medium.com/'],
	imgur: ['https://imgur.com/'],
	archive: ['https://archive.org/'],
	steam: ['https://store.steampowered.com/'],
};

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const PAGE_HEADERS = {
	'user-agent': UA,
	accept:
		'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'accept-language': 'en-US,en;q=0.9',
	// (with Chrome's sec-fetch-* headers and no client hints Google's sign-in
	// page answers 401)
	'upgrade-insecure-requests': '1',
};
// and Facebook's answers 400 without them: a page that refuses one set is
// asked again with the other
const NAVIGATE_HEADERS = {
	...PAGE_HEADERS,
	'sec-fetch-dest': 'document',
	'sec-fetch-mode': 'navigate',
	'sec-fetch-site': 'none',
	'sec-fetch-user': '?1',
};
const SCRIPT_HEADERS = {
	'user-agent': UA,
	accept: '*/*',
	'accept-language': 'en-US,en;q=0.9',
};
// a page's scripts at most, and how deep module imports are followed
const PER_PAGE = 400;
const IMPORT_DEPTH = 3;
// a script of a bot check, never fetched (Cloudflare's, on pages that are no
// check themselves too: discord.com and zoom.us carry its beacon)
const CHALLENGE = /\/cdn-cgi\/challenge-platform\//;
// a page that is a bot check in place of the site
const CHECK_PAGE = /<title>Just a moment\.\.\.<\/title>|[?&]bm-verify=/;
const JS_TYPES =
	/^(?:|text\/javascript|application\/javascript|application\/x-javascript|text\/ecmascript|application\/ecmascript|text\/jscript|text\/livescript|module)$/i;

const decodeEntities = (text) =>
	text
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
			String.fromCodePoint(parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(+dec));

function attributes(text) {
	const out = {};
	for (const [, name, a, b, c] of text.matchAll(
		/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
	))
		out[name.toLowerCase()] = decodeEntities(a ?? b ?? c ?? '');
	return out;
}

/** what a page's HTML names: inline and external scripts, preloads, its base */
export function scriptsOf(html, pageURL) {
	let base = pageURL;
	const tag = html.match(/<base\b([^>]*)>/i);
	if (tag) {
		const href = attributes(tag[1]).href;
		try {
			if (href) base = new URL(href, pageURL).href;
		} catch {
			// (no URL: the page's own stays the base)
		}
	}
	const found = [];
	const resolve = (src) => {
		try {
			return new URL(src.trim(), base).href;
		} catch {
			return null;
		}
	};
	for (const [, attrs, body] of html.matchAll(
		/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
	)) {
		const a = attributes(attrs);
		const type = (a.type ?? '').trim().split(';')[0];
		if (!JS_TYPES.test(type)) continue;
		const kind = type.toLowerCase() === 'module' ? 'module' : 'classic';
		if ('src' in a) {
			const data = /^\s*data:([^,]*),(.*)$/s.exec(a.src);
			if (data)
				found.push({
					inline: /;base64$/i.test(data[1])
						? Buffer.from(data[2], 'base64').toString('utf8')
						: decodeURIComponent(data[2]),
					kind,
					data: true,
				});
			else {
				const url = resolve(a.src);
				if (url) found.push({ url, kind });
			}
		} else if (body.trim()) found.push({ inline: body, kind });
	}
	for (const [, attrs] of html.matchAll(/<link\b([^>]*)>/gi)) {
		const a = attributes(attrs);
		const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
		if (!a.href) continue;
		const url = resolve(a.href);
		if (!url) continue;
		if (rel.includes('modulepreload')) found.push({ url, kind: 'module' });
		else if (
			(rel.includes('preload') || rel.includes('prefetch')) &&
			(a.as ?? '').toLowerCase() === 'script'
		)
			// a preload says nothing of the goal it is for
			found.push({ url, kind: 'unknown' });
	}
	// the chunks a page's bootloader is told of in its HTML (Facebook's and
	// Instagram's rsrc.php lists, webpack manifests in a JSON blob)
	for (const [, written] of html.matchAll(
		/["'(]((?:https?:)?(?:\\?\/){2}[\w.-]+(?:\\?\/[\w.@~%+-]*)*\.js(?:\?[^"'\s<>\\]*)?)["')]/g,
	)) {
		const url = resolve(written.replace(/\\\//g, '/'));
		if (url) found.push({ url, kind: 'unknown', named: true });
	}
	return found;
}

/** the inline event handlers of a page's markup (function bodies to the browser) */
export function handlersOf(html) {
	const out = [];
	const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	for (const [, attrs] of markup.matchAll(/<[a-zA-Z][\w:-]*\b([^>]*)>/g)) {
		if (!/\bon[a-z]+\s*=/i.test(attrs)) continue;
		for (const [name, value] of Object.entries(attributes(attrs)))
			if (/^on[a-z]+$/.test(name) && value.trim()) out.push({ name, value });
	}
	return out;
}

/** the URLs a module imports by a literal (static, re-exported, dynamic) */
export function importsOf(text, url) {
	const out = new Set();
	const specifiers = [
		...text.matchAll(
			/(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"'\n]+)["']/g,
		),
		...text.matchAll(/\bimport\(\s*["']([^"'\n]+)["']\s*[,)]/g),
	].map((match) => match[1]);
	for (const specifier of specifiers) {
		if (!/^(?:\.{0,2}\/|https?:)/.test(specifier)) continue;
		try {
			out.add(new URL(specifier, url).href);
		} catch {
			// (no URL)
		}
	}
	return [...out];
}

/** the workers a script starts by a literal URL */
export function workersOf(text, url) {
	const out = [];
	for (const [, , specifier, rest] of text.matchAll(
		/new\s+(Worker|SharedWorker)\s*\(\s*(?:new\s+URL\s*\(\s*)?["']([^"'\n]+)["']([^;]{0,120})/g,
	)) {
		if (!/^(?:\.{0,2}\/|https?:)/.test(specifier)) continue;
		try {
			out.push({
				url: new URL(specifier, url).href,
				kind: /type\s*:\s*["']module["']/.test(rest)
					? 'workerModule'
					: 'worker',
			});
		} catch {
			// (no URL)
		}
	}
	return out;
}

async function get(url, headers, referer) {
	const response = await fetch(url, {
		headers: referer ? { ...headers, referer } : headers,
		redirect: 'follow',
		signal: AbortSignal.timeout(45_000),
	});
	const bytes = Buffer.from(await response.arrayBuffer());
	return { response, bytes };
}

async function pool(items, size, work) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await work(items[next++]);
		}),
	);
}

async function main() {
	// YouTube's response headers are past undici's 16 KiB default
	if (http.maxHeaderSize < 262144) {
		const run = spawnSync(
			process.execPath,
			['--max-http-header-size=262144', ...process.argv.slice(1)],
			{ stdio: 'inherit' },
		);
		process.exit(run.status ?? 1);
	}
	const [out, ...only] = process.argv.slice(2);
	if (!out) {
		console.error('usage: node test/corpus/fetch.mjs <out dir> [site ...]');
		process.exit(2);
	}
	const files = join(out, 'files');
	mkdirSync(files, { recursive: true });
	const manifestFile = join(out, 'manifest.json');
	const manifest = existsSync(manifestFile)
		? JSON.parse(readFileSync(manifestFile, 'utf8'))
		: { pages: [], scripts: [] };
	const sites = only.length ? only : Object.keys(SITES);
	// a refetched site's old entries go
	manifest.pages = manifest.pages.filter((page) => !sites.includes(page.site));
	manifest.scripts = manifest.scripts.filter(
		(script) => !sites.includes(script.site),
	);
	const date = new Date().toISOString();
	const store = (text) => {
		const bytes = Buffer.from(text, 'utf8');
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const file = `files/${sha256}.js`;
		if (!existsSync(join(out, file))) writeFileSync(join(out, file), bytes);
		return { sha256, size: bytes.length, file };
	};

	await pool(sites, 6, async (site) => {
		for (const page of SITES[site]) {
			const record = { site, page, date };
			manifest.pages.push(record);
			let html;
			try {
				let { response, bytes } = await get(page, PAGE_HEADERS);
				if (response.status >= 400 && response.status < 500)
					({ response, bytes } = await get(page, NAVIGATE_HEADERS));
				record.status = response.status;
				record.final = response.url;
				html = bytes.toString('utf8');
				record.htmlSha256 = store(html).sha256;
				if (
					response.headers.get('cf-mitigated') === 'challenge' ||
					CHECK_PAGE.test(html)
				) {
					record.challenge = true;
					console.log(`${site} ${page}: bot check, skipped`);
					continue;
				}
			} catch (error) {
				record.error = String(error?.message ?? error);
				console.log(`${site} ${page}: ${record.error}`);
				continue;
			}
			const base = record.final ?? page;
			const seen = new Set();
			const queue = [];
			let inline = 0;
			for (const found of scriptsOf(html, base)) {
				if (found.inline !== undefined) {
					if (CHALLENGE.test(found.inline)) continue;
					manifest.scripts.push({
						site,
						page,
						url: `${base}#inline-${inline++}`,
						kind: found.kind,
						inline: found.data ? 'data' : true,
						date,
						...store(found.inline),
					});
				} else if (!seen.has(found.url)) {
					seen.add(found.url);
					queue.push({ ...found, depth: 0 });
				}
			}
			let handlers = 0;
			for (const { name, value } of handlersOf(html))
				manifest.scripts.push({
					site,
					page,
					url: `${base}#${name}-${handlers++}`,
					kind: 'handler',
					inline: true,
					date,
					...store(value),
				});
			let fetched = 0;
			while (queue.length && fetched < PER_PAGE) {
				const batch = queue.splice(0, Math.min(8, PER_PAGE - fetched));
				fetched += batch.length;
				await Promise.all(
					batch.map(async (item) => {
						if (CHALLENGE.test(item.url) || !/^https?:/.test(item.url)) return;
						try {
							const { response, bytes } = await get(
								item.url,
								SCRIPT_HEADERS,
								base,
							);
							if (!response.ok) {
								manifest.scripts.push({
									site,
									page,
									url: item.url,
									kind: item.kind,
									status: response.status,
									date,
								});
								return;
							}
							const text = bytes.toString('utf8');
							manifest.scripts.push({
								site,
								page,
								url: item.url,
								kind: item.kind,
								contentType: response.headers.get('content-type'),
								date,
								...store(text),
							});
							const next = [];
							if (item.kind !== 'classic' && item.depth < IMPORT_DEPTH)
								for (const url of importsOf(text, item.url))
									next.push({ url, kind: 'module', depth: item.depth + 1 });
							for (const worker of workersOf(text, item.url))
								next.push({ ...worker, depth: item.depth + 1 });
							for (const entry of next)
								if (!seen.has(entry.url)) {
									seen.add(entry.url);
									queue.push(entry);
								}
						} catch (error) {
							manifest.scripts.push({
								site,
								page,
								url: item.url,
								kind: item.kind,
								error: String(error?.message ?? error),
								date,
							});
						}
					}),
				);
			}
			const got = manifest.scripts.filter(
				(script) => script.page === page && script.sha256,
			);
			console.log(
				`${site} ${page}: ${record.status}, ${got.length} scripts, ${got.reduce((sum, s) => sum + s.size, 0)} bytes`,
			);
		}
	});
	writeFileSync(manifestFile, JSON.stringify(manifest, null, '\t'));
	const unique = new Set(manifest.scripts.map((s) => s.sha256).filter(Boolean));
	console.log(
		`${manifest.pages.length} pages, ${manifest.scripts.length} script entries, ${unique.size} distinct scripts`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
