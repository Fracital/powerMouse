// Documents whose markup arrives in parts, with a pause between (the
// html-stream suite): the page is parsed and painted as it comes, natively
// and through the proxy.
//
//   /stream/<case>?wait=<ms>   the first part (the head and `<body>`, then
//                              100 ms later the start of the body), then
//                              after `wait` (at most 8000) the rest:
//     paint    an early heading and a script that writes; the rest holds a
//              late paragraph, scripts that record their order, an external
//              one that arrives late and one that writes
//     wipe     a timer that writes while the rest is on its way (the write
//              opens the document again: the rest never lands)
//     sjis     a Shift_JIS page whose characters are split between the parts
//              and between the writes of a part
//     sizes    a body of a known length, no Content-Length
//     frame    two sandboxed frames of the paint case: allow-scripts, and
//              nothing allowed
//     bighead  a head of 1.5 MB, most of it one <style> with url()s (CNN's
//              is 3.7 MB, a 3.1 MB style), and scripts that read it
//     hidden   a frame of the paint case that is not displayed (it draws no
//              frames)
//     slowhead the start of the head at once, then the rest of it: a meta
//              CSP that requires Trusted Types, scripts that test it
//     store    at once: a head whose script reads localStorage, then a body
//              of a 2.5 MB inline script (CNN's is 2.46 MB), which keeps
//              the worker busy while the head runs
//     trickle  a head whose inline script of 768 KB comes 64 KB at a time,
//              20 ms apart (YouTube's is 780 KB), then the start of the
//              body, and the rest after `wait`; with `split`, the
//              script's end tag comes in two writes (`</scr`, `ipt>`), 20 ms
//              apart
//     stop     after `head` ms (at most 8000) the head, then an early
//              heading (its data-k the key), the rest (a late paragraph)
//              after `wait`; under
//              `k=<key>`, /stream/stop-log?k=<key> says whether the request
//              was given up before its end was sent (the toolbar suite's
//              Stop); with `answer=nothing` the answer after `head` is a
//              204, with `answer=download` an attachment. With `hold`, wait
//              for POST /stream/stop-release?k=<key> instead of a timer;
//              with `hold=late`, only the late paragraph waits for it (a
//              runner slower than `wait` would end the load before the
//              suite saw it)
//     link     a page whose one link (#go, its data-k the key) goes to
//              `to`, a path under /stream/ (a page's own navigation, for
//              the toolbar suite)
//     lone     the head with no `</head>`, then 100 ms later one piece that
//              ends the markup so far (`piece`: a lone element, an element
//              in a div, text with no tag after it, an element then a void
//              one), then after `wait` the rest, with no script

/** the head's padding: the worker reads the encoding from the first 1024 bytes */
const PAD = `<!-- ${'pad '.repeat(300)} -->`;

/** CSS of about `size` characters, a url() in every eighth rule */
function rules(size) {
	let css = '';
	for (let i = 0; css.length < size; i++)
		css +=
			i % 8
				? `.r${i} .x${i % 97}>p{margin:${i % 13}px;border-top:1px solid #${(i % 4096).toString(16).padStart(3, '0')};flex:none}\n`
				: `.r${i}{background:url(img/${i}.png) no-repeat}\n`;
	return css;
}
const BIG = rules(1536 * 1024);

