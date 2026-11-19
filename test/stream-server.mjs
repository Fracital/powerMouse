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

/** the head's padding: the worker reads the encoding from the first 1024 bytes */
const PAD = `<!-- ${'pad '.repeat(300)} -->`;

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
	frame: [
		`<!doctype html><html><head><meta charset="utf-8"><title>stream frame</title>${PAD}</head><body><iframe id="inner" sandbox="allow-scripts" src="/stream/paint?wait=__WAIT__"></iframe><iframe id="bare" sandbox="" src="/stream/paint?wait=__WAIT__"></iframe>`,
		`<script>window.__done = true;</script></body></html>`,
	],
};

// 日本語 and テキスト in Shift_JIS
const NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
const TEXT = [0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67];

export function stream(req, res) {
	const url = new URL(req.url, 'http://x');
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
	const parts = CASES[name];
	if (!parts) return false;
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	// the head first, then the start of the body on its own
	const first = parts[0].replace('__WAIT__', String(wait));
	const body = first.indexOf('<body>') + '<body>'.length;
	res.write(first.slice(0, body));
	later(100, () => res.write(first.slice(body)));
	later(wait, () => res.end(parts[1]));
	return true;
}
