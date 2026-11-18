// The web-platform-tests side of the fixture (test/wpt-server.mjs) keeps each
// fixture's state its own, as each wptserve does: test/run.mjs starts one
// fixture per suite in one process, and the /_wpt/reset a wpt-* suite sends
// between its native and its proxied run must empty its own fixture's
// reports and stash alone. With one stash for every fixture, a page of
// another suite running beside it lost what its requests had stashed
// (wpt-fetch-objects' request-cache pages, beside wpt-fetch-metadata, read
// 0 or 1 of their 2 requests). No browser: two fixtures in this process,
// asked over HTTP.
import { createServer } from 'node:net';
import { startFixture } from '../fixture.mjs';
import { done, ok } from '../lib.mjs';

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const portA = await freePort();
let portB = await freePort();
while (portB === portA) portB = await freePort();
const servers = [await startFixture(portA), await startFixture(portB)];
const a = `http://127.0.0.1:${portA}`;
const b = `http://127.0.0.1:${portB}`;

const cache = '/fetch/api/request/resources/cache.py';
/** what cache.py logged under `token` (null: no request reached it) */
const state = async (origin, token) =>
	JSON.parse(
		await (await fetch(`${origin}${cache}?querystate&token=${token}`)).text(),
	);
const request = (origin, token) =>
	fetch(`${origin}${cache}?token=${token}&content=c&tag=1`).then((response) =>
		response.text(),
	);
const reset = (origin) => fetch(`${origin}/_wpt/reset`).then((r) => r.text());
const report = (origin, path) =>
	fetch(`${origin}/_wpt/report`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path, search: '', status: {}, tests: [] }),
	}).then((r) => r.text());
const reported = async (origin, path) =>
	(await fetch(`${origin}/_wpt/results?path=${encodeURIComponent(path)}`))
		.status;

await request(a, 'beside');
await reset(b);
const beside = await state(a, 'beside');
ok(
	"a fixture's stash keeps what a page's request put in it through another fixture's /_wpt/reset",
	Array.isArray(beside) && beside.length === 1,
	JSON.stringify(beside),
);

await report(a, '/beside.html');
await reset(b);
ok(
	'and its reports',
	(await reported(a, '/beside.html')) === 200,
	String(await reported(a, '/beside.html')),
);

await request(a, 'own');
await report(a, '/own.html');
await reset(a);
const own = await state(a, 'own');
ok(
	"a fixture's own /_wpt/reset still empties its stash",
	own === null,
	JSON.stringify(own),
);
ok(
	'and its reports',
	(await reported(a, '/own.html')) === 204,
	String(await reported(a, '/own.html')),
);

// one fixture serves every WPT host on its port: they share its stash
await request(`http://localhost:${portA}`, 'hosts');
const hosts = await state(a, 'hosts');
ok(
	"a fixture's hosts share its stash",
	Array.isArray(hosts) && hosts.length === 1,
	JSON.stringify(hosts),
);

// a handler of the fixture's own (record-headers.py) and one of an area
// module (cache.py, above) both keep to their fixture
const headers = '/fetch/metadata/resources/record-headers.py';
await fetch(`${a}${headers}?key=k1`);
ok(
	"what record-headers.py keeps on one fixture is not another fixture's",
	(await fetch(`${b}${headers}?key=k1&retrieve`)).status === 204,
);
ok(
	'and its own fixture hands it back',
	(await fetch(`${a}${headers}?key=k1&retrieve`)).status === 200,
);

for (const server of servers) server.close();
await done();
