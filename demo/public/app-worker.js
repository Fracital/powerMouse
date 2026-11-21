// powerMouse's app worker (demo/README.md "The installed app"): the service
// worker of the site's root, which makes the page an app Chrome installs
// and opens in a window of its own (manifest.webmanifest). It is not
// STomp's: STomp's worker has the scope /stomp/, where every proxied
// page, frame and request lives, and a narrower scope always wins, so
// nothing proxied ever comes here. Of what is left it handles one thing,
// the load of the app's page (/), and only to answer it when the network
// is down, with a page that says so and loads the app again once the site
// answers. Every other request goes past it to the network: the static
// routes below send them there without starting this worker at all
// (Chrome's Service Worker Static Routing API), and the fetch handler
// lets them through too where a browser has no such routes.
const SHELL = 'pm-app-shell';
const ICON = '/pm/icons/app-192.png';

self.addEventListener('install', (event) => {
	if (event.addRoutes && typeof URLPattern === 'function')
		event.waitUntil(
			event
				.addRoutes([
					{
						condition: { not: { requestMode: 'navigate' } },
						source: 'network',
					},
					{
						condition: {
							not: { urlPattern: new URLPattern({ pathname: '/' }) },
						},
						source: 'network',
					},
				])
				// refused: the fetch handler lets them through
				.catch(() => {}),
		);
	event.waitUntil(
		caches
			.open(SHELL)
			.then((cache) => cache.add(ICON))
			.catch(() => {}),
	);
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		Promise.all([
			// the page's own load goes out at once, not after this worker starts
			self.registration.navigationPreload?.enable(),
			self.clients.claim(),
		]).catch(() => {}),
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.mode !== 'navigate' || new URL(request.url).pathname !== '/')
		return;
	event.respondWith(
		(async () => {
			try {
				return (await event.preloadResponse) || (await fetch(request));
			} catch {
				return offline();
			}
		})(),
	);
});

/** the page shown for the app's own page when the network is down */
async function offline() {
	// the icon kept at install, in the page: its own load would go to the
	// network (the routes above)
	let icon = '';
	try {
		const bytes = new Uint8Array(
			await (await caches.match(ICON)).arrayBuffer(),
		);
		let text = '';
		for (let at = 0; at < bytes.length; at += 0x8000)
			text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
		icon = `data:image/png;base64,${btoa(text)}`;
	} catch {
		// not kept: no icon
	}
	return new Response(OFFLINE.replace('{icon}', icon), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

// In the theme the page last showed (pm/theme.js keeps its choice in
// localStorage): its page colour and its text. Once the site answers again,
// the app's page loads again by itself.
const OFFLINE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#000000" />
<title>powerMouse</title>
<style>
:root { color-scheme: dark; --page: #000; --text: #fff; --muted: #9a9a9a; }
:root[data-scheme='light'] { color-scheme: light; --page: #e4e6e1; --text: #2e3436; --muted: #6c716b; }
:root[data-scheme='dark'] { --page: #1b1e1f; --text: #eeeeec; --muted: #a0a49e; }
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; background: var(--page); color: var(--text); font: 500 15px system-ui, sans-serif; -webkit-app-region: drag; }
main { display: grid; justify-items: center; gap: 12px; padding: 24px; text-align: center; }
img { width: 96px; height: 96px; }
img[src=''] { display: none; }
h1 { margin: 0; font-size: 22px; }
p { margin: 0; color: var(--muted); max-width: 32em; }
button { -webkit-app-region: no-drag; margin-top: 8px; padding: 8px 18px; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
</style>
<script>
(() => {
	const root = document.documentElement;
	const meta = document.querySelector('meta[name=theme-color]');
	try {
		const choice = localStorage.getItem('stomp-demo:theme') || 'default';
		const installed = JSON.parse(localStorage.getItem('stomp-demo:themes') || '[]');
		const theme = Array.isArray(installed) ? installed.find((t) => t && t.id === choice) : null;
		let scheme = choice === 'light' || choice === 'dark' ? choice : null;
		if (choice === 'system') scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		if (theme) scheme = theme.scheme === 'light' ? 'light' : 'dark';
		if (scheme) root.dataset.scheme = scheme;
		const tokens = (theme && theme.tokens) || {};
		if (typeof tokens.page === 'string') root.style.setProperty('--page', tokens.page);
		if (typeof tokens.text === 'string') root.style.setProperty('--text', tokens.text);
	} catch {}
	addEventListener('DOMContentLoaded', () => {
		meta.content = getComputedStyle(root).getPropertyValue('--page').trim() || '#000000';
	});
	// the app's page again once the site answers: asked at once when the
	// browser is back online, and every few seconds while it says it is
	// (the site itself can be what was down)
	let timer = 0;
	const retry = () => {
		clearTimeout(timer);
		fetch(location.href, { method: 'HEAD', cache: 'no-store' }).then(
			() => location.reload(),
			() => (timer = setTimeout(retry, 5000)),
		);
	};
	addEventListener('online', retry);
	if (navigator.onLine) timer = setTimeout(retry, 5000);
})();
</script>
</head>
<body>
<main>
<img src="{icon}" alt="" />
<h1>powerMouse is offline</h1>
<p>It needs the network to reach the sites it opens. It opens again by itself once it can reach the site.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>
`;