const CASES = {
	paint: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream paint</title>${PAD}<script>window.__order = ['head'];</script></head><body><h1 id="early">early</h1><script>__order.push('a'); document.write('<b id="w1">w1</b>');</script>`,
		`<p id="late">late</p><script>__order.push('b', document.getElementById('w1') ? 'w1' : 'no w1');</script><script src="/slow-js?mark=c&ms=300"></script><script>__order.push('d'); document.write('<i id="w2">w2</i>'); __order.push(document.getElementById('w2')?.previousElementSibling?.tagName ?? 'none');</script><div id="tail">${'<span>row</span>'.repeat(2000)}</div><script>__order.push('end'); window.__done = true;</script></body></html>`,
	],
	wipe: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream wipe</title>${PAD}</head><body><h1 id="early">early</h1><script>setTimeout(() => { document.write('<p id="wiped">wiped</p>'); window.__wiped = document.readyState; }, 300);</script>`,
		`<p id="after">after</p><script>window.__after = true;</script></body></html>`,
	],
	sizes: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream sizes</title>${PAD}</head><body><h1 id="early">early</h1>`,
		`<p>${'size '.repeat(4000)}</p><script>window.__done = true;</script></body></html>`,
	],
	bighead: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream bighead</title>${PAD}<script>window.__order = ['head'];</script><style id="big">#early{color:rgb(1, 2, 3)}\n${BIG}</style><script>__order.push('after style', String(document.getElementById('big').textContent.length));</script></head><body><h1 id="early">early</h1><script>__order.push('a');</script>`,
		`<p id="late">late</p><script>__order.push('end'); window.__done = true;</script></body></html>`,
	],
	// (no <body> in the first part: it is the start of the head)
	slowhead: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream slowhead</title>${PAD}<script>window.__order = ['head'];</script>`,
		`<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n1' 'self'; require-trusted-types-for 'script'"><script nonce="n1">__order.push('nonced'); try { eval('1'); __order.push('eval ran'); } catch (error) { __order.push(error.name); } try { document.createElement('div').innerHTML = '<b></b>'; __order.push('html set'); } catch (error) { __order.push(error.name); }</script></head><body><h1 id="early">early</h1><script nonce="n1">__order.push('end'); window.__done = true;</script></body></html>`,
	],
	hidden: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream hidden</title>${PAD}</head><body><iframe id="inner" style="display:none" src="/stream/paint?wait=__WAIT__"></iframe>`,
		`<script>window.__done = true;</script></body></html>`,
	],
	frame: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream frame</title>${PAD}</head><body><iframe id="inner" sandbox="allow-scripts" src="/stream/paint?wait=__WAIT__"></iframe><iframe id="bare" sandbox="" src="/stream/paint?wait=__WAIT__"></iframe>`,
		`<script>window.__done = true;</script></body></html>`,
	],
};

// the lone case's piece that comes 100 ms after the head, and what comes
// before the late paragraph
const LONE = {
	element: ['<h1 id="early">early</h1>', ''],
	nested: ['<div id="box"><span id="early">early</span></div>', ''],
	text: ['<p id="early">early text', ' and more</p>'],
	void: ['<h1 id="early">early</h1><img id="pic" alt="pic">', ''],
};

// 日本語 and テキスト in Shift_JIS
const NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
const TEXT = [0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67];

/** the stop case's requests by their key: `{ asked, headers, ended, closed }` */
const stops = new Map();
const heldStops = new Map();

