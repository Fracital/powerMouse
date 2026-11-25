// Tor mode's fast-bootstrap snapshot, served (docs/tor-over-wisp.md "The
// fast-bootstrap snapshot"): GET /tor-client/bootstrap.zip answers with
// the files scripts/tor-snapshot.mjs writes in STOMP_TOR_BOOTSTRAP, the
// same bytes for every visitor (public directory documents, no query, no
// cookie read), compressed as the request accepts. A snapshot whose
// consensus is past its valid-until, or none, is a 404: the client then
// downloads the directory through a fallback relay as it does with no
// snapshot. With STOMP_TOR_BOOTSTRAP_EVERY (minutes) the server runs the
// builder itself, at start and on that period; without it a timer of the
// deployer's does.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILDER = fileURLToPath(
	new URL('../scripts/tor-snapshot.mjs', import.meta.url),
);
// the encodings the builder writes, in the order they are preferred
const ENCODINGS = [
	['br', 'bootstrap.zip.br'],
	['gzip', 'bootstrap.zip.gz'],
];

/** the encodings a request accepts (q=0 refuses one) */
function accepted(header = '') {
	const out = new Set();
	for (const part of String(header).split(',')) {
		const [name, ...params] = part.trim().toLowerCase().split(';');
		if (params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param))) continue;
		if (name) out.add(name);
	}
	return out;
}

/**
 * The snapshot in `dir`, as a request handler: its files are read again
 * whenever bootstrap.json (which the builder writes last) changes
 */
export function torSnapshot(dir, { now = Date.now } = {}) {
	let loaded = null;
	const current = () => {
		let stamp;
		try {
			const meta = statSync(join(dir, 'bootstrap.json'));
			stamp = `${meta.mtimeMs} ${meta.size}`;
		} catch {
			loaded = null;
			return null;
		}
		if (loaded?.stamp === stamp) return loaded;
		try {
			const meta = JSON.parse(
				readFileSync(join(dir, 'bootstrap.json'), 'utf8'),
			);
			const bodies = new Map([
				[null, readFileSync(join(dir, 'bootstrap.zip'))],
			]);
			for (const [encoding, name] of ENCODINGS)
				try {
					bodies.set(encoding, readFileSync(join(dir, name)));
				} catch {
					// served without it
				}
			if (bodies.get(null).length !== meta.bytes) throw new Error('torn');
			loaded = { stamp, meta, bodies, etag: `"${meta.sha256.slice(0, 32)}"` };
		} catch {
			// half written, or not the builder's: as if there were none
			loaded = null;
		}
		return loaded;
	};
	return (req, res) => {
		const snapshot = current();
		if (!snapshot || !(now() < snapshot.meta.validUntil)) {
			res.set('Cache-Control', 'no-store');
			return res.sendStatus(404);
		}
		res.set({
			'Cache-Control': 'no-cache',
			ETag: snapshot.etag,
			Vary: 'Accept-Encoding',
			'Content-Type': 'application/zip',
			'X-Content-Type-Options': 'nosniff',
		});
		if (req.headers['if-none-match'] === snapshot.etag)
			return res.status(304).end();
		const accepts = accepted(req.headers['accept-encoding']);
		const encoding = ENCODINGS.find(
			([name]) => accepts.has(name) && snapshot.bodies.has(name),
		)?.[0];
		if (encoding) res.set('Content-Encoding', encoding);
		res.end(
			req.method === 'HEAD' ? undefined : snapshot.bodies.get(encoding ?? null),
		);
	};
}

/**
 * Run the builder into `dir` now and every `minutes`, one run at a time;
 * `say` hears a run that failed
 */
export function refreshTorSnapshot(dir, minutes, say = console.warn) {
	let running = false;
	const run = () => {
		if (running) return;
		running = true;
		execFile(
			process.execPath,
			[BUILDER, '--out', dir],
			{ timeout: 5 * 60_000 },
			(error, _stdout, stderr) => {
				running = false;
				if (error)
					say(
						`Tor directory snapshot not refreshed: ${String(stderr || error.message).trim()}`,
					);
			},
		);
	};
	run();
	const timer = setInterval(run, minutes * 60_000);
	timer.unref();
	return () => clearInterval(timer);
}
