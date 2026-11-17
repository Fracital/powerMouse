// CHANGELOG fragments (changes/README.md): a change adds changes/<topic>.md
// instead of editing CHANGELOG.md, so two landings never conflict on it.
//
//   node scripts/changelog.mjs check
//       every fragment is well formed (run by `npm run check:prose`)
//   node scripts/changelog.mjs fold [--release <version>] [--dry-run]
//       (`npm run changelog -- ...`) moves every fragment's entries to the
//       top of its section in CHANGELOG.md's first release (the `## `
//       heading nearest the top), or in `## <version>`, which is made above
//       the others when there is none; then deletes the fragments. The
//       version is the caller's: the script never picks one. --dry-run
//       says what would move where and writes nothing.
//
// A fragment is one or more sections, each a `### <Section>` heading, a blank
// line, and a list of entries written as CHANGELOG.md's are (`- ` items,
// continuation lines indented, no blank lines inside the list). Entries of
// one section land newest fragment first (the commit that added it), as
// entries were added at the top of their section by hand.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = `${ROOT}changes/`;
const CHANGELOG = `${ROOT}CHANGELOG.md`;
// the sections a fragment may name, in the order a release lists them: a
// section the release does not have yet goes before the first one after it
const SECTIONS = [
	'Build',
	'Performance',
	'Transport',
	'Demo and API',
	'CI',
	'Deployment',
	'Dependencies',
	'Security',
	'Fidelity',
	'Fixes',
	'Origin isolation',
	'Docs',
	'Known limitations',
];
const NAME = /^[a-z0-9][a-z0-9-]*\.md$/;
const EM_DASH = String.fromCharCode(0x2014);

function fragmentFiles() {
	let names;
	try {
		names = readdirSync(DIR);
	} catch {
		return [];
	}
	return names.filter((n) => n !== 'README.md').sort();
}

