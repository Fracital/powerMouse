// The :visited side of the fixture (visited suite): one page that shows
// links as coloured squares a screenshot can read, frames other pages and
// navigates every way a visit can be made, a redirect, and a log of what
// reached the server.
//
//   /visited/p?...        the page
//     l=<json urls>       links in the markup, 20px squares from the left
//                         edge of the top row: blue, red when :visited
//     sl=<json urls>      links a script adds after them (href set by script)
//     tb=1                the markup links open a new window (target=_blank)
//     kind=svg|area       the markup links as SVG <a> (painted the same) or
//                         <area> (not painted, for their attributes)
//     f=<json urls>       frames in the markup, named f0, f1.., 600x90 each,
//                         stacked from 40px down
//     sd=<json urls>      one more frame, named s0, whose srcdoc holds those
//                         links (squares like the page's own)
//     do=<action>&to=<x>  what the page does: assign, set (location = x),
//                         replace, push, replaceState, hash, reload, open,
//                         openself (window.open on itself), aclick (a link
//                         it makes and clicks), frame (sets the first
//                         frame's src), form (a GET form to x)
//     when=click|load|early
//                         on a click of #go (default), 400 ms after load,
//                         or while the document is parsed
//     meta=<url>          a <meta http-equiv=refresh> to url
//     nav=<how>           the page uses the Navigation API: listen (a
//                         navigate listener, which notes each destination
//                         in window.navlog), change (a currententrychange
//                         listener only), intercept (the navigate listener
//                         intercepts a destination under /visited/spa/ and
//                         titles the document `spa <pathname>`)
//   /visited/many?n=<n>   a page of n links (5000 without n) to as many
//                         URLs of three sites, for the cost of routing them
//   /visited/r?to=<url>   a 302 to url (code=<n> for another status)
//   /visited/log          every request under /visited/ since the last
//                         read, as [{ url, host, referer }]
//
// test/fixture.mjs calls `visited(req, res)` and serves the rest.

let log = [];

const escapeAttr = (text) =>
	text.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

