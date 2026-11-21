// The licence texts of the Rust crates in offline.html's wasm modules, as
// demo/offline/notices/crates.json, which scripts/offline-notices.mjs
// writes into the file. Run it by hand when a module's crates change (the
// offline build fails until it is):
//
//   node scripts/crate-notices.mjs
//
// It asks cargo in the containers that build the modules, where every
// crate's source is at hand: deploy/rust's toolchain image for core.wasm,
// codec.wasm and blocker.wasm (rust/ is copied in, as build.sh does), and
// deploy/epoxy's image of the epoxy build the tree pins for epoxy-simd.wasm
// and stomp_h3_bg.wasm (deploy/epoxy/build.sh makes it; that build's
// lockfile is in no checkout of this repository), and deploy/tor-js's image
// of the tor-js build package.json pins for tor_js_bg.wasm (Tor mode's
// arti; deploy/tor-js/build.sh). ENGINE names the container engine, as for
// those scripts. `--only tor-js` asks only tor-js's image and keeps the
// other modules as crates.json has them.
//
// A module's crates are what `cargo metadata --filter-platform
// wasm32-unknown-unknown` resolves from its crate by normal dependencies
// (proc macros and what they use included, build scripts' and tests' crates
// not), each with the licence its Cargo.toml names and the licence and
// notice files of its package. crates.json also keeps, for each module
// built from a lockfile here, every other crate the lockfile resolves for
// it (another target's, a build script's): scripts/offline-notices.mjs
// walks the lockfile again and fails the build when that set has changed
// (a feature turned on that reaches a crate the lockfile already had for
// another target is not seen: run this after such a change too). A crate
// whose package ships no licence file has its source's held in
// demo/offline/notices/crates/ instead. The build reads only those files,
// so it needs no cargo and stays reproducible.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { lockedPackages } from './offline-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'demo/offline/notices/crates.json');
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i;

const engine = (() => {
	if (process.env.ENGINE) return process.env.ENGINE;
	for (const name of ['docker', 'podman'])
		try {
			execFileSync(name, ['info'], { stdio: 'ignore' });
			return name;
		} catch {
			// the next one
		}
	throw new Error('no working container engine (docker or podman)');
})();
const run = (args, options = {}) =>
	execFileSync(engine, args, {
		maxBuffer: 1 << 30,
		stdio: ['pipe', 'pipe', 'inherit'],
		...options,
	});
