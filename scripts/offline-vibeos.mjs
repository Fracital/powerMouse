// vibeOS in offline.html (scripts/build-offline.mjs): the desktop dist/vibeos/
// holds (scripts/vibeos.mjs), packed into one gzipped archive the file keeps
// as base64 in an element no script reads until the page's first switch to
// vibeOS (demo/offline/vibeos.mjs unpacks it then). It carries embed.js,
// embed.css and only the files they name: the Tango icons, cursors, fonts,
// wallpapers and bookmark icons the desktop's code and stylesheet name, and
// each game vibeOS opens with the files its page, styles and scripts name.
// No emulator (vibeOS fetches v86 through the proxy when it opens, as on the
// served demo), no source maps, and none of the legacy formats Chrome never
// loads (a game's .eot and SVG fonts, its Flash files, iOS's home screen
// images).
//
// The page makes a blob: URL of each file, and the desktop asks for them by
// path (BrowserHost.assets). The stylesheet's `url(./…)` of a carried file
// is a placeholder, `@@pm-vibeos:<n>@@` (the n-th file of the archive, which
// comes before it), that the page replaces with that file's URL. A game's
// page is one text: a document at a blob: URL may load none of the page's
// other blob: URLs (Chrome: "Not allowed to load local resource"), so each
// file its page, styles and scripts name is a data: URL in it, written
// here. A name left as it was resolves against no blob: URL, so it is never
// asked of anything; a reference to a file the archive leaves out is
// `data:,`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';

export const VIBEOS_ARCHIVE_ID = 'pm-vibeos';

/** what offline.html leaves out of vibeOS though its code names it, and why */
export const VIBEOS_LEFT_OUT = new Map([
	[
		'tango/wallpapers/GardenTilesCT.png',
		'a 4 MB wallpaper, more than the rest of the desktop together (its tile in the Wallpaper Picker is empty)',
	],
]);
/** what a game names that Chrome never loads: legacy formats, iOS's home screen images */
const NEVER_LOADED = /\.(eot|swf|zip)$|-webfont\.svg$|\/apple-touch-[^/]*$/;

