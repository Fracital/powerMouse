// Tor mode's fast-bootstrap snapshot (docs/tor-over-wisp.md "The
// fast-bootstrap snapshot"): what the client refuses before arti sees it
// (a snapshot past its consensus's valid-until, one with no consensus, one
// tor-js would not read), the hold that keeps a consensus arti refused out
// of the store, the builder's choice of documents, and the server's route.
// With the network (SKIP_NETWORK unset), arti itself (tor-js's wasm in
// Node, every link refused) is given a snapshot the builder made from the
// Tor network: it loads a good one from its cache with no link, fails its
// start on one whose consensus has one byte changed (so the service drops
// it and downloads), and takes one an hour past its valid-until, which is
// why the client checks the times first.
// `node --test test/tor-snapshot.mjs`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';
import {
	checkSnapshot,
	holdConsensus,
	Snapshot,
	SNAPSHOT_MAX_BYTES,
	zipMembers,
} from '../demo/public/tor-client/snapshot.mjs';
import { torSnapshot } from '../demo/torSnapshot.js';
import { publish, snapshotOf, storedZip } from '../scripts/tor-snapshot.mjs';

// A child of this file runs one offline arti client on a snapshot and
// prints what it did (a process of its own: the wasm's state, and the clock
// one case moves, are per process)
if (process.env.TOR_SNAPSHOT_ARTI) {
	const { file, mode } = JSON.parse(process.env.TOR_SNAPSHOT_ARTI);
	if (mode === 'late') {
		const real = Date.now;
		Date.now = () => real() + 4 * 3600_000;
	}
	const { Log, TorClient } = await import('tor-js');
	const entries = new Map();
	const lines = [];
	let links = 0;
	const client = new TorClient({
		bootstrap: new Uint8Array(readFileSync(file)),
		storage: {
			get: async (key) => entries.get(key) ?? null,
			set: async (key, value) => void entries.set(key, value),
			delete: async (key) => void entries.delete(key),
			keys: async (prefix) =>
				[...entries.keys()].filter((key) => key.startsWith(prefix)),
			getAll: async (prefix) =>
				[...entries].filter(([key]) => key.startsWith(prefix)),
			tryLock: async () => true,
			unlock: async () => {},
		},
		socketProvider: {
			connect: async () => {
				links++;
				throw new Error('offline');
			},
			gateway: null,
			close: () => {},
		},
		log: new Log({ rawLog: (_level, ...args) => lines.push(args.join(' ')) }),
		logLevel: 'info',
	});
	const outcome = await Promise.race([
		client.ready().then(
			() => null,
			(error) => String(error?.message ?? error),
		),
		new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
	]);
	const text = lines.join('\n');
	process.stdout.write(
		JSON.stringify({
			failed: outcome,
			loaded: /Loaded a good directory from cache/.test(text),
			// arti wants a newer consensus than the one it loaded
			stale: /Downloading a consensus/.test(text),
			links,
		}),
	);
	process.exit(0);
}

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-25T18:00:00Z');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** a microdesc consensus's preamble, valid from `after` for three hours */
const consensusText = (after = T0, version = '3 microdesc') =>
	[
		`network-status-version ${version}`,
		'vote-status consensus',
		'consensus-method 34',
		`valid-after ${stamp(after)}`,
		`fresh-until ${stamp(after + HOUR)}`,
		`valid-until ${stamp(after + 3 * HOUR)}`,
		'r relay AAAA 2026-01-01 00:00:00 192.0.2.1 9001 0',
		'm AAAA',
		'',
	].join('\n');
const snapshotBytes = (consensus = consensusText()) =>
	new Uint8Array(
		storedZip([
			['bootstrap/consensus-microdesc.txt', Buffer.from(consensus)],
			['bootstrap/authority-certs.txt', Buffer.from('')],
			['bootstrap/microdescs.txt', Buffer.from('')],
		]),
	);

