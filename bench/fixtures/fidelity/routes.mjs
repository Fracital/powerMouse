// Dynamic endpoints of the fidelity battery (bench/lib/fidelity.mjs).
// Pages under /fidelity/ are served with placeholders filled in: __PORT__
// (the fixture port), __RUN__ (the `run` query parameter, a per-load token)
// __ROLE__ (the `role` parameter of a child frame), and __LEAK__ /
// __SAMELEAK__ (the leak vectors' bases on c. and a.bench.test). The rest:
//   /fidelity/echo        request headers as JSON (?cors=1: CORS allowed, ?hdr=1: an exposed X-Fid header)
//   /fidelity/redirect    ?to=<url>&code=<3xx> (CORS when ?cors=1)
//   /fidelity/set-cookie  ?c=<Set-Cookie value> (repeatable), CORS when ?cors=1
//   /fidelity/rec         records the request under run+tag and answers ?t=<type>
//   /fidelity/seen        what /fidelity/rec recorded for run+tag, as JSON
//   /fidelity/sse         an EventSource stream
//   /fidelity/ws          WebSocket echo (upgrade)
//   /leak/<vector>        something harmless of the type ?t= asks for (the leak battery)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const DIR = fileURLToPath(new URL('./', import.meta.url));

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
};

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
	'base64',
);

// headers of particular pages (the cookies page sets cookies as it loads;
// the leak pages carry header vectors)
const PAGE_HEADERS = {
	'/fidelity/cookies.html': () => ({
		'Set-Cookie': ['srv=1; Path=/', 'ho=1; Path=/; HttpOnly'],
	}),
	'/fidelity/leak-nav.html': (port, run) => ({
		Link: `<http://c.bench.test:${port}/leak/link-header?run=${run}&t=css>; rel=preload; as=style`,
	}),
	'/fidelity/leak-refresh.html': (port, run) => ({
		Refresh: `0; url=http://c.bench.test:${port}/leak/refresh-header?run=${run}&t=html`,
	}),
	'/fidelity/leak-csp.html': (port, run) => ({
		'Content-Security-Policy': `img-src 'none'; report-uri http://c.bench.test:${port}/leak/csp-report?run=${run}`,
	}),
};

const RECORDED = [
	'host',
	'origin',
	'referer',
	'cookie',
	'sec-fetch-site',
	'sec-fetch-mode',
	'sec-fetch-dest',
	'x-custom',
	'content-type',
	'access-control-request-method',
	'access-control-request-headers',
];

const token = (value) => String(value || '').replace(/[^\w-]/g, '');

function pick(req) {
	const headers = {};
	for (const name of RECORDED)
		if (req.headers[name] !== undefined) headers[name] = req.headers[name];
	return { method: req.method, headers };
}

// run:tag -> [{ method, headers }]
const seen = new Map();

function body(type) {
	switch (type) {
		case 'img':
			return ['image/png', PNG];
		case 'svg':
			return [
				'image/svg+xml',
				'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect id="r" width="1" height="1"/></svg>',
			];
		case 'js':
			return ['text/javascript', '/* fidelity */\n'];
		case 'css':
			return ['text/css', '/* fidelity */\n'];
		case 'html':
			return [
				'text/html; charset=utf-8',
				'<!doctype html><meta charset="utf-8"><title>fidelity</title>',
			];
		case 'json':
			return ['application/json', '{"ok":true}'];
		case 'vtt':
			return ['text/vtt', 'WEBVTT\n'];
		case 'sse':
			return ['text/event-stream', 'data: x\n\n'];
		default:
			return ['text/plain', ''];
	}
}

function cors(req, res, on) {
	if (!on) return;
	res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Headers', 'X-Custom, Content-Type');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
	res.setHeader('Access-Control-Expose-Headers', 'X-Fid');
}

function json(res, value, status = 200) {
	const text = JSON.stringify(value);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
	});
	res.end(text);
}

