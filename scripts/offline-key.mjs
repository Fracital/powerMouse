// What offline.html is made from, as one key (scripts/build-offline.mjs
// writes it into the file's first comment; demo/server.js compares it to
// the checkout's to tell a current file from one another tree left). It is
// the SHA-256 of dist/build.json (the build id, which covers src/ and
// assets/, and the commit, which names the commits the file lists) and of
// every other file the build reads: the demo's page, the offline page side,
// the build scripts, the lockfile (the transports' and the font's
// versions), the licence, the upstream records and the Cargo.lock files
// the notices quote, with the wisp server it is built with and whether the
// blocker is in. Reading it costs a few milliseconds and needs no esbuild.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const OFFLINE_WISP = 'wss://holywisp.fracit.al/';

const INPUTS = [
	'dist/build.json',
	'demo/public',
	'demo/offline',
	'scripts/build-offline.mjs',
	'scripts/offline-notices.mjs',
	'scripts/offline-key.mjs',
	'test/offline-tor-stand-in.mjs',
	'package-lock.json',
	'LICENSE',
	'assets/adblock-snapshot.UPSTREAM',
	'assets/adblock-resources.UPSTREAM',
	'rust/suffix/src/public_suffix_list.dat',
	'rust/Cargo.lock',
	'deploy/epoxy/h3/Cargo.lock',
];

/** the key of what `root` would build offline.html from, with these options */
export function offlineKey(
	root,
	{
		wisp = process.env.STOMP_OFFLINE_WISP || OFFLINE_WISP,
		adblock = true,
		torStandIn = false,
	} = {},
) {
	const hash = createHash('sha256');
	hash.update(`wisp ${wisp}\nadblock ${adblock}\n`);
	if (torStandIn) hash.update('tor stand-in\n');
	const add = (path) => {
		const full = join(root, path);
		if (!existsSync(full)) {
			hash.update(`missing ${path}\n`);
			return;
		}
		if (statSync(full).isDirectory()) {
			for (const name of readdirSync(full).sort()) add(`${path}/${name}`);
			return;
		}
		hash.update(`${path}\n`);
		hash.update(readFileSync(full));
	};
	for (const path of INPUTS) add(path);
	return hash.digest('hex');
}

/** the key a built offline.html names (its first comment), or null */
export function keyOfOffline(text) {
	return (
		/<!-- offline\.html [^>]*\bkey ([0-9a-f]{64})\b/.exec(
			text.slice(0, 2048),
		)?.[1] ?? null
	);
}
