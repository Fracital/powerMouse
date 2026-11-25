#!/usr/bin/env node
// Builds Tor mode's fast-bootstrap snapshot (docs/tor-over-wisp.md "The
// fast-bootstrap snapshot"): the microdesc consensus, the authorities'
// certificates and the microdescriptors it names, as tor-js's `bootstrap`
// option reads them (tor-js-gateway's bootstrap.zip: a zip of Stored
// members `bootstrap/consensus-microdesc.txt`, `bootstrap/authority-certs.txt`
// and `bootstrap/microdescs.txt`). demo/server.js serves it at
// /tor-client/bootstrap.zip (STOMP_TOR_BOOTSTRAP), so a first visit loads
// one file from the app's origin instead of the directory from a fallback
// relay.
//
// The directory is downloaded by tor-js itself, the same arti as the
// browser's, here in Node over direct TCP to the fallback directories'
// ORPorts (one-hop BEGIN_DIR, no DirPort, no tor daemon). Only a consensus
// arti has checked against the authorities' keys (its record no longer
// `pending`) goes in, with the certificates it checked and the
// microdescriptors whose SHA-256 the consensus lists. The browser checks it
// all again (arti loads it as its own cache); this check only keeps the
// server from publishing what a client would refuse.
//
//   node scripts/tor-snapshot.mjs --out <dir> [--timeout <seconds>]
//
// writes, each by rename so a reader never sees half a file:
//   bootstrap.zip     the snapshot
//   bootstrap.zip.br  and bootstrap.zip.gz, the same bytes compressed, which
//                     the server sends with Content-Encoding
//   bootstrap.json    its times, size and digest (written last: the server
//                     reads it to tell a snapshot is there and still valid)
//
// Exits 0 when it wrote one, 1 when it could not (nothing is replaced). It
// keeps no state between runs: each run downloads the whole directory, about
// 4 MB, so a timer every 30 minutes publishes each hour's consensus soon
// after the fallbacks have it.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const MEMBERS = {
	consensus: 'bootstrap/consensus-microdesc.txt',
	certs: 'bootstrap/authority-certs.txt',
	microdescs: 'bootstrap/microdescs.txt',
};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of Stored members, `[name, Buffer]` each: tor-js reads only local
 * headers and stops at the central directory, which is written anyway so
 * that unzip and the like open the file too. Times are zero, so the same
 * documents give the same bytes.
 */
export function storedZip(members) {
	const parts = [];
	const central = [];
	let offset = 0;
	for (const [name, data] of members) {
		const nameBytes = Buffer.from(name, 'utf8');
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		parts.push(local, nameBytes, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(members.length, 8);
	end.writeUInt16LE(members.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, ...central, end]);
}

/** a consensus document's `valid-after`, `fresh-until` and `valid-until`, in ms */
export function documentTimes(text) {
	const head = text.slice(0, 2000);
	const at = (name) => {
		const match = new RegExp(
			`^${name} (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)$`,
			'm',
		).exec(head);
		return match ? Date.parse(`${match[1].replace(' ', 'T')}Z`) : NaN;
	};
	return {
		validAfter: at('valid-after'),
		freshUntil: at('fresh-until'),
		validUntil: at('valid-until'),
	};
}

/** the microdescriptor digests a microdesc consensus lists, hex */
export function listedDigests(text) {
	return [...text.matchAll(/^m ([A-Za-z0-9+/]{43})$/gm)].map((match) =>
		Buffer.from(match[1], 'base64').toString('hex'),
	);
}

/**
 * The snapshot of what an arti client keeps in its TorStorage (a Map of its
 * `dir:` keys): its newest checked consensus, the certificates and the
 * listed microdescriptors. Throws when there is no checked consensus.
 */
export function snapshotOf(entries, now = Date.now()) {
	let consensus = null;
	for (const [key, value] of entries) {
		if (!key.startsWith('dir:consensus:microdesc:')) continue;
		const record = JSON.parse(value);
		if (record.pending !== false || typeof record.content !== 'string')
			continue;
		if (!(record.valid_until_secs * 1000 > now)) continue;
		if (!consensus || record.valid_after_secs > consensus.valid_after_secs)
			consensus = record;
	}
	if (!consensus) throw new Error('arti kept no checked, live consensus');
	const certs = [];
	for (const [key, value] of entries) {
		if (!key.startsWith('dir:authcert:')) continue;
		const record = JSON.parse(value);
		if (!(record.expires_secs * 1000 > now)) continue;
		const text = String(record.content);
		certs.push(text.endsWith('\n') ? text : `${text}\n`);
	}
	const listed = listedDigests(consensus.content);
	const microdescs = [];
	let missing = 0;
	for (const digest of listed) {
		const value = entries.get(`dir:microdesc:${digest}`);
		const text = value === undefined ? null : JSON.parse(value).content;
		// (tor-js keys each one by the SHA-256 of its text, from its
		// `onion-key` line to its last newline, and so does arti)
		if (
			typeof text !== 'string' ||
			!text.startsWith('onion-key\n') ||
			!text.endsWith('\n') ||
			createHash('sha256').update(text).digest('hex') !== digest
		) {
			missing++;
			continue;
		}
		microdescs.push(text);
	}
	const zip = storedZip([
		[MEMBERS.consensus, Buffer.from(consensus.content, 'utf8')],
		[MEMBERS.certs, Buffer.from(certs.join(''), 'utf8')],
		[MEMBERS.microdescs, Buffer.from(microdescs.join(''), 'utf8')],
	]);
	return {
		zip,
		meta: {
			validAfter: consensus.valid_after_secs * 1000,
			freshUntil: consensus.fresh_until_secs * 1000,
			validUntil: consensus.valid_until_secs * 1000,
			certificates: certs.length,
			microdescriptors: microdescs.length,
			missing,
			bytes: zip.length,
			sha256: createHash('sha256').update(zip).digest('hex'),
			built: now,
		},
	};
}

/** write `name` in `dir` by rename, so no reader sees half of it */
function put(dir, name, bytes) {
	const temporary = join(dir, `.${name}.${process.pid}`);
	writeFileSync(temporary, bytes);
	renameSync(temporary, join(dir, name));
}

/** publish a snapshot (snapshotOf's) in `dir` */
export function publish(dir, { zip, meta }) {
	mkdirSync(dir, { recursive: true });
	put(dir, 'bootstrap.zip', zip);
	put(
		dir,
		'bootstrap.zip.br',
		brotliCompressSync(zip, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: 9,
				[constants.BROTLI_PARAM_SIZE_HINT]: zip.length,
			},
		}),
	);
	put(dir, 'bootstrap.zip.gz', gzipSync(zip, { level: 9 }));
	put(dir, 'bootstrap.json', `${JSON.stringify(meta, null, '\t')}\n`);
}

