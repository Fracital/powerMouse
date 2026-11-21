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
 * once (the roots left out), as { name, version, source }. It is an upper
 * bound of what a wasm module is compiled from: the lockfile also resolves
 * build scripts' and proc macros' crates, the workspace's dev-dependencies
 * and other targets' dependencies.
 */
export function lockedPackages(file, roots) {
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
		.map(({ name, version, source }) => ({ name, version, source }));
}

/**
 * The Rust crates of the wasm modules the file carries, from
 * demo/offline/notices/crates.json (scripts/crate-notices.mjs): which
 * crates each module is compiled from, then each crate's licence and notice
 * files as its package ships them. A module built from a lockfile here must
 * resolve the same crates from it as when crates.json was written, and the
 * epoxy build's must be the installed epoxy transport's; the build fails
 * otherwise, until scripts/crate-notices.mjs is run again.
 */
function crateSections({ root, held, adblock, shared, section, problems }) {
	const data = JSON.parse(readFileSync(join(held, 'crates.json'), 'utf8'));
	const text = (hash) => data.texts[hash];
	const modules = data.modules.filter(
		(module) => adblock || !module.files.includes('/stomp/blocker.wasm'),
	);
	const again = 'run node scripts/crate-notices.mjs';
	for (const module of modules) {
		if (module.lock) {
			const now = lockedPackages(join(root, module.lock), [module.crate])
				.map((p) => `${p.name} ${p.version}`)
				.sort();
			const then = [
				...module.crates,
				...module.workspace,
				...module.notInModule,
			].sort();
			if (now.join('\n') !== then.join('\n'))
				problems.push(
					`${module.lock} resolves other crates for ${module.crate} than demo/offline/notices/crates.json lists: ${again}`,
				);
		} else {
			const installed = readFileSync(
				join(root, 'node_modules/@mercuryworkshop/epoxy-transport/UPSTREAM'),
				'utf8',
			);
			if (installed !== module.upstream)
				problems.push(
					`the installed epoxy transport is not the build demo/offline/notices/crates.json lists ${module.crate}'s crates of: ${again}`,
				);
		}
	}

	// the licence files of the source repositories of crates whose packages
	// ship none (demo/offline/notices/crates/: a `crates:` line naming them,
	// a `source:` line, then each file after `-- <name>`)
	const heldCrates = new Map();
	const heldDir = join(held, 'crates');
	for (const entry of readdirSync(heldDir).sort()) {
		const raw = readFileSync(join(heldDir, entry), 'utf8');
		const head = raw.slice(0, raw.indexOf('\n\n'));
		const names = /^crates: (.+)$/m.exec(head)?.[1].split(' ');
		const source = /^source: (.+)$/m.exec(head)?.[1];
		const files = raw
			.slice(head.length)
			.split(/^-- (.+)$/m)
			.slice(1);
		if (!names || !source || !files.length) {
			problems.push(
				`demo/offline/notices/crates/${entry}: no crates:, source: or file`,
			);
			continue;
		}
		const pairs = [];
		for (let i = 0; i < files.length; i += 2)
			pairs.push([files[i], files[i + 1].trim()]);
		for (const name of names) heldCrates.set(name, { source, files: pairs });
	}

	const used = [...new Set(modules.flatMap((module) => module.crates))].sort();
	const licence = (key) => data.crates[key].license ?? 'no licence named';
	const sections = [
		section(
			'The Rust crates in the wasm modules',
			`Each wasm module of this file is compiled from the Rust crates listed
under it, as cargo resolves them for wasm32-unknown-unknown (the crates its
code depends on, proc macros included; not those only a build script or a
test uses), with the licence each one's Cargo.toml names. The licence and
notice files each crate's package ships follow, one section a crate. The
modules also hold Rust's standard library, whose licences are at the end.`,
			...modules.map((module) =>
				[
					`${module.files.join(', ')} (the crate ${module.crate}${module.workspace.length ? `, with ${module.workspace.join(', ')} of the same workspace` : ''}):`,
					...module.crates.map((key) => `  ${key} (${licence(key)})`),
				].join('\n'),
			),
		),
	];
	for (const key of used) {
		const crate = data.crates[key];
		const files = Object.entries(crate.files);
		const body = [
			`${key} (${licence(key)}), from ${crate.source}${crate.repository ? `, ${crate.repository}` : ''}.${crate.authors ? `\nAuthors: ${crate.authors.join(', ')}.` : ''}`,
		];
		for (const [file, hash] of files)
			body.push(`-- ${file}\n\n${shared(text(hash), key)}`);
		if (!files.length) {
			const upstream = heldCrates.get(key.split(' ')[0]);
			if (!upstream)
				problems.push(
					`${key}: its package ships no licence file and none is held in demo/offline/notices/crates/`,
				);
			else {
				body.push(
					`Its package ships no licence file. These are its source's, ${upstream.source}:`,
				);
				for (const [file, held] of upstream.files)
					body.push(`-- ${file}\n\n${shared(held, key)}`);
			}
		}
		sections.push(section(key, ...body));
	}
	sections.push(
		section(
			"Rust's standard library",
			`Each wasm module holds parts of Rust's standard library, built by
${data.std.rustc}, which is licensed under the Apache License,
Version 2.0, or the MIT license, at your option, both below. Its
copyright notices, and those of the crates it is built from, are the
toolchain's share/doc/rust/COPYRIGHT-library.html (https://www.rust-lang.org/policies/licenses).`,
			...Object.entries(data.std.files).map(
				([file, hash]) => `-- ${file}\n\n${shared(text(hash), "Rust's")}`,
			),
		),
	);
	return sections;
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

	sections.push(
		...crateSections({ root, held, adblock, shared, section, problems }),
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
