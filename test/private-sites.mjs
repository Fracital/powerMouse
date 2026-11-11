// Sites under a private suffix of the public suffix list, for the rows that
// ask where a site ends: two customers of one host (stomp-a.github.io and
// stomp-b.github.io) are two sites to Chrome, as two names under co.uk are,
// and a name under either (www.stomp-a.github.io) is of its site. One
// server on 127.0.0.1 answers for every name, in TLS with a self-signed
// certificate and in plain http on the same port: Chrome maps the names
// there with --host-resolver-rules and takes the certificate by its key
// (the server's `nativeArgs`), the demo's test transport
// (demo/public/test/mixed-transport.mjs, STOMP_TEST_TRANSPORT=1) reaches it
// in plain http, since epoxy takes no self-signed certificate. The page's
// URL is https either way, which the Sec-Fetch headers and Secure cookies
// need. None of the names is asked of the network.
//
//   /ps/page?...         test/pages/private-site.html; `set=1` sets the
//                        four cookies below, a frame's (`role=frame`) and
//                        the page a frame of b navigates to (`role=landed`)
//                        four more each, `oac=0|1` sends
//                        Origin-Agent-Cluster: ?0 or ?1
//   /ps/ac?id=&oac=      test/pages/agent-cluster.html (agent-cluster suite)
//   /ps/echo?k=          what the request carried, as JSON (CORS, with
//                        credentials); `set=1` sets four more, `set=n`
//                        another four
//   /ps/sw.js            a service worker that answers a message with what
//                        its Cookie Store API reads and writes
//   /ps/cached?k=        a resource the HTTP cache may keep
//   /ps/ws?k=            a WebSocket that says what its handshake carried
//
// Every request is logged as { k, path, site, cookies, origin }: `site` is
// its Sec-Fetch-Site, `cookies` the names it carried, sorted.
//
// `privateSiteRows(topics)` runs every group natively and through the demo
// in both modes and compares what the suite that owns the topics asks
// about: Sec-Fetch-Site and cookies (samesite), the storage and HTTP cache
// partitions (sop-partitions), windows, document.domain and
// Origin-Agent-Cluster (site-facts). Measured on Chrome 152 and 156: the
// list's private section ends a site for every one of them, exactly as
// co.uk does.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHTTP } from 'node:http';
import { createServer as createHTTPS } from 'node:https';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { HOST, launch, ok, openDemo, PROXY, submitLanding } from './lib.mjs';
import { certificate, tlsOrPlain } from './mixed-servers.mjs';

const PAGE = fileURLToPath(
	new URL('./pages/private-site.html', import.meta.url),
);
/** what the agent-cluster suite drives (/ps/ac) */
const AGENT_PAGE = fileURLToPath(
	new URL('./pages/agent-cluster.html', import.meta.url),
);

/**
 * The suffixes: four from the list's private section, and an ICANN one as
 * the control (both sections agree about it)
 */
export const SUFFIXES = {
	github: 'github.io',
	blogspot: 'blogspot.com',
	s3: 's3.eu-west-1.amazonaws.com',
	cloudfront: 'cloudfront.net',
	control: 'co.uk',
};

/** the three hosts of a group: a site, a name under it, another site */
export const hostsOf = (group) => ({
	a: `stomp-a.${SUFFIXES[group]}`,
	sub: `www.stomp-a.${SUFFIXES[group]}`,
	b: `stomp-b.${SUFFIXES[group]}`,
});

/**
 * Chrome flags for the native side: the names resolve to the fixture, whose
 * certificate is taken by its key (`spki`). Not --ignore-certificate-errors:
 * Chrome keeps nothing in the HTTP cache from a connection whose certificate
 * it was told to overlook, and the cache's key is one of the rows.
 */