const TYPES = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.html': 'text/html',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.cur': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg',
	'.md': 'text/markdown',
};
const TEXT = new Set(['.js', '.css', '.html']);
const PLACEHOLDER = (index) => `@@pm-vibeos:${index}@@`;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function filesOf(dir) {
	const all = [];
	const walk = (path) => {
		for (const entry of readdirSync(join(dir, path), { withFileTypes: true })) {
			const name = path ? `${path}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(name);
			else if (!name.endsWith('.map')) all.push(name);
		}
	};
	walk('');
	return all;
}

/**
 * The files the desktop's own code and stylesheet name: a root-relative path
 * (`assetUrl('/tango/…')`, the stylesheet's `url(./tango/…)`), a Tango icon
 * by its name under tango/ (`iconUrl('apps/24/bash.png')`), a bookmark's
 * icon by its file name (`icon('vibeos.png')`)
 */
function namedByDesktop(text, path) {
	if (text.includes(`/${path}`)) return true;
	const quoted = (name) =>
		text.includes(`'${name}'`) ||
		text.includes(`"${name}"`) ||
		text.includes(`\`${name}`);
	if (path.startsWith('tango/') && quoted(path.slice('tango/'.length)))
		return true;
	return (
		path.startsWith('stomp-bookmarks/icons/') &&
		quoted(path.slice('stomp-bookmarks/icons/'.length))
	);
}

/**
 * The archive (base64 of the gzip) and what it carries, or null when the
 * build has no vibeOS. `dist` is dist/.
 */
export function offlineVibeOS(dist) {
	const dir = join(dist, 'vibeos');
	if (!existsSync(join(dir, 'embed.js'))) return null;
	const all = filesOf(dir).filter((path) => TYPES[extname(path)]);
	const carried = new Set(
		all.filter(
			(path) => !VIBEOS_LEFT_OUT.has(path) && !NEVER_LOADED.test(path),
		),
	);
	const read = (path) => readFileSync(join(dir, path));
	const desktop = `${read('embed.js')}\n${read('embed.css')}`;
	const games = all
		.filter((path) => /^appfiles\/[^/]+\/index\.html$/.test(path))
		.filter((path) => desktop.includes(`/${path}`));

	// a carried file a text file names, as it names it: relative to its own
	// directory, or from the root of vibeOS's files (`/appfiles/…`), between
	// quotes, parentheses or spaces, before a query or fragment
	const namedIn = (from, text) => {
		const names = [];
		for (const path of all) {
			if (path === from) continue;
			const relative = posix.relative(posix.dirname(from), path);
			for (const spelled of new Set([relative, `/${path}`, `./${relative}`])) {
				const pattern = new RegExp(
					`(?<=^|["'(=\\s])${escaped(spelled)}(?=$|["')?#\\s])`,
					'g',
				);
				if (pattern.test(text)) names.push([pattern, path]);
			}
		}
		return names;
	};

	const entries = [];
	const indexOf = new Map();
	const add = (path, bytes = read(path)) => {
		indexOf.set(path, entries.length);
		entries.push([path, TYPES[extname(path)], bytes]);
	};
	// a game's page and everything it names, in one text: each file it, its
	// styles and its scripts name is a data: URL in it (a blob: URL of this
	// page's is not a resource its document may load, data: is)
	const inlined = new Map();
	const visiting = new Set();
	const withData = (path) => {
		let source = read(path).toString('utf8');
		for (const [pattern, target] of namedIn(path, source))
			source = source.replace(pattern, dataOf(target) ?? 'data:,');
		return Buffer.from(source);
	};
	const dataOf = (path) => {
		if (inlined.has(path)) return inlined.get(path);
		if (!carried.has(path) || visiting.has(path)) return null;
		visiting.add(path);
		const bytes = TEXT.has(extname(path)) ? withData(path) : read(path);
		visiting.delete(path);
		const url = `data:${TYPES[extname(path)]};base64,${bytes.toString('base64')}`;
		inlined.set(path, url);
		return url;
	};
	for (const path of all) {
		if (
			path.startsWith('appfiles/') ||
			path === 'embed.js' ||
			path === 'embed.css'
		)
			continue;
		if (carried.has(path) && namedByDesktop(desktop, path)) add(path);
	}
	for (const game of games) add(game, withData(game));
	// the module, as it is but for its source map; the stylesheet, its
	// `url(./…)` names the files' placeholders
	const strip = (text) =>
		text.replace(/\n?\/[/*]# sourceMappingURL=\S+(?: \*\/)?\s*$/, '\n');
	add('embed.js', Buffer.from(strip(read('embed.js').toString('utf8'))));
	const sheet = strip(read('embed.css').toString('utf8')).replace(
		/url\(\s*(['"]?)\.\/([^'")?#]+)([^'")]*)\1\s*\)/g,
		(whole, quote, path) =>
			indexOf.has(path)
				? `url(${PLACEHOLDER(indexOf.get(path))})`
				: whole.startsWith('url(data:')
					? whole
					: 'url(data:,)',
	);
	add('embed.css', Buffer.from(sheet));

	const header = Buffer.from(
		JSON.stringify(
			entries.map(([path, type, bytes]) => [
				path,
				type,
				bytes.length,
				path === 'embed.css',
			]),
		),
	);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(header.length);
	const plain = Buffer.concat([
		length,
		header,
		...entries.map(([, , bytes]) => bytes),
	]);
	const packed = gzipSync(plain, { level: 9 });
	return {
		base64: packed.toString('base64'),
		files: entries.length,
		raw: plain.length,
		packed: packed.length,
		commit: JSON.parse(readFileSync(join(dir, 'vibeos.json'), 'utf8')).commit,
		notices: vibeosNotices(
			dir,
			entries.map(([path]) => path),
		),
	};
}

/** the licences of what the archive carries, as offline.html's notices write a section */
function vibeosNotices(dir, carried) {
	const text = (path) => readFileSync(join(dir, path), 'utf8').trim();
	const has = (prefix) => carried.some((path) => path.startsWith(prefix));
	const parts = [
		`vibeOS (https://github.com/Fracital/vibeOS), the desktop in this file
(embed.js, embed.css and its files), under its BSD 3-Clause licence:`,
		text('LICENSE.md'),
	];
	for (const name of readdirSync(join(dir, 'licenses')).sort())
		parts.push(
			`${name.replace(/\.txt$/, '')}, in vibeOS's embed.js:\n\n${text(`licenses/${name}`)}`,
		);
	for (const font of ['open-sans', 'inconsolata'])
		if (has(`fonts/${font}/`))
			parts.push(
				`The ${font === 'open-sans' ? 'Open Sans' : 'Inconsolata'} font (SIL Open Font License 1.1):\n\n${text(`fonts/${font}/OFL.txt`)}`,
			);
	parts.push(
		"vibeOS's icons, cursors and wallpapers under tango/ are from the Tango Desktop Project (http://tango.freedesktop.org/), in the public domain.",
	);
	if (has('appfiles/breakout/'))
		parts.push(
			`Breakout (appfiles/breakout/):\n\n${text('appfiles/breakout/LICENSE')}`,
		);
	if (has('appfiles/breakout/sound/'))
		parts.push(
			`SoundManager 2, in Breakout:\n\n${text('appfiles/breakout/sound/license.txt')}`,
		);
	if (has('appfiles/2048/'))
		parts.push(
			"2048 (appfiles/2048/) is by Gabriele Cirulli, under the MIT License, https://github.com/gabrielecirulli/2048; its Clear Sans font is Intel's, under the Apache License 2.0.",
		);
	if (has('appfiles/tetris/'))
		parts.push(
			'Tetris (appfiles/tetris/) is javascript-tetris by Jake Gordon, under the MIT License, https://github.com/jakesgordon/javascript-tetris.',
		);
	return parts.join('\n\n');
}