/**
 * Download the directory with tor-js in Node and return what it kept
 * (snapshotOf's entries): `ready()`, then until every microdescriptor the
 * checked consensus lists is in, or `settleMs` more.
 */
export async function download({
	timeoutMs = 120_000,
	settleMs = 30_000,
} = {}) {
	const { Log, TorClient } = await import('tor-js');
	const entries = new Map();
	const store = {
		get: async (key) => entries.get(key) ?? null,
		set: async (key, value) => void entries.set(key, value),
		delete: async (key) => void entries.delete(key),
		keys: async (prefix) =>
			[...entries.keys()].filter((key) => key.startsWith(prefix)),
		getAll: async (prefix) =>
			[...entries].filter(([key]) => key.startsWith(prefix)),
		tryLock: async () => true,
		unlock: async () => {},
	};
	const warnings = [];
	const client = new TorClient({
		storage: store,
		log: new Log({
			rawLog: (level, ...args) => {
				if (level === 'warn' || level === 'error')
					warnings.push(args.join(' ').slice(0, 300));
			},
		}),
		logLevel: 'info',
	});
	let timer;
	try {
		await Promise.race([
			client.ready(),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`no directory in ${timeoutMs} ms`)),
					timeoutMs,
				);
			}),
		]);
		const complete = () => {
			try {
				return snapshotOf(entries).meta.missing === 0;
			} catch {
				return false;
			}
		};
		const until = Date.now() + settleMs;
		while (!complete() && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 250));
		return entries;
	} catch (error) {
		if (warnings.length) error.message += ` (arti: ${warnings.at(-1)})`;
		throw error;
	} finally {
		clearTimeout(timer);
		client.close();
	}
}

const isMain = process.argv[1] && import.meta.filename === process.argv[1];
if (isMain) {
	const option = (name) => {
		const at = process.argv.indexOf(name);
		return at === -1 ? null : process.argv[at + 1];
	};
	const out = option('--out');
	if (!out) {
		console.error(
			'usage: node scripts/tor-snapshot.mjs --out <dir> [--timeout <seconds>]',
		);
		process.exit(2);
	}
	const started = Date.now();
	try {
		const entries = await download({
			timeoutMs: Number(option('--timeout') ?? 120) * 1000,
		});
		const snapshot = snapshotOf(entries);
		publish(out, snapshot);
		const { meta } = snapshot;
		console.log(
			`tor-snapshot: ${meta.bytes} bytes (consensus valid-after ${new Date(meta.validAfter).toISOString()}, until ${new Date(meta.validUntil).toISOString()}; ${meta.certificates} certificates, ${meta.microdescriptors} microdescriptors, ${meta.missing} missing) in ${Date.now() - started} ms`,
		);
		process.exit(0);
	} catch (error) {
		console.error(`tor-snapshot: ${error?.message ?? error}`);
		process.exit(1);
	}
}