test('a snapshot whose consensus is live is handed over, with its times', () => {
	for (const now of [T0 - 60_000, T0 + 60_000, T0 + 3 * HOUR - 1])
		assert.deepEqual(checkSnapshot(snapshotBytes(), now), {
			validAfter: T0,
			freshUntil: T0 + HOUR,
			validUntil: T0 + 3 * HOUR,
		});
	const members = zipMembers(snapshotBytes());
	assert.deepEqual(
		[...members.keys()],
		[
			'bootstrap/consensus-microdesc.txt',
			'bootstrap/authority-certs.txt',
			'bootstrap/microdescs.txt',
		],
	);
});

test('a stale snapshot is refused: its consensus is past its valid-until', () => {
	for (const now of [T0 + 3 * HOUR, T0 + 4 * HOUR, T0 + 72 * HOUR])
		assert.throws(() => checkSnapshot(snapshotBytes(), now), /expired at/);
});

test('a snapshot that is not one is refused', () => {
	const now = T0 + 60_000;
	const refuse = (bytes, reason) =>
		assert.throws(() => checkSnapshot(bytes, now), reason);
	// missing: no body, or no consensus in it
	refuse(new Uint8Array(0), /empty/);
	refuse(
		new Uint8Array(storedZip([['bootstrap/microdescs.txt', Buffer.from('')]])),
		/no bootstrap\/consensus-microdesc\.txt/,
	);
	// not a zip at all (an error page, say)
	refuse(new TextEncoder().encode('<html>Not Found</html>'), /no bootstrap/);
	// cut short
	refuse(snapshotBytes().subarray(0, 200), /truncated/);
	// a member compressed (Deflate), which tor-js does not read
	const deflated = Buffer.from(snapshotBytes());
	deflated.writeUInt16LE(8, 8);
	refuse(new Uint8Array(deflated), /compressed/);
	// another flavour, or a vote
	refuse(snapshotBytes(consensusText(T0, '3')), /not a microdesc consensus/);
	refuse(
		snapshotBytes(
			consensusText().replace('vote-status consensus', 'vote-status vote'),
		),
		/not a consensus/,
	);
	refuse(
		snapshotBytes(consensusText().replace(/^valid-until .*$/m, '')),
		/no times/,
	);
	refuse(new Uint8Array(SNAPSHOT_MAX_BYTES + 1), /more than a snapshot/);
});

/** a fetch that answers `body` (or `status`) and counts its calls */
function fakeFetch(body, status = 200) {
	const calls = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push([url, init]);
			return new Response(status === 200 ? body : null, { status });
		},
	};
}

test('the snapshot is fetched only when it is asked for, and read as tor-js reads its option', async () => {
	const { calls, fetch } = fakeFetch(snapshotBytes());
	const said = [];
	const snapshot = new Snapshot(
		'https://app.example/tor-client/bootstrap.zip',
		{
			fetch,
			now: () => T0 + 60_000,
			say: (level) => said.push(level),
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.length, 0, 'nothing fetched before it is asked for');
	assert.equal(snapshot.given, false);
	// tor-js: `withFastBootstrap(async () => supplied)`
	const bytes = await (async () => snapshot)();
	assert.ok(bytes instanceof Uint8Array);
	assert.equal(bytes.byteLength, snapshotBytes().byteLength);
	assert.equal(snapshot.given, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1].credentials, 'omit');
	assert.equal(calls[0][1].cache, 'no-cache');
	assert.deepEqual(said, ['info']);
	assert.ok(
		snapshot.isConsensus('k', JSON.stringify({ content: consensusText() })),
	);
	assert.ok(!snapshot.isConsensus('k', JSON.stringify({ content: 'other' })));
});

test('a snapshot that is missing or stale is not given: tor-js downloads the directory', async () => {
	for (const [answer, now, reason] of [
		[fakeFetch(null, 404), T0, /HTTP 404/],
		[fakeFetch(snapshotBytes()), T0 + 3 * HOUR, /expired/],
		[fakeFetch(new Uint8Array([1, 2, 3])), T0, /no bootstrap/],
	]) {
		const said = [];
		const snapshot = new Snapshot('/tor-client/bootstrap.zip', {
			fetch: answer.fetch,
			now: () => now,
			say: (level, text) => said.push([level, text]),
		});
		await assert.rejects((async () => snapshot)(), reason);
		assert.equal(snapshot.given, false);
		assert.equal(said[0][0], 'warn');
		assert.match(said[0][1], /the client downloads the directory/);
	}
});

