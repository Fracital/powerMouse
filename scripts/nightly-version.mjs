// The version a nightly build of HEAD publishes as: the next patch after
// package.json's version, a prerelease of the UTC time and the commit, e.g.
// 4.2.1-nightly.202611100717.g1a2b3c4 (sorts by time; the g keeps a sha of
// digits from reading as a number). Prints it; `--commit` prints the g tag.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const commit = `g${execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()}`;
if (process.argv.includes('--commit')) {
	console.log(commit);
	process.exit(0);
}
const { version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
const at = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
console.log(`${major}.${minor}.${patch + 1}-nightly.${at}.${commit}`);
