// The licence notices offline.html carries (scripts/build-offline.mjs), as
// the comment that ends the file: STomp's own (GPL-3.0, with where its
// source is), then each bundled third-party part with its own notice.
//
// An npm package's notice is its licence file. Every package whose code is
// in a bundled dist/ file (read from that file's source map) is listed, as
// are the packages the file carries whole (the transports, the font), and
// the build fails when one of them has no licence file and no notice held
// for it in demo/offline/notices/. The parts no package ships a notice for
// (epoxy's, the Tango icons, the adblock engine and lists, the Powermouse
// style) have theirs held there. A licence text that two parts share is
// written once.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LICENCE_FILE = /^(licen[cs]e|copying|ofl)(\.(md|txt))?$/i;

/** the packages a bundle's source map names, by name */
function packagesOfMap(file) {
	const map = JSON.parse(readFileSync(file, 'utf8'));
	const sources = map.sources ?? map.sections.flatMap((s) => s.map.sources);
	const names = new Set();
	for (const source of sources) {
		const at = source.lastIndexOf('node_modules/');
		if (at === -1) continue;
		const parts = source.slice(at + 'node_modules/'.length).split('/');
		names.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
	}
	return names;
}

/**
 * The crates a Cargo.lock resolves for the packages named `roots`, each
 * once, as `name version` with where it comes from: a registry's crate, a
 * git one, or (no source) one of the workspace's own or a patched copy.
 * It is an upper bound of what a wasm module is compiled from: the
 * lockfile also resolves build scripts' and proc macros' crates, the
 * workspace's dev-dependencies and other targets' dependencies.
 */