const nativeArgs = (spki) => [
	`--ignore-certificate-errors-spki-list=${spki}`,
	`--host-resolver-rules=${Object.values(SUFFIXES)
		.flatMap((suffix) => [
			`MAP stomp-a.${suffix} 127.0.0.1`,
			`MAP *.stomp-a.${suffix} 127.0.0.1`,
			`MAP stomp-b.${suffix} 127.0.0.1`,
		])
		.join(
			', ',
		)}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
];

const COOKIES = [
	'ps_strict=1; Path=/; Secure; SameSite=Strict',
	'ps_lax=1; Path=/; Secure; SameSite=Lax',
	'ps_none=1; Path=/; Secure; SameSite=None',
	'ps_default=1; Path=/; Secure',
];

/** the same four, as a response sets them: to a fetch, to a frame's document */
const setBy = (prefix) =>
	COOKIES.map((cookie) => cookie.replace(/^ps_/, `ps_${prefix}_`));

const WORKER = `addEventListener('message', async (event) => {
	const outcome = (call) =>
		call().then(() => 'ok', (error) => error.name + ': ' + error.message);
	const reads = await cookieStore.getAll().then(
		(list) => list.map((cookie) => cookie.name)
			.filter((name) => /^ps_(strict|lax|none|default)$/.test(name)).sort(),
		(error) => error.name,
	);
	const writes = [
		await outcome(() => cookieStore.set('ps_sw_default', '1')),
		await outcome(() =>
			cookieStore.set({ name: 'ps_sw_none', value: '1', sameSite: 'none' }),
		),
		await outcome(() => cookieStore.delete('ps_sw_none')),
	];
	event.source.postMessage({ reads, writes });
});
`;

const cookieNames = (req) =>
	(req.headers.cookie ?? '')
		.split('; ')
		.filter(Boolean)
		.map((pair) => pair.split('=')[0])
		.sort();

/**
 * Start the server on a free port. `log` lists every request, `origin(host)`
 * is a host's https origin on it, `nativeArgs` are the Chrome flags that
 * reach it natively.
 */
export async function startPrivateSites() {
	const log = [];
	const carried = (req) => {
		const url = new URL(req.url, 'http://x');
		const entry = {
			k: url.searchParams.get('k'),
			path: url.pathname,
			site: req.headers['sec-fetch-site'] ?? null,
			cookies: cookieNames(req),
			origin: req.headers.origin ?? null,
		};
		log.push(entry);
		return entry;
	};
	const handler = (req, res) => {
		const url = new URL(req.url, 'http://x');
		const query = url.searchParams;
		const entry = carried(req);
		if (url.pathname === '/ps/page') {
			res.setHeader('content-type', 'text/html; charset=utf-8');
			res.setHeader('cache-control', 'no-store');
			if (query.get('set') === '1') res.setHeader('set-cookie', COOKIES);
			else if (query.get('role') === 'frame')
				res.setHeader('set-cookie', setBy('f'));
			else if (query.get('role') === 'landed')
				res.setHeader('set-cookie', setBy('z'));
			if (query.has('oac'))
				res.setHeader('origin-agent-cluster', `?${query.get('oac')}`);
			res.end(readFileSync(PAGE));
			return;
		}
		if (url.pathname === '/ps/ac') {
			res.setHeader('content-type', 'text/html; charset=utf-8');
			res.setHeader('cache-control', 'no-store');
			if (query.has('oac'))
				res.setHeader('origin-agent-cluster', `?${query.get('oac')}`);
			res.end(readFileSync(AGENT_PAGE));
			return;
		}
		if (url.pathname === '/ps/echo') {
			res.setHeader('content-type', 'application/json');
			res.setHeader('cache-control', 'no-store');
			if (entry.origin) {
				res.setHeader('access-control-allow-origin', entry.origin);
				res.setHeader('access-control-allow-credentials', 'true');
			}
			// `n`: the fetch of a frame of a under b's frame
			const prefix = { 1: 'r', n: 'n' }[query.get('set')];
			if (prefix) res.setHeader('set-cookie', setBy(prefix));
			res.end(JSON.stringify(entry));
			return;
		}
		if (url.pathname === '/ps/sw.js') {
			res.setHeader('content-type', 'text/javascript');
			res.setHeader('cache-control', 'no-store');
			res.end(WORKER);
			return;
		}
		if (url.pathname === '/ps/cached') {
			res.setHeader('content-type', 'text/plain');
			res.setHeader('cache-control', 'max-age=3600');
			res.setHeader('access-control-allow-origin', '*');
			res.end('cached');
			return;
		}
		res.writeHead(404).end();
	};
	const pair = certificate('private-sites.test');
	const spki = createHash('sha256')
		.update(
			new X509Certificate(pair.cert).publicKey.export({
				type: 'spki',
				format: 'der',
			}),
		)
		.digest('base64');
	const secure = createHTTPS(pair, handler);
	const plain = createHTTP(handler);
	for (const server of [secure, plain]) {
		const sockets = new WebSocketServer({ server });
		sockets.on('connection', (socket, req) => {
			socket.send(JSON.stringify(carried(req)));
			socket.close();
		});
	}
	const both = tlsOrPlain(secure, plain);
	const port = await new Promise((resolve) =>
		both.listen(0, '127.0.0.1', () => resolve(both.address().port)),
	);
	return {
		log,
		port,
		nativeArgs: nativeArgs(spki),
		origin: (host) => `https://${host}:${port}`,
		close() {
			for (const server of [secure, plain]) server.closeAllConnections?.();
			both.close();
		},
	};
}

