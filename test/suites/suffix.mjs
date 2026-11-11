// The suffix lookup (rust/suffix, a member of core.wasm): "what is this
// host's site" answered from a table of the public suffix list in wasm
// instead of tldts in a bundle (docs/rust-plan.md, phase 2). In node, no
// browser:
//
// - the member's boundary: what each flag answers, the statuses, the pin
//   it names, what a lookup costs the instance;
// - the glue every thread calls it through (src/wasm/suffix.ts): no answer
//   without the module, tldts's answer with it, the same answer again;
// - parity with tldts (rust/host/suffix.mjs, with a smaller fuzz than a
//   run by hand): every rule of the pinned list, the hosts in the test
//   data, IDN and IP and malformed forms, generated inputs, and the pinned
//   list against the table of the tldts the lockfile pins. A tldts update
//   that knows a rule the list does not fails here until the pin in
//   rust/suffix/src/pins.env is raised.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP suffix: esbuild is not installed');
	process.exit(0);
}
const tldts = await import('tldts');

const root = fileURLToPath(new URL('../../', import.meta.url));

mkdirSync(OUT, { recursive: true });
const entry = `${OUT}suffix-entry.mjs`;
writeFileSync(
	entry,
	`export { compileModule, CoreInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n` +
		`export * as thread from ${JSON.stringify(`${root}src/wasm/thread.ts`)};\n` +
		`export * as suffix from ${JSON.stringify(`${root}src/wasm/suffix.ts`)};\n` +
		`export * as site from ${JSON.stringify(`${root}src/suffix.ts`)};\n`,
);
const bundle = `${OUT}suffix.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	mainFields: ['module', 'main'],
	target: 'es2022',
	outfile: bundle,
	logLevel: 'silent',
});
const { compileModule, CoreInstance, thread, suffix, site } = await import(
	bundle
);

const bytes = readFileSync(`${root}dist/core.wasm`);
const module = await compileModule(bytes);
const core = new CoreInstance(module);
const fresh = core.memoryBytes;
const instance = core.members.suffix;
const answer = (text, flags) => {
	const result = instance.call(text, flags);
	return 'output' in result ? result.output : `status ${result.status}`;
};

// the boundary (rust/suffix/src/lib.rs, rust/core-module/src/suffixes.rs)
ok(
	'the registrable domain is where it stands in the input',
	answer('www.example.co.uk', 0) === '4 17',
	answer('www.example.co.uk', 0),
);
ok(
	'flag 1 answers the public suffix',
	answer('www.example.co.uk', 1) === '12 17',
	answer('www.example.co.uk', 1),
);
ok(
	'flag 2 takes the private section in',
	answer('a.b.github.io', 0) === '4 13' &&
		answer('a.b.github.io', 2) === '2 13' &&
		answer('a.b.github.io', 1) === '11 13' &&
		answer('a.b.github.io', 3) === '4 13',
	[0, 2, 1, 3].map((flags) => answer('a.b.github.io', flags)).join(' / '),
);
ok(
	'no answer is empty: an address, a host that is its own suffix, no host',
	answer('127.0.0.1', 2) === '' &&
		answer('[::1]', 3) === '' &&
		answer('co.uk', 2) === '' &&
		answer('mailto:someone', 3) === '',
);
ok(
	'offsets are UTF-16 code units',
	answer('a.\u{1F600}.example.com', 0) === '5 16',
	answer('a.\u{1F600}.example.com', 0),
);
ok(
	'an ASCII host with upper case is the slice, to be lower-cased',
	answer('https://WWW.Example.COM/', 0) === '12 23 1',
	answer('https://WWW.Example.COM/', 0),
);
ok(
	'a host whose lower case is not ASCII comes back to be lower-cased and asked again',
	answer('Ä.Example.com', 0) === '0 13 3' &&
		answer('x@Ä.Example.com', 0) === '2 15 2' &&
		answer('ä.example.com', 4 | 8) === '2 13',
	`${answer('Ä.Example.com', 0)} / ${answer('x@Ä.Example.com', 0)} / ${answer('ä.example.com', 12)}`,
);
ok(
	'a tab in the input is the caller to drop',
	answer('exa\tmple.com', 0) === '0 0 4',
	answer('exa\tmple.com', 0),
);
ok(
	'a flag the build does not know is status 6',
	answer('example.com', 32) === 'status 6',
	answer('example.com', 32),
);
const pins = readFileSync(`${root}rust/suffix/src/pins.env`, 'utf8');
const pinned = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(pins)?.[1];
ok(
	'flag 16 names the list the table was built from',
	answer('', 16) === `${pinned('PSL_COMMIT')} ${pinned('PSL_DATE')}`,
	answer('', 16),
);

// what it costs the instance: its buffers are kept from call to call, and
// those of an input past 64 KiB are given back after it (the artifact's
// budget is the wasm-artifact suite's)
instance.call(`https://${'a.'.repeat(100)}example.com/`, 0);
instance.call(`https://${'a.'.repeat(100_000)}example.com/`, 0);
instance.call('www.example.co.uk', 0);
ok(
	'lookups, a long one among them, grow the memory by a few pages at most',
	core.memoryBytes - fresh <= 16 * 65536,
	`${fresh} -> ${core.memoryBytes}`,
);