/** a store as tor-js's TorStorage, in memory, with every write recorded */
function memory() {
	const data = new Map();
	const writes = [];
	return {
		data,
		writes,
		get: async (key) => data.get(key) ?? null,
		set: async (key, value) => {
			writes.push(['set', key]);
			data.set(key, value);
		},
		delete: async (key) => {
			writes.push(['delete', key]);
			data.delete(key);
		},
		keys: async (prefix) =>
			[...data.keys()].filter((k) => k.startsWith(prefix)),
		getAll: async (prefix) => [...data].filter(([k]) => k.startsWith(prefix)),
		tryLock: async () => true,
		unlock: async () => {},
	};
}

test('the consensus of a snapshot arti refused never reaches the store', async () => {
	const store = memory();
	const snapshot = { given: false };
	const hold = holdConsensus(store, snapshot, 'dir:consensus:');
	// before arti has the snapshot, nothing is held
	await hold.storage.set('dir:consensus:microdesc:before', 'a');
	snapshot.given = true;
	await hold.storage.set('dir:consensus:microdesc:snap', 'b');
	await hold.storage.set('dir:microdesc:01', 'c');
	await hold.storage.set('dir:authcert:aa:bb', 'd');
	await hold.storage.delete('dir:consensus:microdesc:before');
	assert.equal(hold.held, 2);
	assert.deepEqual(store.writes, [
		['set', 'dir:consensus:microdesc:before'],
		['set', 'dir:microdesc:01'],
		['set', 'dir:authcert:aa:bb'],
	]);
	hold.refuse();
	assert.equal(hold.held, 0);
	assert.equal(store.data.has('dir:consensus:microdesc:snap'), false);
	assert.equal(store.data.get('dir:consensus:microdesc:before'), 'a');
	// what comes after (a closed client's last writes) is not held
	await hold.storage.set('dir:consensus:microdesc:later', 'e');
	assert.equal(store.data.get('dir:consensus:microdesc:later'), 'e');
});

test('a snapshot arti took is written in order, the first write at once', async () => {
	const store = memory();
	const hold = holdConsensus(store, { given: true }, 'dir:consensus:');
	await hold.storage.set('dir:consensus:microdesc:a', 'pending');
	await hold.storage.set('dir:consensus:microdesc:a', 'checked');
	await hold.storage.delete('dir:consensus:microdesc:old');
	const done = hold.accept();
	assert.deepEqual(store.writes, [['set', 'dir:consensus:microdesc:a']]);
	await done;
	assert.deepEqual(store.writes, [
		['set', 'dir:consensus:microdesc:a'],
		['set', 'dir:consensus:microdesc:a'],
		['delete', 'dir:consensus:microdesc:old'],
	]);
	assert.equal(store.data.get('dir:consensus:microdesc:a'), 'checked');
	// and a directory arti downloaded instead keeps all but the snapshot's
	const other = memory();
	const held = holdConsensus(other, { given: true }, 'dir:consensus:');
	await held.storage.set('dir:consensus:microdesc:snap', 'snapshot');
	await held.storage.set('dir:consensus:microdesc:new', 'downloaded');
	await held.accept({ except: (_key, value) => value === 'snapshot' });
	assert.deepEqual([...other.data.keys()], ['dir:consensus:microdesc:new']);
});