/**
 * A group's pages under a run's `tag`, in order, as [step, url, role, name]:
 * each name top-level (the cookies set, a mark kept, a's cacheable resource
 * loaded), then a's page that asks all three, then b top-level again (the
 * cookies it has now), then a's page and its frames with
 * Origin-Agent-Cluster: ?0
 */
export function steps(sites, group, tag) {
	const hosts = hostsOf(group);
	const origins = Object.entries(hosts)
		.map(([key, host]) => `&${key}=${encodeURIComponent(sites.origin(host))}`)
		.join('');
	const step = (label, name, role, more = '') => [
		label,
		`${sites.origin(hosts[name])}/ps/page?role=${role}&name=${name}&t=${tag}&suffix=${SUFFIXES[group]}&k=${tag}-${name}-${role}${origins}${more}`,
		role,
		name,
	];
	return [
		step('seed sub', 'sub', 'seed', '&set=1'),
		step('seed b', 'b', 'seed', '&set=1'),
		step('seed a', 'a', 'seed', '&set=1'),
		step('top', 'a', 'top'),
		step('after b', 'b', 'after'),
		step('legacy', 'a', 'legacy-top', '&oac=0'),
	];
}

/**
 * The report of the page in `role` on `name` of the run `tag`, from
 * whichever frame of `page` has it (the demo keeps earlier tabs' frames)
 */