export function stream(req, res) {
	const url = new URL(req.url, 'http://x');
	if (url.pathname === '/stream/stop-release' && req.method === 'POST') {
		const key = url.searchParams.get('k');
		const release = heldStops.get(key);
		heldStops.delete(key);
		release?.();
		res.writeHead(204).end();
		return true;
	}
	if (url.pathname === '/stream/stop-log') {
		res.writeHead(200, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		});
		res.end(JSON.stringify(stops.get(url.searchParams.get('k')) ?? null));
		return true;
	}
	const name = /^\/stream\/(\w+)$/.exec(url.pathname)?.[1];
	if (!name) return false;
	const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 8000);
	const later = (ms, fn) => setTimeout(fn, ms);
	if (name === 'sjis') {
		res.writeHead(200, { 'content-type': 'text/html' });
		const ascii = (text) => Buffer.from(text, 'latin1');
		res.write(
			Buffer.concat([
				ascii(
					`<!doctype html><html><head><meta charset="shift_jis"><title>stream sjis</title>${PAD}</head><body><h1 id="early">`,
				),
				Buffer.from(NIHONGO.slice(0, 3)),
			]),
		);
		later(wait, () => {
			res.write(
				Buffer.concat([
					Buffer.from(NIHONGO.slice(3)),
					ascii('</h1><p id="late">'),
					Buffer.from(TEXT.slice(0, 5)),
				]),
			);
			later(50, () =>
				res.end(
					Buffer.concat([
						Buffer.from(TEXT.slice(5)),
						ascii('</p><script>window.__done = true;</script></body></html>'),
					]),
				),
			);
		});
		return true;
	}
	if (name === 'stop') {
		const log = { asked: true, headers: false, ended: false, closed: false };
		const key = (url.searchParams.get('k') ?? '').replace(/[^\w-]/g, '');
		if (key) stops.set(key, log);
		const timers = [];
		const head = Math.min(Number(url.searchParams.get('head')) || 0, 8000);
		const answer = url.searchParams.get('answer');
		const hold = key ? url.searchParams.get('hold') : null;
		/** what POST /stream/stop-release runs for this request, if anything */
		let held = null;
		const holdFor = (fn) => {
			held = fn;
			heldStops.set(key, fn);
		};
		const send = () => {
			log.headers = true;
			if (answer === 'nothing' || answer === 'download') {
				log.ended = true;
				if (answer === 'nothing') res.writeHead(204).end();
				else
					res
						.writeHead(200, {
							'content-type': 'application/octet-stream',
							'content-disposition': 'attachment; filename="stop.bin"',
							'cache-control': 'no-store',
						})
						.end('stop');
				return;
			}
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			});
			res.write(
				`<!doctype html><html><head><meta charset="utf-8"><title>stream stop</title>${PAD}</head><body>`,
			);
			const finish = () => {
				log.ended = true;
				res.end(
					`<p id="late">late</p><script>window.__done = true;</script></body></html>`,
				);
			};
			timers.push(
				later(100, () =>
					res.write(`<h1 id="early" data-k="${key}">early</h1>`),
				),
			);
			if (hold === 'late') holdFor(finish);
			else timers.push(later(wait, finish));
		};
		res.on('close', () => {
			for (const timer of timers) clearTimeout(timer);
			if (held && heldStops.get(key) === held) heldStops.delete(key);
			if (!log.ended) log.closed = true;
		});
		if (hold !== null && hold !== 'late') holdFor(send);
		else timers.push(later(head, send));
		return true;
	}
	if (name === 'link') {
		const to = url.searchParams.get('to') ?? '';
		const key = (url.searchParams.get('k') ?? '').replace(/[^\w-]/g, '');
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		});
		res.end(
			`<!doctype html><html><head><meta charset="utf-8"><title>stream link</title></head><body><a id="go" data-k="${key}" href="${to.startsWith('/stream/') ? to.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`) : '#'}">go</a></body></html>`,
		);
		return true;
	}
	if (name === 'store') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(
			`<!doctype html><html><head><meta charset="utf-8"><title>stream store</title>${PAD}<script>window.__store = [localStorage.getItem('stream-store'), localStorage.getItem('stream-none')];</script></head><body><h1 id="early">early</h1><script>window.__big = '${'x'.repeat(2.5 * 1024 * 1024)}';</script><script>window.__done = true;</script></body></html>`,
		);
		return true;
	}
	if (name === 'lone') {
		const piece = LONE[url.searchParams.get('piece')];
		if (!piece) return false;
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.write(
			`<!doctype html><html><head><meta charset="utf-8"><title>stream lone</title>${PAD}`,
		);
		later(100, () => res.write(piece[0]));
		later(wait, () => res.end(`${piece[1]}<p id="late">late</p>`));
		return true;
	}
	if (name === 'trickle') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.write(
			`<!doctype html><html><head><meta charset="utf-8"><title>stream trickle</title>${PAD}<script>window.__order = ['head'];</script><script>window.__big = '`,
		);
		const piece = 'x'.repeat(64 * 1024);
		let sent = 0;
		const next = () => {
			if (sent++ < 12) {
				res.write(piece);
				later(20, next);
				return;
			}
			const rest = `'; __order.push('big', String(window.__big.length));</script></head><body><h1 id="early">early</h1><script>__order.push('a');</script>`;
			const end = () =>
				later(wait, () =>
					res.end(
						`<p id="late">late</p><script>__order.push('end'); window.__done = true;</script></body></html>`,
					),
				);
			if (!url.searchParams.has('split')) {
				res.write(rest);
				end();
				return;
			}
			const at = rest.indexOf('</script>') + '</scr'.length;
			res.write(rest.slice(0, at));
			later(20, () => {
				res.write(rest.slice(at));
				end();
			});
		};
		later(20, next);
		return true;
	}
	const parts = CASES[name];
	if (!parts) return false;
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	// the head first, then the start of the body on its own
	const first = parts[0].replace('__WAIT__', String(wait));
	const body = first.indexOf('<body>') + '<body>'.length;
	res.write(first.slice(0, body || first.length));
	if (body) later(100, () => res.write(first.slice(body)));
	later(wait, () => res.end(parts[1]));
	return true;
}