/** what an arti client keeps, as tor-js writes it */
function kept({
	pending = false,
	after = T0,
	md = 'onion-key\nntor-onion-key x\n',
} = {}) {
	const hex = createHash('sha256').update(md).digest('hex');
	const b64 = createHash('sha256')
		.update(md)
		.digest('base64')
		.replace(/=+$/, '');
	const content = consensusText(after).replace('m AAAA', `m ${b64}`);
	return new Map([
		[
			'dir:consensus:microdesc:x',
			JSON.stringify({
				valid_after_secs: after / 1000,
				fresh_until_secs: (after + HOUR) / 1000,
				valid_until_secs: (after + 3 * HOUR) / 1000,
				pending,
				content,
			}),
		],
		[
			'dir:authcert:aa:bb',
			JSON.stringify({
				expires_secs: (T0 + 9000 * HOUR) / 1000,
				content: 'cert-a',
			}),
		],
		[
			'dir:authcert:cc:dd',
			JSON.stringify({ expires_secs: (T0 - HOUR) / 1000, content: 'cert-old' }),
		],
		[`dir:microdesc:${hex}`, JSON.stringify({ content: md })],
		['dir:microdesc:00', JSON.stringify({ content: 'onion-key\nunlisted\n' })],
	]);
}

test('the builder takes only a consensus arti checked, live certificates and the listed microdescriptors', () => {
	const now = T0 + 60_000;
	assert.throws(() => snapshotOf(kept({ pending: true }), now), /no checked/);
	assert.throws(() => snapshotOf(kept(), T0 + 3 * HOUR), /no checked/);
	const { zip, meta } = snapshotOf(kept(), now);
	const bytes = new Uint8Array(zip);
	const members = zipMembers(bytes);
	const text = (name) => {
		const [start, end] = members.get(`bootstrap/${name}`);
		return Buffer.from(bytes.subarray(start, end)).toString();
	};
	assert.equal(text('authority-certs.txt'), 'cert-a\n');
	assert.equal(text('microdescs.txt'), 'onion-key\nntor-onion-key x\n');
	assert.match(
		text('consensus-microdesc.txt'),
		/^network-status-version 3 microdesc\n/,
	);
	assert.deepEqual(checkSnapshot(bytes, now).validUntil, T0 + 3 * HOUR);
	assert.equal(meta.microdescriptors, 1);
	assert.equal(meta.missing, 0);
	assert.equal(meta.certificates, 1);
	// a microdescriptor whose text is not its digest's is left out
	const tampered = kept();
	for (const [key, value] of tampered)
		if (key.startsWith('dir:microdesc:') && key !== 'dir:microdesc:00')
			tampered.set(key, value.replace('ntor-onion-key x', 'ntor-onion-key y'));
	assert.equal(snapshotOf(tampered, now).meta.missing, 1);
});

/** GET `path` from `port` with `headers`: status, headers and the raw body */
const get = (port, path, headers = {}) =>
	new Promise((resolve, reject) => {
		request({ host: '127.0.0.1', port, path, headers }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () =>
				resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks),
				}),
			);
		})
			.on('error', reject)
			.end();
	});