function servePage(req, res, ctx, url) {
	const file = normalize(join(DIR, url.pathname.slice('/fidelity/'.length)));
	if (!file.startsWith(DIR) || !existsSync(file) || !statSync(file).isFile())
		return false;
	const type = TYPES[extname(file)];
	if (!type || file.endsWith('routes.mjs')) return false;
	const port = String(
		ctx.fixturePort || (req.headers.host || '').split(':')[1],
	);
	const run = token(url.searchParams.get('run'));
	const text = readFileSync(file, 'utf8')
		.replaceAll('__LEAK__', `http://c.bench.test:${port}/leak`)
		.replaceAll('__SAMELEAK__', `http://a.bench.test:${port}/leak`)
		.replaceAll('__PORT__', port)
		.replaceAll('__RUN__', run)
		.replaceAll('__ROLE__', token(url.searchParams.get('role')));
	const extra = PAGE_HEADERS[url.pathname]
		? PAGE_HEADERS[url.pathname](port, run)
		: {};
	res.writeHead(200, {
		'Content-Type': type,
		'Cache-Control': 'no-store',
		...extra,
	});
	res.end(req.method === 'HEAD' ? undefined : text);
	return true;
}

export async function handle(req, res, ctx) {
	const url = new URL(req.url, 'http://x');
	const path = url.pathname;
	const query = url.searchParams;
	if (path.startsWith('/leak/')) {
		const [type, data] = body(query.get('t'));
		res.writeHead(200, {
			'Content-Type': type,
			'Cache-Control': 'no-store',
			'Access-Control-Allow-Origin': '*',
			'Cross-Origin-Resource-Policy': 'cross-origin',
			...(type === 'text/javascript' && { 'Service-Worker-Allowed': '/' }),
		});
		res.end(data);
		return true;
	}
	if (!path.startsWith('/fidelity/')) return false;
	const run = token(query.get('run'));
	const tag = token(query.get('tag'));
	switch (path) {
		case '/fidelity/echo': {
			cors(req, res, query.has('cors'));
			if (query.has('hdr')) res.setHeader('X-Fid', '1');
			if (req.method === 'OPTIONS') {
				if (tag) record(run, tag, req);
				res.writeHead(204).end();
				return true;
			}
			let text = '';
			for await (const chunk of req) text += chunk;
			if (tag) record(run, tag, req);
			json(res, { ...pick(req), path, body: text });
			return true;
		}
		case '/fidelity/redirect': {
			cors(req, res, query.has('cors'));
			res.writeHead(Number(query.get('code')) || 302, {
				Location: query.get('to') || '/fidelity/echo',
				'Cache-Control': 'no-store',
			});
			res.end();
			return true;
		}
		case '/fidelity/set-cookie': {
			cors(req, res, query.has('cors'));
			res.setHeader('Set-Cookie', query.getAll('c'));
			json(res, { ok: true });
			return true;
		}
		case '/fidelity/rec': {
			record(run, tag, req);
			const [type, data] = body(query.get('t'));
			res.writeHead(200, {
				'Content-Type': type,
				'Cache-Control': 'no-store',
				'Access-Control-Allow-Origin': '*',
			});
			res.end(data);
			return true;
		}
		case '/fidelity/seen': {
			json(res, seen.get(`${run}:${tag}`) || []);
			return true;
		}
		case '/fidelity/sse': {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-store',
			});
			res.write('retry: 60000\n\n');
			res.write('id: 7\nevent: named\ndata: first\n\n');
			res.write('id: 8\ndata: second\ndata: line\n\n');
			const timer = setTimeout(() => res.end(), 15000);
			req.on('close', () => clearTimeout(timer));
			return true;
		}
	}
	return servePage(req, res, ctx, url);
}

function record(run, tag, req) {
	const key = `${run}:${tag}`;
	if (!seen.has(key)) seen.set(key, []);
	seen.get(key).push(pick(req));
	// keep the store small over a long run
	if (seen.size > 5000) seen.delete(seen.keys().next().value);
}

const wss = new WebSocketServer({
	noServer: true,
	perMessageDeflate: false,
	handleProtocols: (protocols) =>
		protocols.has('p2') ? 'p2' : [...protocols][0] || false,
});

export function upgrade(req, socket, head) {
	const url = new URL(req.url, 'http://x');
	if (url.pathname.startsWith('/leak/')) {
		// the fixture log has it; a leak vector needs no answer
		socket.destroy();
		return true;
	}
	if (url.pathname !== '/fidelity/ws') return false;
	wss.handleUpgrade(req, socket, head, (ws) => {
		ws.send(
			JSON.stringify({
				hello: true,
				path: url.pathname + url.search,
				...pick(req).headers,
			}),
		);
		ws.on('message', (data, binary) => {
			if (!binary && String(data) === 'close-me') ws.close(4001, 'bye');
			else ws.send(data, { binary });
		});
	});
	return true;
}