const hasImage = (tag) => {
	try {
		run(['image', 'inspect', tag], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

// Inside a container: cargo's metadata of each workspace, the licence and
// notice files of every package it names (and of a path crate's parent, a
// workspace's root), and the toolchain's own licences for the standard
// library. Fields are NUL-separated: a tag, then its values.
const DUMP = String.raw`
set -euo pipefail
emit() { printf '%s\0' "$@"; }
for ws in "$@"; do
	meta=$(mktemp)
	(cd "$ws" && cargo metadata --format-version 1 --locked --filter-platform wasm32-unknown-unknown) > "$meta"
	emit META "$ws"
	cat "$meta"
	printf '\0'
	grep -o '"manifest_path":"[^"]*"' "$meta" | sed 's/^"manifest_path":"//; s/"$//' | while read -r manifest; do
		dirname "$manifest"
		case "$manifest" in /usr/local/cargo/*) ;; *) dirname "$(dirname "$manifest")" ;; esac
	done | sort -u > "$meta.dirs"
	while read -r dir; do
		for file in "$dir"/*; do
			[ -f "$file" ] || continue
			case "$(basename "$file" | tr '[:upper:]' '[:lower:]')" in
			licence* | license* | copying* | copyright* | notice* | unlicense*) ;;
			*) continue ;;
			esac
			emit FILE "$file"
			cat "$file"
			printf '\0'
		done
	done < "$meta.dirs"
done
emit RUSTC "$(rustc --version)"
for file in MIT.txt Apache-2.0.txt; do
	emit STD "$file"
	cat "$(rustc --print sysroot)/share/doc/rust/licenses/$file"
	printf '\0'
done
`;

function parseDump(bytes) {
	const fields = bytes.toString('utf8').split('\0');
	const out = { metas: new Map(), files: new Map(), std: new Map() };
	for (let i = 0; i < fields.length - 1;) {
		const tag = fields[i++];
		if (tag === 'META') {
			const ws = fields[i++];
			out.metas.set(ws, JSON.parse(fields[i++]));
		} else if (tag === 'FILE') {
			const path = fields[i++];
			const text = fields[i++];
			if (LICENCE_FILE.test(path.slice(path.lastIndexOf('/') + 1)))
				out.files.set(path, text);
		} else if (tag === 'RUSTC') out.rustc = fields[i++];
		else if (tag === 'STD') out.std.set(fields[i++], fields[i++]);
		else if (tag === '') continue;
		else throw new Error(`the dump has a field ${JSON.stringify(tag)}`);
	}
	return out;
}

/** the rust/ workspace in deploy/rust's toolchain image (as build.sh runs it) */
function dumpRust() {
	const here = join(root, 'deploy/rust');
	const tag = `stomp-rust-toolchain:${createHash('sha256')
		.update(readFileSync(join(here, 'Dockerfile')))
		.update(readFileSync(join(here, 'pins.env')))
		.digest('hex')
		.slice(0, 12)}`;
	if (!hasImage(tag))
		throw new Error(
			`${tag} is not built: deploy/rust/build.sh makes it (any crate)`,
		);
	const id = run([
		'create',
		'--network',
		'host',
		'-v',
		'stomp-cargo-registry:/usr/local/cargo/registry',
		tag,
		'bash',
		'-c',
		`set -euo pipefail\nbash /work/patches.sh >&2\n${DUMP}`,
		'dump',
		'/work/rust',
	])
		.toString()
		.trim();
	const tmp = mkdtempSync(join(tmpdir(), 'crate-notices-'));
	try {
		execFileSync('mkdir', ['-p', join(tmp, 'work/rust')]);
		execFileSync('bash', [
			'-c',
			'cd "$1/rust" && tar --exclude=./target --exclude=./patched -cf - . | tar -xf - -C "$2/work/rust" && cp "$1/deploy/rust/patches.sh" "$2/work/patches.sh"',
			'copy',
			root,
			tmp,
		]);
		run(['cp', join(tmp, 'work/rust'), `${id}:/work/rust`]);
		run(['cp', join(tmp, 'work/patches.sh'), `${id}:/work/patches.sh`]);
		return parseDump(run(['start', '-a', id]));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		run(['rm', '-f', id], { stdio: 'ignore' });
	}
}

/** epoxy-tls and stomp-h3 in deploy/epoxy's image of the pinned build */
function dumpEpoxy() {
	const here = join(root, 'deploy/epoxy');
	// the tag build.sh gives it
	const tag = execFileSync(
		'bash',
		[
			'-c',
			'source ./upstream.env && echo "epoxy-fracital:${EPOXY_TLS_REV:0:12}-$(cat patches/*/*.patch h3/Cargo.* h3/*.sh h3/src/*.rs h3/patches/*/*.patch | sha256sum | cut -c1-12)"',
		],
		{ cwd: here },
	)
		.toString()
		.trim();
	if (!hasImage(tag))
		throw new Error(`${tag} is not built: deploy/epoxy/build.sh makes it`);
	const upstream = run(['run', '--rm', tag, 'cat', '/out/UPSTREAM']).toString();
	const installed = readFileSync(
		join(root, 'node_modules/@mercuryworkshop/epoxy-transport/UPSTREAM'),
		'utf8',
	);
	if (upstream !== installed)
		throw new Error(
			`${tag} is not the build the installed @mercuryworkshop/epoxy-transport is (their UPSTREAM files differ)`,
		);
	const lock = run([
		'run',
		'--rm',
		tag,
		'cat',
		'/src/stomp-h3/Cargo.lock',
	]).toString();
	if (lock !== readFileSync(join(here, 'h3/Cargo.lock'), 'utf8'))
		throw new Error(`${tag}'s stomp-h3 lockfile is not deploy/epoxy/h3's`);
	const dump = parseDump(
		run([
			'run',
			'--rm',
			'--network',
			'host',
			tag,
			'bash',
			'-c',
			DUMP,
			'dump',
			'/src/epoxy-tls',
			'/src/stomp-h3',
		]),
	);
	dump.upstream = upstream;
	return dump;
}

/** tor-js's workspace in deploy/tor-js's image of the installed build */
function dumpTorJs() {
	const here = join(root, 'deploy/tor-js');
	// the tag build.sh gives it
	const tag = execFileSync(
		'bash',
		[
			'-c',
			'source ./upstream.env && echo "tor-js-fracital:${TOR_JS_REV:0:12}-p1-$( (cat Dockerfile; find patches -name \'*.patch\' -print0 | sort -z | xargs -0r cat) | sha256sum | cut -c1-12)"',
		],
		{ cwd: here },
	)
		.toString()
		.trim();
	if (!hasImage(tag))
		throw new Error(`${tag} is not built: deploy/tor-js/build.sh makes it`);
	const upstream = readFileSync(
		join(root, 'node_modules/tor-js/UPSTREAM'),
		'utf8',
	);
	const built = run([
		'run',
		'--rm',
		tag,
		'bash',
		'-c',
		'cut -d" " -f1 /out/SHA256; cat /out/COMMIT',
	])
		.toString()
		.trim()
		.split('\n');
	if (
		!upstream.includes(`(this build)       ${built[0]}`) ||
		!upstream.includes(`patched commit ${built[1]} `)
	)
		throw new Error(
			`${tag} is not the build the installed tor-js is (its wasm or its commit is not node_modules/tor-js/UPSTREAM's)`,
		);
	const dump = parseDump(
		run([
			'run',
			'--rm',
			'--network',
			'host',
			tag,
			'bash',
			'-c',
			DUMP,
			'dump',
			'/src',
		]),
	);
	dump.upstream = upstream;
	return dump;
}

/** the crates a module is compiled from: a normal-dependency walk of cargo's resolve */
function moduleCrates(meta, rootName) {
	const packages = new Map(meta.packages.map((p) => [p.id, p]));
	const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
	const start = meta.packages.filter(
		(p) => p.name === rootName && meta.workspace_members.includes(p.id),
	);
	if (start.length !== 1)
		throw new Error(`${rootName}: ${start.length} workspace members`);
	const seen = new Set();
	const walk = (id) => {
		if (seen.has(id)) return;
		seen.add(id);
		for (const dep of nodes.get(id).deps)
			if (dep.dep_kinds.some((kind) => kind.kind === null)) walk(dep.pkg);
	};
	walk(start[0].id);
	seen.delete(start[0].id);
	return [...seen].map((id) => packages.get(id));
}

const texts = {}; // hash: text
const crates = {}; // "name version": what it is
const keep = (text) => {
	const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
	texts[hash] = text;
	return hash;
};

/** a package's entry: its licence, its files' texts, where it comes from */
function describe(dump, meta, pkg) {
	const key = `${pkg.name} ${pkg.version}`;
	if (crates[key]) return key;
	const dir = dirname(pkg.manifest_path);
	const own = (base) =>
		[...dump.files.keys()]
			.filter((path) => dirname(path) === base)
			.sort()
			.map((path) => ({
				file: path.slice(base.length + 1),
				path,
			}));
	let found = own(dir);
	if (pkg.license_file) {
		const path = resolve(dir, pkg.license_file);
		if (!dump.files.has(path))
			throw new Error(`${key}: its license-file ${path} was not read`);
		if (!found.some((f) => f.path === path))
			found.push({ file: pkg.license_file, path });
	}
	const local = pkg.source === null;
	// a path crate of a workspace often has its licence at the root only
	if (!found.length && local) found = own(dirname(dir));
	crates[key] = {
		license: pkg.license ?? null,
		source: local
			? meta.workspace_members.includes(pkg.id)
				? "a member of the build's workspace"
				: 'a patched or vendored copy, at the path the build names'
			: pkg.source.startsWith('registry+')
				? 'crates.io'
				: pkg.source.replace(/#.*/, ''),
		...(pkg.repository ? { repository: pkg.repository } : {}),
		...(pkg.authors?.length ? { authors: pkg.authors } : {}),
		files: Object.fromEntries(
			found.map(({ file, path }) => [file, keep(dump.files.get(path))]),
		),
	};
	return key;
}

const only = process.argv.includes('--only')
	? process.argv[process.argv.indexOf('--only') + 1]
	: null;
if (only !== null && only !== 'tor-js')
	throw new Error(`--only ${only}: only tor-js can be asked alone`);
const before = only ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (before) {
	Object.assign(crates, before.crates);
	Object.assign(texts, before.texts);
}
const rust = only ? null : dumpRust();
const epoxy = only ? null : dumpEpoxy();
const torJs = dumpTorJs();
const modules = before
	? before.modules.filter((module) => module.crate !== 'tor-js')
	: [];
const fromLock = (dump, ws, lock, name, files) => {
	const meta = dump.metas.get(ws);
	const own = new Set(meta.workspace_members);
	const inModule = moduleCrates(meta, name);
	const keys = inModule
		.filter((p) => !own.has(p.id))
		.map((p) => describe(dump, meta, p))
		.sort();
	const ours = inModule
		.filter((p) => own.has(p.id))
		.map((p) => `${p.name} ${p.version}`);
	const locked = lockedPackages(join(root, lock), [name]);
	const others = locked
		.map((p) => `${p.name} ${p.version}`)
		.filter((k) => !keys.includes(k) && !ours.includes(k))
		.sort();
	const missing = keys.filter(
		(k) => !locked.some((p) => `${p.name} ${p.version}` === k),
	);
	if (missing.length)
		throw new Error(`${lock} does not resolve ${missing.join(', ')}`);
	modules.push({
		files,
		crate: name,
		lock,
		crates: keys,
		workspace: ours.sort(),
		notInModule: others,
	});
};
if (!only) {
	fromLock(rust, '/work/rust', 'rust/Cargo.lock', 'core-module', [
		'/stomp/core.wasm',
	]);
	fromLock(rust, '/work/rust', 'rust/Cargo.lock', 'codec', [
		'/stomp/codec.wasm',
	]);
	fromLock(rust, '/work/rust', 'rust/Cargo.lock', 'block', [
		'/stomp/blocker.wasm',
	]);
	fromLock(epoxy, '/src/stomp-h3', 'deploy/epoxy/h3/Cargo.lock', 'stomp-h3', [
		'/epoxy/h3/stomp_h3_bg.wasm',
	]);
}
if (!only) {
	// epoxy-simd.wasm: its lockfile is the build's, checked by the epoxy
	// transport's UPSTREAM instead
	const meta = epoxy.metas.get('/src/epoxy-tls');
	const inModule = moduleCrates(meta, 'epoxy-client');
	modules.push({
		files: ['/epoxy/epoxy-simd.wasm'],
		crate: 'epoxy-client',
		upstream: epoxy.upstream,
		crates: inModule.map((p) => describe(epoxy, meta, p)).sort(),
		workspace: [],
	});
}
{
	// tor_js_bg.wasm: its lockfile is the build's, checked by the installed
	// tor-js's UPSTREAM instead
	const meta = torJs.metas.get('/src');
	const inModule = moduleCrates(meta, 'tor-js');
	modules.push({
		files: ['/tor-client/tor_js_bg.wasm'],
		crate: 'tor-js',
		upstream: torJs.upstream,
		upstreamFile: 'node_modules/tor-js/UPSTREAM',
		crates: inModule.map((p) => describe(torJs, meta, p)).sort(),
		workspace: [],
	});
}
for (const other of [epoxy, torJs])
	if (rust && other && rust.rustc !== other.rustc)
		console.warn(
			`crate-notices: the toolchains differ: ${rust.rustc} and ${other.rustc}`,
		);
const std = before?.std ?? {
	rustc: rust.rustc,
	files: Object.fromEntries(
		[...rust.std].map(([file, text]) => [file, keep(text)]),
	),
};
for (const [file, text] of torJs.std)
	if (!Object.values(std.files).includes(keep(text)))
		console.warn(`crate-notices: tor-js's toolchain's ${file} is another text`);

const sorted = (object) =>
	Object.fromEntries(
		Object.entries(object).sort(([a], [b]) => a.localeCompare(b)),
	);
const data = {
	about:
		'Written by scripts/crate-notices.mjs; read by scripts/offline-notices.mjs. Do not edit.',
	modules,
	std,
	crates: sorted(crates),
	texts: sorted(texts),
};
const options = (await prettier.resolveConfig(OUT)) ?? {};
writeFileSync(
	OUT,
	await prettier.format(JSON.stringify(data), { ...options, filepath: OUT }),
);
console.log(
	`crate-notices: ${OUT}: ${Object.keys(crates).length} crates, ${Object.keys(texts).length} texts`,
);
