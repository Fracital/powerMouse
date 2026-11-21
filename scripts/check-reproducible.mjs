// The build is reproducible: building the same tree again gives byte-identical
// files in dist/, and none of them names the checkout's own path (which would
// differ between a CI runner, a deploy's stage dir and a laptop). A file asked
// for by its hash (rewriterLib.js, core.wasm, the document bundles) then keeps
// its hash, and browsers keep it, until what it is built from changes.
//
// And the build id (build.js buildId) is what the bundles are built from: a
// change to the tests, docs, demo or CI files leaves every file in dist/ as
// it was, and a change among the inputs (src/) gives a new id, so the service
// worker's bytes change and browsers install it.
//
// Builds five times (`node build.js`, which empties dist/ first), with a
// probe file added and removed, and compares; dist/ ends as the tree builds
// it. offline.html (scripts/build-offline.mjs, the build's artifact beside
// dist/) is made twice from the same dist/ and compared too, and has to name
// no checkout path either. Exit code 1 lists every problem.
//   node scripts/check-reproducible.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';

const DIST = 'dist';

/** every file under dist/, by its path, the SHA-256 of its bytes */
function hashes() {
	const found = new Map();
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const path = `${dir}/${name}`;
			if (statSync(path).isDirectory()) walk(path);
			else
				found.set(
					path,
					createHash('sha256').update(readFileSync(path)).digest('hex'),
				);
		}
	};
	walk(DIST);
	return found;
}

const build = () =>
	execFileSync(process.execPath, ['build.js'], { stdio: 'inherit' });

const BUILD_ID = /"\d+\.\d+\.\d+[^"+]*\+[0-9a-z]+"/;
const buildIdOf = () =>
	readFileSync(`${DIST}/serviceWorker.js`, 'utf8').match(BUILD_ID)?.[0];

const problems = [];
/** the paths whose file differs between two builds' hashes */
const differing = (a, b) =>
	[...new Set([...a.keys(), ...b.keys()])].filter(
		(path) => a.get(path) !== b.get(path),
	);
/** build with a probe file at each of `paths`, then remove them */
function buildWithProbes(paths) {
	try {
		for (const path of paths) writeFileSync(path, 'check-reproducible probe\n');
		build();
		return hashes();
	} finally {
		for (const path of paths) rmSync(path, { force: true });
	}
}

build();
const first = hashes();
const id = buildIdOf();
build();
const second = hashes();
for (const path of differing(first, second))
	problems.push(`${path}: differs between two builds of the same tree`);
const checkout = process.cwd();
for (const path of second.keys())
	if (readFileSync(path).includes(checkout))
		problems.push(`${path}: names the checkout's path (${checkout})`);
if (!id) problems.push(`${DIST}/serviceWorker.js: no build id found`);

const OFFLINE = 'build/offline.html';
const buildOffline = () => {
	execFileSync(process.execPath, ['scripts/build-offline.mjs'], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	return readFileSync(OFFLINE);
};
const offline = buildOffline();
if (!buildOffline().equals(offline))
	problems.push(`${OFFLINE}: differs between two builds of the same tree`);
if (offline.includes(checkout))
	problems.push(`${OFFLINE}: names the checkout's path (${checkout})`);

const outside = buildWithProbes([
	'test/.reproducible-probe',
	'docs/.reproducible-probe',
	'demo/.reproducible-probe',
	'.github/.reproducible-probe',
]);
for (const path of differing(first, outside))
	problems.push(
		`${path}: changes with a file of the tests, docs, demo or CI (not a build input)`,
	);
buildWithProbes(['src/.reproducible-probe']);
const changedId = buildIdOf();
if (!changedId || changedId === id)
	problems.push(
		`${DIST}/serviceWorker.js: the build id stays ${id} when a file of src/ is added`,
	);
build();
for (const path of differing(first, hashes()))
	problems.push(`${path}: differs after the probes are removed`);

if (problems.length) {
	console.error(`check-reproducible: ${problems.length} problem(s)`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(
	`check-reproducible: ${second.size} files, identical across builds and with a non-input changed; build id ${id}, ${changedId} with an input changed; ${OFFLINE} identical across builds`,
);
