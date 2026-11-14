// The service worker's per-site shields store (src/server/shields.ts), in
// node: what a host with no entry is governed by, with and without the '*'
// global default the demo pushes ("goodies on by default"), and the
// block-scripts and fingerprint getters the shell reads before it builds a
// document. Skips when esbuild is not installed, as the other unit suites do.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP shields-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}shields-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { ShieldsStore } from ${JSON.stringify(`${root}src/server/shields.ts`)};`,
);
const bundle = `${OUT}shields-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { ShieldsStore } = await import(`${bundle}?${Date.now()}`);

// the "goodies on by default" the demo pushes under '*' (DEFAULT_SHIELDS)
const GOODIES = {
	host: '*',
	enabled: true,
	mode: 'standard',
	httpsUpgrade: 'upgrade',
	blockScripts: false,
	blockFingerprinting: true,
	cookies: 'third-party',
	forget: false,
};

// --- a no-entry host with no '*' default is neutral (every suite's own
// controller, and the demo opted out of defaults) -------------------------
{
	const shields = new ShieldsStore();
	shields.set([]);
	ok(
		'neutral host: the blocker runs, no HTTPS upgrade, cookies allowed',
		shields.blocks('example.com') === true &&
			shields.httpsUpgrade('example.com') === false &&
			shields.cookies('example.com') === 'allow',
		`${shields.blocks('example.com')} ${shields.httpsUpgrade('example.com')} ${shields.cookies('example.com')}`,
	);
	ok(
		'neutral host: fingerprint emulation on, scripts not blocked',
		shields.fingerprint('example.com') === true &&
			shields.blockScripts('example.com') === false,
		`${shields.fingerprint('example.com')} ${shields.blockScripts('example.com')}`,
	);
}

// --- the '*' default governs every no-entry host (global default on) -------
{
	const shields = new ShieldsStore();
	shields.set([GOODIES]);
	ok(
		'global default on: a no-entry host upgrades to HTTPS and blocks third-party cookies',
		shields.httpsUpgrade('example.com') === true &&
			shields.cookies('example.com') === 'third-party' &&
			shields.blocks('example.com') === true,
		`${shields.httpsUpgrade('example.com')} ${shields.cookies('example.com')} ${shields.blocks('example.com')}`,
	);
	ok(
		'global default on: fingerprint stays on, scripts stay unblocked (destructive, never a default)',
		shields.fingerprint('example.com') === true &&
			shields.blockScripts('example.com') === false,
		`${shields.fingerprint('example.com')} ${shields.blockScripts('example.com')}`,
	);
	ok(
		"the '*' entry is the default, not a host keyed '*'",
		shields.get('*')?.host === '*' && shields.get('other.test') !== undefined,
		JSON.stringify(shields.get('other.test')),
	);
}

// --- a host's own entry overrides the default ------------------------------
{
	const shields = new ShieldsStore();
	shields.set([
		GOODIES,
		{
			host: 'nofp.test',
			enabled: true,
			mode: 'standard',
			httpsUpgrade: 'off',
			blockFingerprinting: false,
			blockScripts: true,
			cookies: 'allow',
		},
	]);
	ok(
		'a host entry overrides the default: no upgrade, cookies allowed',
		shields.httpsUpgrade('nofp.test') === false &&
			shields.cookies('nofp.test') === 'allow',
		`${shields.httpsUpgrade('nofp.test')} ${shields.cookies('nofp.test')}`,
	);
	ok(
		'block fingerprinting off for the host: emulation off (native values)',
		shields.fingerprint('nofp.test') === false,
		String(shields.fingerprint('nofp.test')),
	);
	ok(
		'block scripts on for the host: the page-code script-src enforcement runs',
		shields.blockScripts('nofp.test') === true,
		String(shields.blockScripts('nofp.test')),
	);
	// another host with no entry still gets the default
	ok(
		'the override does not touch other hosts',
		shields.fingerprint('other.test') === true &&
			shields.httpsUpgrade('other.test') === true,
		`${shields.fingerprint('other.test')} ${shields.httpsUpgrade('other.test')}`,
	);
}

// --- the master toggle (shields down) turns every layer off ----------------
{
	const shields = new ShieldsStore();
	shields.set([
		GOODIES,
		{ host: 'down.test', enabled: false, mode: 'standard' },
	]);
	ok(
		'shields down: blocker off, no upgrade, cookies allowed, no script block',
		shields.blocks('down.test') === false &&
			shields.httpsUpgrade('down.test') === false &&
			shields.cookies('down.test') === 'allow' &&
			shields.blockScripts('down.test') === false,
		`${shields.blocks('down.test')} ${shields.httpsUpgrade('down.test')} ${shields.cookies('down.test')} ${shields.blockScripts('down.test')}`,
	);
	ok(
		'shields down: fingerprint emulation off too (the site reads native values)',
		shields.fingerprint('down.test') === false,
		String(shields.fingerprint('down.test')),
	);
}

done();