function lockedCrates(file, roots) {
	const packages = readFileSync(file, 'utf8')
		.split(/^\[\[package\]\]$/m)
		.slice(1)
		.map((block) => {
			const field = (name) =>
				new RegExp(`^${name} = "([^"]*)"`, 'm').exec(block)?.[1];
			const list = /^dependencies = \[([^\]]*)\]/m.exec(block)?.[1] ?? '';
			return {
				name: field('name'),
				version: field('version'),
				source: field('source'),
				dependencies: [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
			};
		});
	const find = (entry) => {
		const [name, version] = entry.split(' ');
		const found = packages.filter(
			(p) => p.name === name && (!version || p.version === version),
		);
		if (found.length !== 1)
			throw new Error(`${file}: ${entry} names ${found.length} packages`);
		return found[0];
	};
	const seen = new Set();
	const walk = (entry) => {
		const found = find(entry);
		if (seen.has(found)) return;
		seen.add(found);
		for (const dependency of found.dependencies) walk(dependency);
	};
	for (const root of roots) walk(root);
	return [...seen]
		.filter((p) => !roots.includes(p.name))
		.map(
			(p) =>
				`  ${p.name} ${p.version}${
					!p.source
						? ' (a path crate: this source, or a patched copy of the crate)'
						: p.source.startsWith('registry+')
							? ''
							: ` (${p.source.replace(/#.*/, '')})`
				}`,
		)
		.sort();
}

/**
 * The notice block's text.
 * - `root`: the checkout; `dist`: its dist/
 * - `bundles`: the dist/ files the page carries that esbuild bundled (each
 *   has a source map)
 * - `whole`: packages carried as they are, as [name, what they are here]
 * - `commit`: the commit the file was built from (dist/build.json)
 * - `adblock`: whether the blocker and its lists are in
 */
export function offlineNotices({
	root,
	dist,
	bundles,
	whole,
	commit,
	adblock,
}) {
	const held = join(root, 'demo/offline/notices');
	const heldText = (name) => readFileSync(join(held, name), 'utf8').trim();
	const problems = [];
	const lock = JSON.parse(
		readFileSync(join(root, 'package-lock.json'), 'utf8'),
	);

	// each package, what of the file it is in
	const parts = new Map(whole.map(([name, what]) => [name, [what]]));
	for (const bundle of bundles) {
		const map = join(dist, `${bundle}.map`);
		if (!existsSync(map)) {
			problems.push(`${bundle}: no source map to read its packages from`);
			continue;
		}
		for (const name of packagesOfMap(map)) {
			if (!parts.has(name)) parts.set(name, []);
			parts.get(name).push(`/stomp/${bundle}`);
		}
	}

	const texts = new Map(); // licence text, the first part that gave it
	const shared = (text, owner) => {
		const key = text.replace(/\s+/g, ' ').trim();
		if (texts.has(key))
			return `(The text of this licence is ${texts.get(key)}'s, above.)`;
		texts.set(key, owner);
		return text.trim();
	};
	const section = (title, ...body) =>
		`==== ${title}\n\n${body.filter(Boolean).join('\n\n')}`;

	const sections = [];
	const own = readFileSync(join(root, 'LICENSE'), 'utf8');
	sections.push(
		section(
			'powerMouse and STomp (GPL-3.0-only)',
			`This file is powerMouse, the STomp web proxy's demo, with STomp's
bundles and wasm modules in it (dist/, the rust/ crates). It is licensed
under the GNU General Public License, version 3 only, whose text follows.
Its Corresponding Source is the commit it was built from,
  https://github.com/Fracital/powerMouse/tree/${commit}
and the source of each part named below. The file was made by
scripts/build-offline.mjs of that source.`,
			heldText('powermouse-style.txt'),
			shared(own, 'powerMouse'),
		),
	);

	for (const [name, what] of [...parts].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const dir = join(root, 'node_modules', name);
		if (!existsSync(join(dir, 'package.json'))) {
			problems.push(`${name}: not installed`);
			continue;
		}
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		const file = readdirSync(dir).find((entry) => LICENCE_FILE.test(entry));
		const heldName = `${name
			.replace(/^@/, '')
			.replace('/', '-')
			.replace(/^mercuryworkshop-/, '')}.txt`;
		const hasHeld = existsSync(join(held, heldName));
		if (!file && !hasHeld) {
			problems.push(
				`${name}: no licence file in the package and none held in demo/offline/notices/${heldName}`,
			);
			continue;
		}
		const pinned = lock.packages?.[`node_modules/${name}`]?.resolved;
		const commitOf = pinned?.match(/#([0-9a-f]{40})$/)?.[1];
		const body = [
			`${name} ${pkg.version}${pkg.license ? ` (${pkg.license})` : ''}, in this file as ${[...new Set(what)].join(', ')}.${commitOf ? `\nBuilt from commit ${commitOf}.` : ''}`,
		];
		if (hasHeld) body.push(heldText(heldName));
		if (file) body.push(shared(readFileSync(join(dir, file), 'utf8'), name));
		else if (/^AGPL-3\.0/.test(pkg.license ?? ''))
			body.push(shared(heldText('AGPL-3.0.txt'), name));
		// libcurl.js names the C libraries it is built from in its bundle
		if (name === '@mercuryworkshop/libcurl-transport') {
			const bundled = readFileSync(join(dir, 'dist/index.mjs'), 'utf8');
			const notice = /copyright_notice = `([^`]*)`/.exec(bundled)?.[1];
			if (!notice)
				problems.push(
					`${name}: its bundle no longer has libcurl.js's copyright_notice`,
				);
			else body.push(notice.trim());
		}
		sections.push(section(name, ...body));
	}

	// the Public Suffix List, in core.wasm (and tldts's copy, above)
	const psl = readFileSync(
		join(root, 'rust/suffix/src/public_suffix_list.dat'),
		'utf8',
	);
	const pslNotice = psl.slice(0, psl.indexOf('// ===BEGIN')).trim();
	if (!/Mozilla Public/.test(pslNotice))
		problems.push(
			'rust/suffix/src/public_suffix_list.dat: its licence header is gone',
		);
	sections.push(
		section(
			'The Public Suffix List (MPL-2.0), in /stomp/core.wasm',
			`${pslNotice}\n\nhttps://publicsuffix.org/`,
		),
	);

	// the Rust crates in the wasm modules, by name and version: their own
	// licence texts are not in this file yet (no copy of the crates is at
	// hand where it is built; cargo-about in deploy/rust's and deploy/epoxy's
	// containers would give them), so each is named, for its notice to be
	// found with it
	const crateList = (title, lock, roots, what) =>
		section(
			title,
			`${what} are compiled from these crates as ${lock} of
powerMouse's source resolves them (an upper bound: the crates of build
scripts, proc macros and other targets are listed too). Each is under the
licence its own Cargo.toml names, which this file does not yet carry the
text of; crates.io names it for each, at https://crates.io/crates/<name>.`,
			lockedCrates(join(root, lock), roots).join('\n'),
		);
	sections.push(
		crateList(
			"STomp's Rust crates",
			'rust/Cargo.lock',
			['core-module', 'codec', ...(adblock ? ['block'] : [])],
			`/stomp/core.wasm, /stomp/codec.wasm${adblock ? ' and /stomp/blocker.wasm' : ''} (this repository's rust/core-module, rust/codec${adblock ? ' and rust/block' : ''}, under STomp's licence above)`,
		),
		crateList(
			"stomp-h3's Rust crates",
			'deploy/epoxy/h3/Cargo.lock',
			['stomp-h3'],
			'/epoxy/h3/stomp_h3_bg.wasm (deploy/epoxy/h3, part of the epoxy transport named above)',
		),
	);

	if (adblock) {
		const upstream = (name) => readFileSync(join(root, 'assets', name), 'utf8');
		const lists = upstream('adblock-snapshot.UPSTREAM')
			.split('\n')
			.filter((line) => line.startsWith('list '))
			.map((line) => `  ${line.split(' ')[1]}`);
		const resources = upstream('adblock-resources.UPSTREAM');
		const source = /^source (.+)$/m.exec(resources)?.[1];
		const tag = /^tag (.+)$/m.exec(resources)?.[1];
		if (!lists.length || !source)
			problems.push(
				'assets/adblock-*.UPSTREAM: the lists or the resources source are not named',
			);
		sections.push(
			section(
				'The content blocker and its lists',
				`${heldText('adblock.txt')}\n${lists.join('\n')}`,
				`The scriptlets and redirect resources (/stomp/adblock-resources.json) are
uBlock Origin's${tag ? ` ${tag}` : ''}, ${source}.`,
			),
		);
	}

	sections.push(
		section('The Tango icons (public domain)', heldText('tango-icons.txt')),
	);

	if (problems.length)
		throw new Error(
			`offline.html's licence notices:\n${problems.map((p) => `  ${p}`).join('\n')}`,
		);
	const text = sections.join('\n\n');
	if (/--!?>/.test(text))
		throw new Error('a notice would end the comment it is in');
	return text;
}
