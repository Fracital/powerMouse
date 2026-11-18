// Build assets/adblock-resources.json, the built-in blocker's scriptlets and
// redirect resources (docs/adblock.md), from a checkout of uBlock Origin
// (GPL-3.0, https://github.com/gorhill/uBlock) at a release tag:
//
//   git clone --depth 1 --branch <tag> https://github.com/gorhill/uBlock.git <dir>
//   node scripts/adblock-resources.mjs <dir>
//
// The output is Brave's resources.json format, which the adblock crate reads,
// built the way Brave builds the file it ships (brave-core-crx-packager,
// lib/adBlockRustUtils.js): every scriptlet uBO registers, as the source of
// its function with the names of the functions it calls, and every redirect
// resource uBO's redirect-resources.js names, read from
// web_accessible_resources with a type from its extension, as the crate's
// own assembler reads them (resources/resource_assembler.rs). The same
// checkout always gives the same bytes. assets/adblock-resources.UPSTREAM
// records the tag and commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node scripts/adblock-resources.mjs <uBlock checkout>');
	process.exit(1);
}
const root = resolve(dir);
const out = new URL('../assets/', import.meta.url);

const { builtinScriptlets } = await import(
	pathToFileURL(`${root}/src/js/resources/scriptlets.js`).href
);
const { default: redirects } = await import(
	pathToFileURL(`${root}/src/js/redirect-resources.js`).href
);

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
/** the crate's MimeType::from_extension */
const MIME = {
	css: 'text/css',
	gif: 'image/gif',
	html: 'text/html',
	js: 'application/javascript',
	json: 'application/json',
	mp3: 'audio/mp3',
	mp4: 'video/mp4',
	png: 'image/png',
	txt: 'text/plain',
	xml: 'text/xml',
};
const TEXTUAL = new Set(['application/javascript', 'text/html', 'text/plain']);

const resources = [];
for (const [name, details] of redirects) {
	// an entry with parameters is a scriptlet of uBO's redirect engine, which
	// the crate's assembler leaves out too
	if (details.params) continue;
	const mime = MIME[/\.([^.]+)$/.exec(name)?.[1]] ?? 'application/octet-stream';
	let bytes = readFileSync(`${root}/src/web_accessible_resources/${name}`);
	if (TEXTUAL.has(mime)) bytes = bytes.toString('utf8').replaceAll('\r', '');
	const alias = details.alias ?? [];
	resources.push({
		name,
		aliases: Array.isArray(alias) ? alias : [alias],
		kind: { mime },
		content: base64(bytes),
	});
}

const names = new Set(builtinScriptlets.map((entry) => entry.name));
for (const entry of builtinScriptlets) {
	for (const dependency of entry.dependencies ?? [])
		if (!names.has(dependency))
			throw new Error(
				`${entry.name} needs ${dependency}, which uBO does not register`,
			);
	resources.push({
		name: entry.name,
		aliases: entry.aliases ?? [],
		kind: { mime: 'application/javascript' },
		content: base64(entry.fn.toString()),
		dependencies: entry.dependencies ?? [],
		// bit 0: only a trusted list's rules may run it (FLAG_TRUSTED)
		...(entry.requiresTrust ? { permission: 1 } : {}),
	});
}

const git = (...args) =>
	execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
writeFileSync(
	new URL('adblock-resources.json', out),
	JSON.stringify(resources),
);
writeFileSync(
	new URL('adblock-resources.UPSTREAM', out),
	[
		'source https://github.com/gorhill/uBlock (GPL-3.0)',
		`tag ${git('describe', '--tags', '--exact-match')}`,
		`commit ${git('rev-parse', 'HEAD')}`,
		`scriptlets ${builtinScriptlets.length}`,
		`redirects ${resources.length - builtinScriptlets.length}`,
		'built by scripts/adblock-resources.mjs',
		'',
	].join('\n'),
);
console.log(
	`${resources.length} resources (${builtinScriptlets.length} scriptlets)`,
);
