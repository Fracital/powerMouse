// The worker's load grants (src/server/loadGrants.ts): what lets the inject
// copy a load for a document no service worker controls. A grant is
// announced on the channel a client opened, for one URL and one load, and
// taken once by the request that carries its token: a token nobody
// announced, one taken before, one of another client or for another URL,
// an expired one and anything that is no token are the page's own
// requests. One channel per client; what the worker keeps is bounded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT, sleep } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP load-grants: esbuild is not installed');
}

if (esbuild) {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	mkdirSync(OUT, { recursive: true });
	const entry = `${OUT}load-grants-entry.mjs`;
	writeFileSync(
		entry,
		`export * from ${JSON.stringify(`${root}src/server/loadGrants.ts`)};\n`,
	);
	const bundle = `${OUT}load-grants.mjs`;
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundle,
		logLevel: 'silent',
	});
	// the worker's global: its clients, and what it posted to them
	const posted = [];
	globalThis.self = globalThis;
	globalThis.clients = {
		get: async (id) => ({
			postMessage: (message) => posted.push([id, Object.keys(message)[0]]),
		}),
		matchAll: async () => [{ id: 'A' }, { id: 'B' }],
	};
	const grants = await import(`${bundle}?${Date.now()}`);
	const { openLoadChannel, takeLoadGrant, loadGrantStats } = grants;

	let serial = 0;
	const token = () => String(++serial).padStart(22, 'A');
	const URL_A = 'http://proxy.test/stomp/x/binary/one';
	const tick = () => sleep(15);
	const open = (client) => {
		const channel = new MessageChannel();
		const taken = openLoadChannel(client, channel.port2);
		return { taken, port: channel.port1 };
	};
	const announce = async (port, grant) => {
		port.postMessage(grant);
		await tick();
	};

	const a = open('A');
	const acknowledged = new Promise((resolve) => {
		a.port.onmessage = (event) => resolve(event.data);
	});
	ok("a client's first channel is taken", a.taken === true);
	ok(
		'and the worker says so on it',
		(await Promise.race([acknowledged, sleep(500)])) === true,
	);
	const second = open('A');
	ok('a second channel of the same client is refused', second.taken === false);

	{
		const t = token();
		await announce(a.port, { token: t, url: URL_A, load: 'image no-cors' });
		const first = await takeLoadGrant(t, 'A', URL_A);
		const again = await takeLoadGrant(t, 'A', URL_A);
		ok(
			'an announced request is granted the load it named, once',
			first === 'image no-cors' && again === null,
			JSON.stringify({ first, again }),
		);
		await announce(a.port, { token: t, url: URL_A, load: 'image no-cors' });
		ok(
			'a token taken before cannot be announced again',
			(await takeLoadGrant(t, 'A', URL_A)) === null,
		);
	}
	{
		const t = token();
		await announce(second.port, {
			token: t,
			url: URL_A,
			load: 'image no-cors',
		});
		const started = Date.now();
		const got = await takeLoadGrant(t, 'A', URL_A);
		ok(
			'an announcement on a refused channel grants nothing',
			got === null && Date.now() - started >= 900,
			JSON.stringify({ got, ms: Date.now() - started }),
		);
	}
	{
		const t = token();
		await announce(a.port, { token: t, url: URL_A, load: 'script no-cors' });
		const other = await takeLoadGrant(t, 'B', URL_A);
		const owner = await takeLoadGrant(t, 'A', URL_A);
		ok(
			'a token another client sends grants nothing, and is spent',
			other === null && owner === null,
			JSON.stringify({ other, owner }),
		);
	}
	{
		const t = token();
		await announce(a.port, { token: t, url: URL_A, load: 'image no-cors' });
		const elsewhere = await takeLoadGrant(t, 'A', `${URL_A}-other`);
		ok('a token sent for another URL grants nothing', elsewhere === null);
		const u = token();
		await announce(a.port, {
			token: u,
			url: `${URL_A}#part`,
			load: 'image no-cors',
		});
		ok(
			'a fragment is no part of the URL',
			(await takeLoadGrant(u, 'A', URL_A)) === 'image no-cors',
		);
	}
	{
		const t = token();
		await announce(a.port, { token: t, url: URL_A, load: 'image no-cors' });
		const both = await Promise.all([
			takeLoadGrant(t, 'A', URL_A),
			takeLoadGrant(t, 'A', URL_A),
		]);
		ok(
			'two requests racing for one grant: one has it',
			both.filter((load) => load === 'image no-cors').length === 1 &&
				both.filter((load) => load === null).length === 1,
			JSON.stringify(both),
		);
	}
	{
		const t = token();
		const early = Promise.all([
			takeLoadGrant(t, 'A', URL_A),
			takeLoadGrant(t, 'A', URL_A),
		]);
		await tick();
		await announce(a.port, { token: t, url: URL_A, load: 'style no-cors' });
		const both = await early;
		ok(
			'a request that comes before its announcement waits for it, and only one does',
			both.filter((load) => load === 'style no-cors').length === 1 &&
				both.filter((load) => load === null).length === 1,
			JSON.stringify(both),
		);
	}
	{
		const started = Date.now();
		const results = [
			await takeLoadGrant('image no-cors', 'A', URL_A),
			await takeLoadGrant('copy', 'A', URL_A),
			await takeLoadGrant(null, 'A', URL_A),
			await takeLoadGrant(token(), undefined, URL_A),
		];
		ok(
			'a value that is no token, or a request of no client, is refused at once',
			results.every((load) => load === null) && Date.now() - started < 200,
			JSON.stringify({ results, ms: Date.now() - started }),
		);
	}
	{
		const started = Date.now();
		const unknown = await takeLoadGrant(token(), 'A', URL_A);
		ok(
			'a token nobody announced grants nothing (after the wait for its announcement)',
			unknown === null && Date.now() - started >= 900,
			JSON.stringify({ unknown, ms: Date.now() - started }),
		);
	}
	{
		// a worker that restarted has no channel for the client
		const before = posted.length;
		const first = takeLoadGrant(token(), 'C', URL_A);
		await tick();
		const asked = posted.slice(before);
		// requests that come while the channel may still open wait with it
		const second = await takeLoadGrant(token(), 'C', URL_A);
		await first;
		const started = Date.now();
		const late = await takeLoadGrant(token(), 'C', URL_A);
		ok(
			'a client without a channel is asked to open one, once',
			asked.length === 1 &&
				asked[0][0] === 'C' &&
				asked[0][1] === '$stomp$swRevive' &&
				second === null &&
				late === null &&
				Date.now() - started < 200 &&
				posted.length === before + 1,
			JSON.stringify({ asked, second, late, ms: Date.now() - started }),
		);
		const t = token();
		const waiting = takeLoadGrant(t, 'D', URL_A);
		await tick();
		const d = open('D');
		await announce(d.port, { token: t, url: URL_A, load: 'image no-cors' });
		ok(
			'and the request that asked is granted what the reopened channel tells again',
			d.taken === true && (await waiting) === 'image no-cors',
		);
	}
	{
		const bad = [
			{ token: 'short', url: URL_A, load: 'image no-cors' },
			{ token: token(), url: 'not a url', load: 'image no-cors' },
			{ token: token(), url: URL_A, load: 'IMAGE; DROP' },
			{ token: token(), url: `${URL_A}?${'x'.repeat(17000)}`, load: 'image' },
			{ token: token(), url: URL_A },
			null,
			'text',
		];
		const before = loadGrantStats().grants;
		for (const message of bad) a.port.postMessage(message);
		await tick();
		ok(
			'an announcement that is not one is ignored',
			loadGrantStats().grants === before,
			JSON.stringify(loadGrantStats()),
		);
	}
	{
		const t = token();
		await announce(a.port, { token: t, url: URL_A, load: 'image no-cors' });
		const now = Date.now;
		Date.now = () => now() + grants.GRANT_TTL_MS + 1;
		const late = await takeLoadGrant(t, 'A', URL_A);
		Date.now = now;
		ok('a grant its request never came for expires', late === null);
	}
	{
		const b = open('B');
		for (let i = 0; i < grants.GRANTS_PER_CLIENT + 300; i++)
			a.port.postMessage({ token: token(), url: URL_A, load: 'image no-cors' });
		await sleep(200);
		const one = loadGrantStats().grants;
		for (let i = 0; i < grants.GRANTS_KEPT + 300; i++) {
			const port = i % 2 ? a.port : b.port;
			port.postMessage({
				token: token(),
				url: `${URL_A}?${i}`,
				load: 'image no-cors',
			});
		}
		for (let i = 0; i < 40; i++) open(`E${i}`);
		await sleep(400);
		const all = loadGrantStats();
		ok(
			'what is kept is bounded: per client, in all, and the tokens remembered as spent',
			one <= grants.GRANTS_PER_CLIENT &&
				all.grants <= grants.GRANTS_KEPT &&
				all.grants <= 2 * grants.GRANTS_PER_CLIENT &&
				all.spent <= 1024 &&
				all.waiting === 0,
			JSON.stringify({ one, all }),
		);
	}
}

await done();