// a fragment's sections, or the problems that keep it from being one
function parse(name) {
	const problems = [];
	if (!NAME.test(name))
		problems.push(
			'name it by topic in lower case: letters, digits and hyphens, ending .md',
		);
	let text;
	try {
		text = readFileSync(DIR + name, 'utf8');
	} catch (error) {
		return { problems: [`unreadable: ${error.message}`] };
	}
	const lines = text.replace(/\n+$/, '').split('\n');
	if (!text.endsWith('\n') && text !== '')
		problems.push('end the file with a newline');
	const sections = [];
	let current = null;
	lines.forEach((line, i) => {
		const at = `line ${i + 1}`;
		if (line.includes(EM_DASH)) problems.push(`${at}: em dash`);
		if (/\s$/.test(line)) problems.push(`${at}: trailing whitespace`);
		const heading = line.match(/^### (.+)$/);
		if (heading) {
			if (!SECTIONS.includes(heading[1]))
				problems.push(
					`${at}: unknown section "${heading[1]}" (one of: ${SECTIONS.join(', ')})`,
				);
			else if (sections.some((s) => s.section === heading[1]))
				problems.push(`${at}: section "${heading[1]}" twice`);
			if (current && current.lines.length === 0)
				problems.push(`${at}: the section above has no entries`);
			if (i > 0 && lines[i - 1] !== '')
				problems.push(`${at}: a blank line goes before a heading`);
			if (lines[i + 1] !== '')
				problems.push(`${at}: a blank line goes after a heading`);
			current = { section: heading[1], lines: [] };
			sections.push(current);
			return;
		}
		if (line.startsWith('#')) {
			problems.push(`${at}: only "### <Section>" headings`);
			return;
		}
		if (!current) {
			if (line !== '')
				problems.push(`${at}: start with a "### <Section>" heading`);
			return;
		}
		if (line === '') {
			// the blank after a heading, or the one before the next heading
			const next = lines[i + 1];
			if (
				current.lines.length > 0 &&
				next !== undefined &&
				!next.startsWith('### ')
			)
				problems.push(`${at}: no blank lines inside a section's list`);
			return;
		}
		if (current.lines.length === 0 && !line.startsWith('- '))
			problems.push(`${at}: a section's entries are "- " list items`);
		current.lines.push(line);
	});
	if (sections.length === 0) problems.push('no "### <Section>" heading');
	else if (current.lines.length === 0)
		problems.push('the last section has no entries');
	return { sections, problems };
}

function check() {
	const problems = [];
	for (const name of fragmentFiles())
		for (const p of parse(name).problems)
			problems.push(`changes/${name}: ${p}`);
	if (problems.length) {
		console.error(problems.join('\n'));
		console.error('(the format: changes/README.md)');
		process.exit(1);
	}
	console.log('changelog fragments ok');
}

// newest first: when the commit that added it was made (an uncommitted
// fragment is the newest of all)
function addedAt(name) {
	try {
		const out = execFileSync(
			'git',
			['log', '--diff-filter=A', '--format=%ct', '-1', '--', `changes/${name}`],
			{ cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		return out ? Number(out) : Infinity;
	} catch {
		return Infinity;
	}
}

function fold(args) {
	const dry = args.includes('--dry-run');
	const r = args.indexOf('--release');
	const release = r === -1 ? null : args[r + 1];
	if (
		r !== -1 &&
		(!release || release.startsWith('--') || /\s/.test(release))
	) {
		console.error(
			'usage: changelog.mjs fold [--release <version>] [--dry-run]',
		);
		process.exit(2);
	}
	const names = fragmentFiles();
	const fragments = names.map((name) => ({ name, ...parse(name) }));
	const bad = fragments.filter((f) => f.problems.length);
	if (bad.length) {
		for (const f of bad)
			for (const p of f.problems) console.error(`changes/${f.name}: ${p}`);
		process.exit(1);
	}
	if (fragments.length === 0) {
		console.log('no fragments in changes/');
		return;
	}
	for (const f of fragments) f.at = addedAt(f.name);
	fragments.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));

	const lines = readFileSync(CHANGELOG, 'utf8').split('\n');
	const releases = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
	let start = release
		? lines.findIndex((l) => l === `## ${release}`)
		: releases[0];
	if (start === undefined || start === -1) {
		if (!release) {
			console.error(
				'CHANGELOG.md has no "## " release heading; name one with --release',
			);
			process.exit(1);
		}
		// a new release, above the others (or at the end of a file with none)
		start = releases[0] ?? lines.length;
		lines.splice(start, 0, `## ${release}`, '');
		console.log(`new release heading: ## ${release}`);
	}
	const heading = lines[start];

	for (const section of SECTIONS) {
		const entries = fragments.flatMap((f) =>
			f.sections.filter((s) => s.section === section).map((s) => [f, s]),
		);
		if (entries.length === 0) continue;
		const add = entries.flatMap(([, s]) => s.lines);
		// the release's extent and its section headings, as they are now
		let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
		if (end === -1) end = lines.length;
		let at = lines.findIndex(
			(l, i) => i > start && i < end && l === `### ${section}`,
		);
		if (at !== -1) {
			// below the heading and its blank line, above the newest entry
			lines.splice(at + 2, 0, ...add);
		} else {
			const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1);
			at = lines.findIndex(
				(l, i) =>
					i > start && i < end && later.some((s) => l.startsWith(`### ${s}`)),
			);
			if (at === -1) {
				// at the release's end, after its last line of text
				at = end;
				while (at > start + 1 && lines[at - 1] === '') at--;
				lines.splice(at, 0, '', `### ${section}`, '', ...add);
			} else {
				lines.splice(at, 0, `### ${section}`, '', ...add, '');
			}
		}
		console.log(
			`${heading} / ${section}: ${entries.map(([f]) => f.name).join(', ')}`,
		);
	}
	if (dry) {
		console.log('(dry run: nothing written)');
		return;
	}
	writeFileSync(CHANGELOG, lines.join('\n'));
	for (const f of fragments) rmSync(DIR + f.name);
	console.log(
		`folded ${fragments.length} fragment(s) into CHANGELOG.md and deleted them; review with git diff, then commit`,
	);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'check') check();
else if (command === 'fold') fold(rest);
else {
	console.error(
		'usage: changelog.mjs check | fold [--release <version>] [--dry-run]',
	);
	process.exit(2);
}