export async function reportOf(page, role, name, tag) {
	for (let i = 0; i < 160; i++) {
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__ps).catch(() => null);
			if (
				value?.done &&
				value.role === role &&
				value.name === name &&
				value.tag === tag
			) {
				delete value.tag;
				return value;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return null;
}

/**
 * Run a group under `tag`: `visit(url)` loads a step's page top-level, and
 * `page()` is the Playwright page its report is read from. What each page reported, how many loads
 * of the cacheable resource had arrived after each step (a load the HTTP
 * cache answered does not arrive), and what each frame's document request
 * carried.
 */
export async function runGroup(sites, group, tag, visit, page) {
	const of = (k) => sites.log.filter((entry) => entry.k === k);
	const out = { steps: {}, cacheLoads: {}, frames: {} };
	for (const [label, url, role, name] of steps(sites, group, tag)) {
		await visit(url);
		out.steps[label] = await reportOf(page(), role, name, tag);
		out.cacheLoads[label] = of(`${tag}-cached`).length;
	}
	for (const name of ['a', 'sub', 'b'])
		out.frames[name] = of(`${tag}-${name}-frame`).map(({ site, cookies }) => ({
			site,
			cookies,
		}));
	return out;
}

const NAMES = ['a', 'sub', 'b'];
const each = (row) =>
	Object.fromEntries(NAMES.map((name) => [name, row(name)]));
/** the names in a cookie list that match `pattern` (none for a report that is not one) */
const named = (list, pattern) =>
	Array.isArray(list) ? list.filter((name) => pattern.test(name)) : list;

/**
 * What each topic reads of a group's run, as rows { label: value }, and
 * what Chrome's own run must say for the rows to mean anything (the two
 * names under the suffix are two sites, the name under a is of a's)
 */
const TOPICS = {
	'fetch-metadata': {
		rows: ({ steps, frames }) => ({
			'Sec-Fetch-Site of a fetch': each(
				(name) => steps.top?.to[name].fetch.site,
			),
			"Sec-Fetch-Site of a frame's document": each((name) =>
				frames[name].map((request) => request.site),
			),
		}),
		native: ({ steps, frames }) =>
			steps.top?.to.sub.fetch.site === 'same-site' &&
			steps.top.to.b.fetch.site === 'cross-site' &&
			frames.sub[0]?.site === 'same-site' &&
			frames.b[0]?.site === 'cross-site',
	},
	cookies: {
		rows: ({ steps, frames }) => ({
			'the cookies a fetch carries': each(
				(name) => steps.top?.to[name].fetch.cookies,
			),
			"the cookies a frame's document request carries": each((name) =>
				frames[name].map((request) => request.cookies),
			),
			'the cookies a WebSocket handshake carries, and its Origin': each(
				(name) => steps.top?.to[name].socket,
			),
			"a frame's document.cookie": each(
				(name) => steps.top?.to[name].frame.cookies,
			),
			// what a's fetch's response (ps_r_) and the frame's document's
			// (ps_f_) set, as the frame reads it (b's frame reads its None
			// cookies alone; b's top-level page, after, reads what was kept)
			'the cookies a response sets, to a fetch and to a frame': each((name) =>
				named(steps.top?.to[name].frame.cookies, /^ps_[rf]_/),
			),
			"a frame of a under b's frame: what its fetch and its WebSocket carry, its document.cookie":
				steps.top?.to.b.frame.nested,
			"a's cookies afterwards, top-level: what that frame's fetch kept": named(
				steps.legacy?.cookies,
				/^ps_n_/,
			),
			// a frame of a's site under a's page, but b's frame navigated it
			"what a frame b navigated to a kept of its response's cookies": [
				steps.top?.landed?.cookies,
				named(steps.legacy?.cookies, /^ps_z_/),
			],
			"a frame's Cookie Store API: what it reads, a write (default, None) and a deletion":
				each((name) => steps.top?.to[name].frame.store),
			"a frame's service worker's Cookie Store API, the same": each(
				(name) => steps.top?.to[name].frame.worker,
			),
			"the cookies a frame's own WebSocket handshake carries": each(
				(name) => steps.top?.to[name].frame.socket,
			),
			"which of a frame's script writes (default SameSite, None) it reads back":
				each((name) => steps.top?.to[name].frame.written),
			"b's cookies afterwards, top-level": steps['after b']?.cookies,
			'a cookie for the suffix and one for the name above, written under a':
				steps.top?.to.sub.frame.domainCookies,
		}),
		native: ({ steps }) =>
			steps.top?.to.sub.socket.cookies?.includes('ps_strict') &&
			String(steps.top.to.b.socket.cookies) === 'ps_none' &&
			String(steps.top.to.b.fetch.cookies) === 'ps_none' &&
			String(steps.top.to.sub.frame.domainCookies) === 'ps_above' &&
			// b's frame is another site's: None cookies alone, read or written
			String(steps.top.to.b.frame.socket) === 'ps_none' &&
			String(steps.top.to.b.frame.store.reads) === 'ps_none' &&
			/^TypeError/.test(steps.top.to.b.frame.store.writes[0]) &&
			/^TypeError/.test(steps.top.to.b.frame.worker.writes[0]) &&
			// a response sets None cookies alone where its site for cookies
			// is another site (b's top-level page reads what was kept)
			steps.top.to.sub.frame.cookies.includes('ps_r_lax') &&
			String(named(steps['after b'].cookies, /^ps_[rf]_/)) ===
				'ps_f_none,ps_r_none' &&
			// A in B in A is in a partition too
			String(steps.top.to.b.frame.nested.fetch) === 'ps_none' &&
			String(steps.top.to.b.frame.nested.socket) === 'ps_none' &&
			String(named(steps.legacy.cookies, /^ps_n_/)) === 'ps_n_none' &&
			// another site started the navigation of a frame of the top's site
			String(named(steps.legacy.cookies, /^ps_z_/)) === 'ps_z_none',
	},
	partitions: {
		rows: ({ steps, cacheLoads }) => ({
			"the mark a frame reads of its own name's top-level page": each(
				(name) => steps.top?.to[name].frame.mark,
			),
			"loads of a's cacheable resource that reached it, after each page":
				cacheLoads,
		}),
		// the name under a is in a's partition, b in its own; b's top-level
		// page loads the resource again, a's page takes the one the name
		// under it loaded
		native: ({ steps, cacheLoads }) =>
			steps.top?.to.sub.frame.mark?.startsWith('www.stomp-a.') &&
			steps.top.to.b.frame.mark === null &&
			cacheLoads['seed sub'] === 1 &&
			cacheLoads['seed b'] === 2 &&
			cacheLoads.top === 2,
	},
	windows: {
		rows: ({ steps }) => ({
			...Object.fromEntries(
				NAMES.flatMap((name) => {
					const to = steps.top?.to[name];
					return [
						[`what a's page reads of a frame of ${name}`, to?.reads],
						[
							`what a frame of ${name} reads of its parent`,
							to && {
								frameElement: to.frame.frameElement,
								parent: to.frame.parent,
								parentHref: to.frame.parentHref,
							},
						],
					];
				}),
			),
			'document.domain under a: the suffix, its last label, the name above':
				steps.top?.to.sub.frame.domain,
			originAgentCluster: [
				steps.top?.oac,
				...NAMES.map((name) => steps.top?.to[name].frame.oac),
			],
			'with Origin-Agent-Cluster: ?0, originAgentCluster': [
				steps.legacy?.oac,
				steps.legacy?.to.sub.frame.oac,
				steps.legacy?.to.b.frame.oac,
			],
			'with Origin-Agent-Cluster: ?0, document.domain': [
				steps.legacy?.domain,
				steps.legacy?.to.sub.frame.domain,
				steps.legacy?.to.b.frame.domain,
			],
			'with Origin-Agent-Cluster: ?0 and document.domain set, the windows': [
				'sub',
				'b',
			].map((name) => {
				const to = steps.legacy?.to[name];
				return to && [to.reads, to.frame.parent, to.frame.frameElement];
			}),
		}),
		native: ({ steps }) =>
			steps.top?.to.b.reads.document === 'SecurityError' &&
			steps.top.to.b.frame.parent === 'SecurityError' &&
			/is a top-level domain/.test(steps.top.to.sub.frame.domain.suffix) &&
			/is a top-level domain/.test(steps.legacy?.to.b.frame.domain),
	},
};

/**
 * The rows of `topics` (one or several, read from one run) for every
 * group: natively, then through the demo in both modes, each value
 * compared with Chrome's. `known` names the rows that differ from Chrome
 * and why ({ reason: [labels] }); one of them that reads as natively fails
 * too, so the list stays honest.
 */
export async function privateSiteRows(topics, known = {}) {
	const chosen = [topics].flat().map((topic) => TOPICS[topic]);
	const topic = [topics].flat().join(', ');
	const read = (run) =>
		Object.assign({}, ...chosen.map((entry) => entry.rows(run)));
	const holds = (run) => chosen.every((entry) => entry.native(run));
	// a step that did not report fails its rows, not the suite
	const rows = (run) => {
		try {
			return read(run);
		} catch (error) {
			return { 'the rows could be read': String(error) };
		}
	};
	const why = new Map(
		Object.entries(known).flatMap(([reason, labels]) =>
			labels.map((label) => [label, reason]),
		),
	);
	const sites = await startPrivateSites();
	const groups = Object.keys(SUFFIXES);
	// Playwright turns Chrome's storage partitioning off; a later
	// --disable-features replaces its list, so Chrome partitions as it ships
	const features = '--disable-features=PaintHolding';
	const nativeBrowser = await launch([...sites.nativeArgs, features]);
	const native = {};
	try {
		const context = await nativeBrowser.newContext();
		for (const group of groups) {
			let page;
			const run = await runGroup(
				sites,
				group,
				`native-${group}`,
				async (url) => {
					await page?.close();
					page = await context.newPage();
					await page.goto(url);
				},
				() => page,
			);
			await page.close();
			native[group] = rows(run);
			let held = false;
			try {
				held = !!holds(run);
			} catch (error) {
				// a step did not report
			}
			ok(
				`natively, stomp-a.${SUFFIXES[group]} and stomp-b.${SUFFIXES[group]} are two sites and www.stomp-a.${SUFFIXES[group]} is of the first (${topic})`,
				held,
				JSON.stringify(native[group]),
			);
		}
	} finally {
		await nativeBrowser.close();
	}
	const browser = await launch([features]);
	try {
		for (const [mode, base] of [
			['same-origin', PROXY],
			['isolated', HOST],
		]) {
			const page = await openDemo(browser, base);
			for (const group of groups) {
				const run = await runGroup(
					sites,
					group,
					`${mode.replace('-', '')}-${group}`,
					async (url) => {
						await page.click('#home').catch(() => {});
						await submitLanding(page, url);
					},
					() => page,
				);
				const proxied = rows(run);
				for (const [label, want] of Object.entries(native[group])) {
					const a = JSON.stringify(want ?? null);
					const b = JSON.stringify(proxied[label] ?? null);
					const name = `${mode}: ${SUFFIXES[group]}: ${label}`;
					const detail = `\n      native  ${a}\n      proxied ${b}`;
					if (why.has(label))
						ok(
							`${name} differs as known (${why.get(label)})`,
							a !== b,
							`now as natively: take it off the list${detail}`,
						);
					else ok(`${name} as natively`, a === b, detail);
				}
			}
			await page.context().close();
		}
	} finally {
		await browser.close();
		sites.close();
	}
}
