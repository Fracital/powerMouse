// The wasm artifacts dist/ ships (assets/, built by deploy/rust/build.sh),
// checked in node the way a host's build pipeline would check them before
// renaming and byte-substituting them (deploy/rust/check.mjs: no custom
// section, the declared imports and exports and nothing else, none of the
// tokens a canary scan refuses), and loaded through src/wasm/module.ts the
// way every realm loads them: compiled once, instantiated from the compiled
// module, strings in and out, the routing import answered by the host.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { inspect, problems, tokensIn } from '../../deploy/rust/check.mjs';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP wasm-artifact: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));

// every artifact dist/ carries is one assets/ built, with its abi.json
const crates = Object.fromEntries(
	readdirSync(`${root}rust`, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== 'target')
		.map((entry) => [entry.name, `${root}rust/${entry.name}/abi.json`]),
);
const artifacts = readdirSync(`${root}assets`).filter((name) =>
	name.endsWith('.wasm'),
);
ok('an artifact is shipped', artifacts.length > 0, artifacts.join(', '));

for (const name of artifacts) {
	const upstream = readFileSync(
		`${root}assets/${name.replace(/\.wasm$/, '.UPSTREAM')}`,
		'utf8',
	);
	const crate = /^crate rust\/(\S+)/m.exec(upstream)?.[1];
	ok(
		`${name} names its crate`,
		crate && crates[crate],
		upstream.split('\n')[0],
	);
	if (!crate || !crates[crate]) continue;
	const abi = JSON.parse(readFileSync(crates[crate], 'utf8'));
	const shipped = new Uint8Array(readFileSync(`${root}dist/${name}`));
	const committed = new Uint8Array(readFileSync(`${root}assets/${name}`));
	ok(
		`${name} in dist is the committed artifact`,
		Buffer.compare(shipped, committed) === 0,
		`${shipped.length} / ${committed.length} bytes`,
	);
	const found = problems(shipped, abi);
	ok(
		`${name} passes the artifact checks`,
		found.length === 0,
		found.join('; '),
	);
	const seen = inspect(shipped);
	ok(
		`${name} has no custom section`,
		seen.customs.length === 0,
		seen.customs.join(', '),
	);
	ok(`${name} carries no token`, tokensIn(shipped).length === 0);
}

// the checks refuse what they should: a module with a name section and a
// project token in its data, and an export the abi does not declare
{
	const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
	const section = (id, body) => bytes.push(id, body.length, ...body);
	// a memory, exported as "memory" plus an undeclared "x"
	section(5, [0x01, 0x00, 0x01]);
	const str = (text) => [text.length, ...Buffer.from(text)];
	section(7, [0x02, ...str('memory'), 0x02, 0x00, ...str('x'), 0x02, 0x00]);
	// an active data segment holding the token
	const data = Buffer.from('made by stomp');
	section(11, [0x01, 0x00, 0x41, 0x00, 0x0b, data.length, ...data]);
	// a custom "name" section
	section(0, [...str('name'), 0x00, 0x00]);
	const found = problems(new Uint8Array(bytes), {
		imports: [],
		exports: ['memory:memory'],
	});
	ok(
		'a module with a name section, a token and a stray export is refused',
		found.length === 3 &&
			found.some((p) => p.includes('custom sections: name')) &&
			found.some((p) => p.includes('stomp x1')) &&
			found.some((p) => p.includes('x:memory')),
		found.join('; '),
	);
}

// the loader, bundled from src so the suite runs what the bundles run
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}wasm-artifact-entry.mjs`;
writeFileSync(
	entry,
	`export { compileModule, CoreInstance, BufferInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n` +
		`export * as thread from ${JSON.stringify(`${root}src/wasm/thread.ts`)};\n`,
);
const bundle = `${OUT}wasm-artifact.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	outfile: bundle,
	logLevel: 'silent',
});
const { compileModule, CoreInstance, BufferInstance, thread } = await import(
	bundle
);

