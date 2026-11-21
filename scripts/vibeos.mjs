// vibeOS (Fracital/vibeOS), the desktop the demo can switch to, is a git
// submodule at vendor/vibeOS. Its desktop is built here into dist/vibeos/
// with its static files, since the server serves only what dist/ holds (the
// deploy copies dist/ and never has the submodule). Without the submodule
// (a clone without --recurse-submodules, CI) or without its one runtime
// dependency installed, nothing is built and the demo has no vibeOS switch:
// the server offers it only when dist/vibeos/embed.js is there.
import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

export const VIBEOS_SOURCE = 'vendor/vibeOS';
export const VIBEOS_OUT = 'dist/vibeos';
// where the server serves dist/vibeos/ (demo/server.js)
const BASE = '/vibeos/';

// vibeOS's static files, as its own site serves them, under BASE
const STATIC = [
	['tango', 'tango'],
	['appfiles', 'appfiles'],
	['public/cursors', 'cursors'],
	['public/icons', 'icons'],
	['public/stomp-bookmarks', 'stomp-bookmarks'],
	['public/licenses', 'licenses'],
	['scripts/v86', 'scripts/v86'],
	['scripts/net', 'scripts/net'],
	['LICENSE.md', 'LICENSE.md'],
];

const say = (text) => console.log(`vibeOS: ${text}`);

/**
 * vibeOS's stylesheets name its files from its site's root (`url('/tango/…')`):
 * here they are under BASE. Its web font is left out: the host page loads
 * nothing from another site.
 */
const rebased = {
	name: 'vibeos-rebase',
	setup(builder) {
		builder.onLoad({ filter: /\.css$/ }, async ({ path }) => {
			const text = (await readFile(path, 'utf8'))
				.replace(/@import\s+url\(\s*['"]?https?:[^)]*\)\s*;/g, '')
				.replace(/url\(\s*(['"]?)\/(?!\/)/g, `url($1${BASE}`);
			return { contents: text, loader: 'css' };
		});
	},
};

function commitOf(dir) {
	try {
		return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

/** build dist/vibeos/, or say why the demo goes without it; never fails the build */
export async function buildVibeOS() {
	const entry = `${VIBEOS_SOURCE}/src/dom/embed.ts`;
	if (!existsSync(entry)) {
		say(
			`${VIBEOS_SOURCE} is not checked out (git submodule update --init), the demo is built without the vibeOS switch`,
		);
		return false;
	}
	if (!existsSync(`${VIBEOS_SOURCE}/node_modules/chrome-tabs/package.json`)) {
		say(
			`its dependencies are not installed (npm ci --prefix ${VIBEOS_SOURCE} --omit=dev --ignore-scripts), the demo is built without the vibeOS switch`,
		);
		return false;
	}
	try {
		await mkdir(VIBEOS_OUT, { recursive: true });
		await build({
			entryPoints: { embed: entry },
			bundle: true,
			format: 'esm',
			target: 'es2022',
			minify: true,
			sourcemap: true,
			outdir: VIBEOS_OUT,
			define: { __VIBEOS_BASE__: JSON.stringify(BASE) },
			// its tsconfig names astro's, which only its own build installs
			tsconfigRaw: {},
			external: [`${BASE}*`],
			plugins: [rebased],
			logLevel: 'warning',
		});
		// copy-on-write where the file system has it: the files are some 55 MB
		for (const [from, to] of STATIC)
			await cp(`${VIBEOS_SOURCE}/${from}`, `${VIBEOS_OUT}/${to}`, {
				recursive: true,
				dereference: true,
				mode: constants.COPYFILE_FICLONE,
			});
		const commit = commitOf(VIBEOS_SOURCE);
		await writeFile(
			`${VIBEOS_OUT}/vibeos.json`,
			`${JSON.stringify({ commit }, null, '\t')}\n`,
		);
		say(`built ${VIBEOS_OUT}/ from ${commit ?? 'an unknown commit'}`);
		return true;
	} catch (error) {
		// no half of it: the server offers the switch when embed.js is there
		await rm(VIBEOS_OUT, { recursive: true, force: true });
		say(
			`build failed, the demo is built without the vibeOS switch: ${error.message}`,
		);
		return false;
	}
}
