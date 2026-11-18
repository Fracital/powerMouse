// The build is reproducible: building the same tree again gives byte-identical
// files in dist/, and none of them names the checkout's own path (which would
// differ between a CI runner, a deploy's stage dir and a laptop). A file asked
// for by its hash (rewriterLib.js, core.wasm, the document bundles) then keeps
// its hash, and browsers keep it, until what it is built from changes.
//
// Builds twice (`node build.js`, which empties dist/ first) and compares.
// Exit code 1 lists every file that differs or names the path.
//   node scripts/check-reproducible.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

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

build();
const first = hashes();
build();
const second = hashes();

const problems = [];
for (const path of new Set([...first.keys(), ...second.keys()]))
	if (first.get(path) !== second.get(path))
		problems.push(`${path}: differs between two builds of the same tree`);
const checkout = process.cwd();
for (const path of second.keys())
	if (readFileSync(path).includes(checkout))
		problems.push(`${path}: names the checkout's path (${checkout})`);

if (problems.length) {
	console.error(`check-reproducible: ${problems.length} problem(s)`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(
	`check-reproducible: ${second.size} files, identical across builds`,
);