const scratch = mkdtempSync(join(tmpdir(), 'tor-snapshot-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the server serves the same snapshot to everyone, compressed, and none that is stale or torn', async () => {
	const dir = join(scratch, 'served');
	let now = T0 + 60_000;
	const app = express();
	app.get('/tor-client/bootstrap.zip', torSnapshot(dir, { now: () => now }));
	const server = app.listen(0, '127.0.0.1');
	await new Promise((resolve) => server.once('listening', resolve));
	const { port } = server.address();
	const path = '/tor-client/bootstrap.zip';
	try {
		let answer = await get(port, path);
		assert.equal(answer.status, 404, 'no snapshot yet');
		assert.equal(answer.headers['cache-control'], 'no-store');

		const snapshot = snapshotOf(kept(), now);
		publish(dir, snapshot);
		answer = await get(port, path, {
			'accept-encoding': 'gzip, deflate, br, zstd',
		});
		assert.equal(answer.status, 200);
		assert.equal(answer.headers['content-encoding'], 'br');
		assert.equal(answer.headers['content-type'], 'application/zip');
		assert.equal(answer.headers.vary, 'Accept-Encoding');
		assert.equal(answer.headers['cache-control'], 'no-cache');
		assert.ok(brotliDecompressSync(answer.body).equals(snapshot.zip));
		const etag = answer.headers.etag;
		answer = await get(port, path, { 'accept-encoding': 'gzip' });
		assert.equal(answer.headers['content-encoding'], 'gzip');
		assert.ok(gunzipSync(answer.body).equals(snapshot.zip));
		answer = await get(port, path, { 'accept-encoding': 'br;q=0, identity' });
		assert.equal(answer.headers['content-encoding'], undefined);
		assert.ok(answer.body.equals(snapshot.zip));
		assert.equal(answer.headers.etag, etag);
		answer = await get(port, path, { 'if-none-match': etag });
		assert.equal(answer.status, 304);

		// past its valid-until, nothing is served
		now = T0 + 3 * HOUR;
		assert.equal((await get(port, path)).status, 404);
		now = T0 + 60_000;
		// a zip that is not the one bootstrap.json describes (a write under way)
		writeFileSync(
			join(dir, 'bootstrap.json'),
			JSON.stringify({ ...snapshot.meta, bytes: 1 }),
		);
		assert.equal((await get(port, path)).status, 404);
	} finally {
		server.close();
	}
});

/** run one offline arti client on the snapshot `file` (the child above) */
const arti = (file, mode) =>
	new Promise((resolve, reject) =>
		execFile(
			process.execPath,
			[import.meta.filename],
			{
				env: {
					...process.env,
					TOR_SNAPSHOT_ARTI: JSON.stringify({ file, mode }),
				},
				timeout: 60_000,
			},
			(error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
		),
	);

test(
	'arti checks a snapshot as its own cache: a good one loads with no link, a changed byte fails its start, a late one is taken',
	{
		skip: process.env.SKIP_NETWORK ? 'SKIP_NETWORK is set' : false,
		timeout: 240_000,
	},
	async () => {
		// the directory as the builder downloads it, from the Tor network (a
		// process of its own: the client's links keep a process alive after
		// it is closed, and the builder exits)
		const built = join(scratch, 'built');
		await new Promise((resolve, reject) =>
			execFile(
				process.execPath,
				[
					fileURLToPath(
						new URL('../scripts/tor-snapshot.mjs', import.meta.url),
					),
					'--out',
					built,
				],
				{ timeout: 180_000 },
				(error, _stdout, stderr) =>
					error ? reject(new Error(stderr || error.message)) : resolve(),
			),
		);
		const snapshot = {
			zip: readFileSync(join(built, 'bootstrap.zip')),
			meta: JSON.parse(readFileSync(join(built, 'bootstrap.json'), 'utf8')),
		};
		assert.equal(snapshot.meta.missing, 0, JSON.stringify(snapshot.meta));
		const good = join(built, 'bootstrap.zip');
		const loaded = await arti(good, 'good');
		assert.deepEqual(
			{ failed: loaded.failed, loaded: loaded.loaded, stale: loaded.stale },
			{ failed: null, loaded: true, stale: false },
			JSON.stringify(loaded),
		);

		// one byte of a relay's nickname, inside the signed part
		const changed = Buffer.from(snapshot.zip);
		const at = changed.indexOf('\nr ') + 3;
		changed[at] = changed[at] === 0x41 ? 0x42 : 0x41;
		const tampered = join(scratch, 'tampered.zip');
		writeFileSync(tampered, changed);
		const refused = await arti(tampered, 'tampered');
		assert.equal(refused.loaded, false, JSON.stringify(refused));
		assert.match(String(refused.failed), /Bootstrap failed/);
		assert.equal(refused.links, 0, 'not one link on a consensus it refused');

		// an hour past its valid-until: arti's tolerance takes it, so the
		// client's own check is what refuses it
		const late = await arti(good, 'late');
		assert.equal(late.loaded, true, JSON.stringify(late));
		assert.equal(late.stale, true, 'arti asks for a newer one at once');
		assert.throws(
			() => checkSnapshot(new Uint8Array(snapshot.zip), Date.now() + 4 * HOUR),
			/expired at/,
		);
	},
);