function list(query, name) {
	try {
		const parsed = JSON.parse(query.get(name) ?? '[]');
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

const STYLE = `html,body{margin:0;background:#fff}
a.l{position:absolute;top:0;width:20px;height:20px;background-color:rgb(0,0,255);color:rgb(0,0,255);overflow:hidden}
a.l:visited{background-color:rgb(255,0,0);color:rgb(255,0,0)}
svg{position:absolute;left:0;top:0}
svg a rect{fill:rgb(0,0,255)}
svg a:visited rect{fill:rgb(255,0,0)}
#go{position:absolute;left:0;top:20px;width:60px;height:18px;padding:0;font-size:10px}
iframe{position:absolute;left:0;width:600px;height:90px;border:0}`;

const SCRIPT = `(() => {
	const query = new URLSearchParams(location.search);
	const links = JSON.parse(query.get('l') || '[]').length;
	JSON.parse(query.get('sl') || '[]').forEach((url, i) => {
		const a = document.createElement('a');
		a.className = 'l';
		a.id = 'l' + (links + i);
		a.style.left = (links + i) * 20 + 'px';
		a.href = url;
		document.body.append(a);
	});
	const to = query.get('to');
	const nav = query.get('nav');
	window.navlog = [];
	if (nav === 'change')
		navigation.addEventListener('currententrychange', () => {
			navlog.push('change ' + location.href);
		});
	else if (nav)
		navigation.addEventListener('navigate', (event) => {
			const url = new URL(event.destination.url);
			navlog.push(
				[event.navigationType, event.destination.url, event.hashChange, event.destination.sameDocument, event.canIntercept].join(' '),
			);
			if (nav === 'intercept' && url.pathname.startsWith('/visited/spa/'))
				event.intercept({
					handler: async () => {
						document.title = 'spa ' + url.pathname;
					},
				});
		});
	const actions = {
		assign: () => { location.href = to; },
		set: () => { window.location = to; },
		openself: () => { window.open(to, '_self'); },
		aclick: () => {
			const a = document.createElement('a');
			a.href = to;
			document.body.append(a);
			a.click();
		},
		replace: () => { location.replace(to); },
		push: () => { history.pushState({ n: 1 }, '', to); },
		replaceState: () => { history.replaceState({ n: 2 }, '', to); },
		hash: () => { location.hash = to; },
		reload: () => { location.reload(); },
		open: () => { window.open(to); },
		frame: () => { document.querySelector('iframe').src = to; },
		form: () => {
			const form = document.createElement('form');
			form.action = to;
			const field = document.createElement('input');
			field.name = 'q';
			field.value = '1';
			form.append(field);
			document.body.append(form);
			form.submit();
		},
	};
	const act = () => {
		actions[query.get('do')]();
		document.documentElement.dataset.did = '1';
	};
	const when = query.get('when') || 'click';
	if (!query.get('do')) return;
	if (when === 'early') act();
	else if (when === 'load')
		addEventListener('load', () => setTimeout(act, 400));
	else document.getElementById('go').addEventListener('click', act);
})();`;

function page(url) {
	const query = url.searchParams;
	const kind = query.get('kind');
	const links = list(query, 'l');
	let markup;
	if (kind === 'svg')
		markup = `<svg width="${links.length * 20}" height="20">${links
			.map(
				(href, i) =>
					`<a id="l${i}" href="${escapeAttr(href)}"><rect x="${i * 20}" y="0" width="20" height="20"/></a>`,
			)
			.join('')}</svg>`;
	else if (kind === 'area')
		markup = `<map name="m">${links
			.map(
				(href, i) =>
					`<area id="l${i}" shape="rect" coords="${i * 20},0,${i * 20 + 20},20" href="${escapeAttr(href)}">`,
			)
			.join('')}</map>`;
	else
		markup = links
			.map(
				(href, i) =>
					`<a class="l" id="l${i}" style="left:${i * 20}px"${query.get('tb') ? ' target="_blank"' : ''} href="${escapeAttr(href)}"></a>`,
			)
			.join('');
	const frames = list(query, 'f')
		.map(
			(src, i) =>
				`<iframe name="f${i}" id="f${i}" style="top:${40 + i * 100}px" src="${escapeAttr(src)}"></iframe>`,
		)
		.join('');
	const inline = list(query, 'sd');
	const srcdoc = inline.length
		? `<iframe name="s0" id="s0" style="top:${40 + list(query, 'f').length * 100}px" srcdoc="${escapeAttr(
				`<!doctype html><style>${STYLE}</style>${inline
					.map(
						(href, i) =>
							`<a class="l" id="l${i}" style="left:${i * 20}px" href="${escapeAttr(href)}"></a>`,
					)
					.join('')}`,
			)}"></iframe>`
		: '';
	const meta = query.get('meta');
	return `<!doctype html><html><head><meta charset="utf-8"><title>v ${escapeAttr(url.pathname + url.search)}</title>${
		meta === null
			? ''
			: `<meta http-equiv="refresh" content="0;url=${escapeAttr(meta)}">`
	}<style>${STYLE}</style></head><body>${markup}<button id="go">go</button>${frames}${srcdoc}<script>${SCRIPT}</script></body></html>`;
}

/** true when the request was one of ours and has been answered */
export function visited(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/visited/')) return false;
	res.setHeader('cache-control', 'no-store');
	if (url.pathname === '/visited/log') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('access-control-allow-origin', '*');
		res.end(JSON.stringify(log));
		log = [];
		return true;
	}
	log.push({
		url: req.url,
		host: req.headers.host ?? '',
		referer: req.headers.referer ?? '',
	});
	if (url.pathname === '/visited/many') {
		const count = Number(url.searchParams.get('n')) || 5000;
		const sites = ['', 'http://localhost:1', 'https://example.com'];
		let links = '';
		for (let i = 0; i < count; i++)
			links += `<a href="${sites[i % 3]}/visited/t/many-${i}?item=${i}#p${i % 7}">link ${i}</a>\n`;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(
			`<!doctype html><html><head><meta charset="utf-8"><title>many ${count}</title></head><body>${links}<script>document.documentElement.dataset.links = document.links.length;</script></body></html>`,
		);
		return true;
	}
	if (url.pathname === '/visited/r') {
		res.statusCode = Number(url.searchParams.get('code')) || 302;
		res.setHeader('location', url.searchParams.get('to') ?? '/visited/p');
		res.end();
		return true;
	}
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(page(url));
	return true;
}