// the glue (src/wasm/suffix.ts) and the choice between it and tldts
// (src/suffix.ts)
ok(
	'a thread without the module has no answer of its own, and tldts answers',
	suffix.domainOf('www.example.co.uk', false) === undefined &&
		suffix.publicSuffixOf('www.example.co.uk', true) === undefined &&
		suffix.suffixListPin() === null &&
		site.getDomain('www.example.co.uk') === 'example.co.uk' &&
		site.getPublicSuffix('a.b.github.io', true) === 'github.io',
);
thread.adoptModule('core', module);
ok(
	"with the module the answer is the module's, a string or null",
	suffix.domainOf('www.example.co.uk', false) === 'example.co.uk' &&
		suffix.domainOf('a.b.github.io', true) === 'b.github.io' &&
		suffix.publicSuffixOf('a.b.github.io', true) === 'github.io' &&
		suffix.publicSuffixOf('a.b.github.io', false) === 'io' &&
		suffix.domainOf('127.0.0.1', false) === null &&
		suffix.publicSuffixOf('[::1]', true) === null,
);
const samples = [
	'WWW.Example.CO.UK',
	'https://user@a.b.Example.com:8443/path',
	'Ä.Example.com',
	'ex\tample.\ncom',
	'a.個人.香港',
	'a.xn--gmqw5a.香港',
	'.ck',
	'localhost',
	'',
];
const apart = samples.filter(
	(input) =>
		suffix.domainOf(input, true) !==
			tldts.getDomain(input, { allowPrivateDomains: true }) ||
		suffix.domainOf(input, false) !== tldts.getDomain(input) ||
		suffix.publicSuffixOf(input, true) !==
			tldts.getPublicSuffix(input, { allowPrivateDomains: true }) ||
		// the answer kept from the first call is the same answer
		suffix.domainOf(input, true) !==
			tldts.getDomain(input, { allowPrivateDomains: true }),
);
ok(
	"what the glue finishes itself (lower case, dropped tabs) is tldts's answer",
	apart.length === 0,
	JSON.stringify(apart),
);
ok(
	'the choice asks the module when the thread holds it',
	site.getDomain('www.example.co.uk') === 'example.co.uk' &&
		site.getDomain('a.b.github.io', true) === 'b.github.io' &&
		site.getPublicSuffix('a.b.github.io', true) === 'github.io' &&
		site.getPublicSuffix('a.b.github.io') === 'io',
);
ok(
	'the thread names the list its module holds',
	suffix.suffixListPin()?.commit === pinned('PSL_COMMIT') &&
		suffix.suffixListPin()?.date === pinned('PSL_DATE'),
	JSON.stringify(suffix.suffixListPin()),
);

// parity with tldts, the harness's own run
const harness = spawnSync(process.execPath, [`${root}rust/host/suffix.mjs`], {
	env: {
		...process.env,
		FUZZ: process.env.FUZZ ?? '100000',
		CORE_WASM: `${root}dist/core.wasm`,
	},
	encoding: 'utf8',
	maxBuffer: 16 * 1024 * 1024,
});
const lines = (harness.stdout ?? '').trim().split('\n');
for (const line of lines) console.log(`  ${line}`);
const total = /^(\d+) comparisons, (\d+) differences/m.exec(
	harness.stdout ?? '',
);
ok(
	'the module answers as tldts does over the rules, the hosts on disk, the forms and the fuzz',
	harness.status === 0 &&
		total !== null &&
		Number(total[1]) > 500_000 &&
		total[2] === '0',
	total ? total[0] : `exit ${harness.status} ${harness.stderr ?? ''}`,
);
ok(
	'the pinned list is the list of the tldts the lockfile pins',
	/, 0 only tldts has, 0 only the list has/.test(harness.stdout ?? ''),
);

await done();