if (artifacts.includes('core.wasm')) {
	const bytes = readFileSync(`${root}dist/core.wasm`);
	// what it costs (the rewriter, the scanner and the suffix lookup in one;
	// the budget is the measurement and a margin, raised only by the change
	// that needs it). Raised from 640,000 / 230,000 when the core module
	// moved to the speed build (rust/core-module/rustflags -Copt-level=3 and
	// rust/core-module/speed: the standard library built without
	// optimize_for_size and wasm-opt -O2 over the workspace -Oz), which
	// rewrites about 40 percent faster for about 445,000 more bytes
	// (75,000 brotli). The module is opt-in (src/config.ts rewriter) and
	// fetched apart from the bundles, so this is a download of its own, not
	// part of the inject bundle a frame carries (frame-cost).
	const brotli = brotliCompressSync(bytes).length;
	ok(
		'the core is within its budget of 1,085,000 bytes, 302,000 brotli',
		bytes.length <= 1_085_000 && brotli <= 302_000,
		`${bytes.length} bytes, ${brotli} brotli`,
	);
	const module = await compileModule(bytes);
	ok('the core compiles from bytes', module instanceof WebAssembly.Module);
	const same = await compileModule(module);
	ok('a compiled module is taken as it is', same === module);

	const routed = [];
	const core = new CoreInstance(module, (member, kind, text) => {
		routed.push([member, kind, text]);
		return text === 'decline' ? null : `routed:${text}`;
	});
	const instance = core.members.rewriter;
	ok(
		'the core has a view of each member',
		instance instanceof BufferInstance &&
			core.members.scanner instanceof BufferInstance &&
			core.members.suffix instanceof BufferInstance,
	);
	let refused = false;
	try {
		instance.configure('{"names":{"access":"$s$j"}}');
	} catch (error) {
		refused = true;
	}
	ok('a configuration that is not lines of key and value is refused', refused);
	instance.configure('access\t$s$j\n');
	// (nothing in these is rewritten: every byte comes back where it was)
	const texts = [
		'',
		'a',
		'/* kept */ const x = 1n;  // kept too',
		// non-ASCII identifiers, a line separator, an astral character
		'über; straße; const s = "\u{1F600}' + 'x'.repeat(100000) + '";',
	];
	for (const text of texts) {
		const result = instance.call(text, 0);
		ok(
			`a ${text.length}-char input comes back as it went`,
			'output' in result && result.output === text,
			'output' in result ? '' : `status ${result.status}`,
		);
	}
	const read = instance.call('x = location.href; // why', 0);
	ok(
		'a read of location goes through the access API, the rest as it was',
		'output' in read &&
			read.output === 'x = $s$j.get(location, "location").href; // why',
		JSON.stringify(read),
	);
	instance.configure('access\t$a\n');
	const renamed = instance.call('x = top;', 0);
	instance.configure('access\t$s$j\n');
	ok(
		"the helper names are the configuration's",
		'output' in renamed && renamed.output === 'x = $a.get(top, "top");',
		JSON.stringify(renamed),
	);
	// what a rewrite depends on per script (flag 8), and what it found (16)
	instance.call('https://example.com/a.js\n\n\nPRE;', 8);
	const led = instance.call('"use strict"; function f() {}', 0);
	const meta = instance.call('', 16);
	ok(
		'the leading text follows the directive prologue, and the marks are counted',
		'output' in led &&
			/^"use strict";PRE; function\/\*[0-9a-z]+\.e\.f\*\/ f\(\) \{\}$/.test(
				led.output,
			) &&
			'output' in meta &&
			/^1\t[0-9a-z]+$/.test(meta.output),
		JSON.stringify([led, meta]),
	);
	// (32) the revision of what the module writes, which a kept rewrite is
	// of: the one rust/host/parity.mjs --cases recorded its outputs under
	const revision = instance.call('', 32);
	ok(
		'the module answers the revision its outputs were recorded under',
		'output' in revision &&
			revision.output ===
				readFileSync(`${root}rust/host/cases.revision`, 'utf8').split(' ')[0],
		JSON.stringify(revision),
	);
	const unled = instance.call('location', 0);
	ok(
		'the leading text holds for one script',
		'output' in unled && unled.output === '$s$j.get(location, "location")',
		JSON.stringify(unled),
	);
	// (64, 128) the parser alone: a classic script, and one of a single
	// expression statement (a javascript: URL's body)
	const asked = [
		['return 1', 64],
		['const = ;', 64],
		['a.b()', 128],
		['"use strict"', 128],
		['a; b', 128],
		['return 1', 128],
	].map(([text, flag]) => {
		const answered = instance.call(text, flag);
		return 'output' in answered ? answered.output : `status ${answered.status}`;
	});
	ok(
		'the module answers what parses as a script, and as one expression',
		asked.join() === '1,0,1,1,0,0',
		asked.join(),
	);
	// (7) a script no browser runs is told apart from one this parser
	// refuses: the host hands it back without asking the JavaScript rewriter
	const invalid = [
		'function f({ top: t }) { "use strict"; }',
		'%DebugPrint(top)',
	].map((text) => {
		const answered = instance.call(text, 0);
		return 'status' in answered ? answered.status : 'output';
	});
	ok(
		'a script no browser runs is answered as such',
		invalid.join() === '7,7',
		invalid.join(),
	);
	const broken = instance.call('const = ;', 0);
	ok(
		'a script that does not parse is declined',
		'status' in broken && broken.status === 4,
		JSON.stringify(broken),
	);
	const viaHost = instance.call('https://example.com/a', 1);
	ok(
		'the routing import answers through the scratch',
		'output' in viaHost && viaHost.output === 'routed:https://example.com/a',
		JSON.stringify(viaHost),
	);
	ok(
		"the rewriter's import saw the input once",
		routed.length === 1 &&
			routed[0][0] === 'rewriter' &&
			routed[0][1] === 0 &&
			routed[0][2] === 'https://example.com/a',
		JSON.stringify(routed),
	);
	const declined = instance.call('decline', 1);
	ok(
		'a routing the host declines is a non-zero status',
		'status' in declined && declined.status === 2,
		JSON.stringify(declined),
	);
	const after = instance.call('still.alive;', 0);
	ok(
		'the instance answers after a declined call',
		'output' in after && after.output === 'still.alive;',
	);
	// a second instance from the same compiled module, as every realm makes
	const second = new CoreInstance(module).members.rewriter;
	const other = second.call('other.realm;', 0);
	ok(
		'a second instance of the same module is independent',
		'output' in other && other.output === 'other.realm;',
	);
	ok(
		'the instance reports its memory',
		instance.memoryBytes >= 64 * 1024 &&
			instance.memoryBytes < 64 * 1024 * 1024,
		String(instance.memoryBytes),
	);

	// the members share the memory and nothing else: each routes for itself,
	// one is called from inside another's routing call, and each keeps its
	// own answer
	const sheet = core.members.scanner.exchange('a{b:url(x.png)}', 3);
	ok(
		"the scanner's routing import is its own",
		'output' in sheet &&
			sheet.output.startsWith('a{b:url(routed:x.png') &&
			routed.at(-1)[0] === 'scanner',
		JSON.stringify([sheet, routed.at(-1)]),
	);
	const nested = new CoreInstance(module, (member, kind, text) =>
		member === 'rewriter' ? `${text}#${inner('www.example.co.uk')}` : null,
	);
	const inner = (text) => {
		const answer = nested.members.suffix.call(text, 0);
		return 'output' in answer ? answer.output : `status ${answer.status}`;
	};
	const outer = nested.members.rewriter.call('https://a.example/', 1);
	ok(
		"a member called inside another's routing answers, and the outer call's answer is its own",
		'output' in outer &&
			outer.output === 'https://a.example/#4 17' &&
			inner('a.b.github.io') === '4 13',
		JSON.stringify(outer),
	);
	ok(
		'a member with no configuration refuses one',
		(() => {
			try {
				core.members.suffix.configure('x');
				return false;
			} catch (error) {
				return true;
			}
		})(),
	);

	// the thread's copy (src/wasm/thread.ts): instances of the core, made on
	// first use and kept for the next call of any member, and nothing at all
	// when the thread was not handed it (test/suites/wasm-instances.mjs has
	// what happens to an instance afterwards)
	const used = (name) => thread.withInstance(name, (it) => it);
	ok(
		'a module the thread never got has no instance',
		!thread.hasModule('core') &&
			!thread.hasModule('rewriter') &&
			used('rewriter') === null,
	);
	ok(
		'work without an instance is declined',
		thread.withInstance('rewriter', () => 'ran') === null,
	);
	await thread.adoptModules({ core: module, junk: 'not a module' });
	ok(
		'a handshake adopts the compiled module it carries, which holds every member',
		thread.hasModule('core') &&
			thread.hasModule('rewriter') &&
			thread.hasModule('scanner') &&
			thread.hasModule('suffix') &&
			!thread.hasModule('junk'),
	);
	const first = used('rewriter');
	ok(
		'the thread instantiates once',
		first instanceof BufferInstance && used('rewriter') === first,
	);
	ok(
		'work runs with the instance',
		thread.withInstance('rewriter', (it) => it.call('abc', 0).output) === 'abc',
	);
	ok(
		'a call of another member runs in the same instance, kept from the last call',
		thread.withInstance(
			'suffix',
			(it) => it.call('a.example.com', 0).output,
		) === '2 13' && used('rewriter') === first,
	);
	ok(
		"a member asked inside another's routing call answers, from an instance of its own",
		thread.withInstance(
			'rewriter',
			(it) => it.call('u', 1).output,
			(kind, text) =>
				`${text}#${thread.withInstance('suffix', (inner) => inner.call('www.example.co.uk', 0).output)}`,
		) === 'u#4 17',
	);
	ok(
		'work that throws drops the instance and declines',
		thread.withInstance('rewriter', () => {
			throw new Error('trap');
		}) === null && used('rewriter') !== first,
	);
	{
		// a trap in a call made inside another costs the inner call's
		// instance alone: the call around it goes on and is answered
		const before = used('rewriter');
		const around = thread.withInstance(
			'rewriter',
			(it) => it.call('v', 1).output,
			(kind, text) =>
				thread.withInstance('suffix', () => {
					throw new WebAssembly.RuntimeError('unreachable');
				}) ?? `declined:${text}`,
		);
		ok(
			'a trap in a member inside another costs its own instance, and the call around it is answered',
			around === 'declined:v' && used('rewriter') === before,
			JSON.stringify(around),
		);
	}
	const replaced = used('rewriter');
	thread.adoptModule('core', module);
	ok('the same module again keeps the instance', used('rewriter') === replaced);
	thread.adoptModule('core', await compileModule(bytes));
	ok(
		'a new module replaces the instance',
		used('rewriter') instanceof BufferInstance && used('rewriter') !== replaced,
	);
	ok(
		'the routing import is answered by the route of the call in hand',
		thread.withInstance(
			'rewriter',
			(it) => it.call('u', 1).output,
			(kind, text) => `one:${text}`,
		) === 'one:u' &&
			thread.withInstance(
				'rewriter',
				(it) => it.call('u', 1).output,
				(kind, text) => `two:${text}`,
			) === 'two:u' &&
			thread.withInstance('rewriter', (it) => it.call('u', 1).status) === 2,
	);

	// the service worker's way (a WebAssembly.Module cannot be posted to
	// it): the bytes, compiled by the thread, once for the same bytes
	const copy = () =>
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const module2 = thread.moduleOf('core');
	const adopting = thread.adoptModules({
		core: copy(),
		bad: new ArrayBuffer(4),
	});
	const held = await thread.heldModules();
	await adopting;
	ok(
		'a handshake compiles the bytes it carries, and says so once they are in',
		held.includes('core') &&
			!held.includes('bad') &&
			thread.moduleOf('core') !== module2,
		String(held),
	);
	const fromBytes = used('rewriter');
	await thread.adoptModules({ core: copy() });
	ok(
		'the same bytes again keep the module and its instance',
		fromBytes instanceof BufferInstance && used('rewriter') === fromBytes,
	);
}

await done();
