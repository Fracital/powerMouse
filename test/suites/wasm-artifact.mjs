// The wasm artifacts dist/ ships (assets/, built by deploy/rust/build.sh),
// checked in node the way a host's build pipeline would check them before
// renaming and byte-substituting them (deploy/rust/check.mjs: no custom
// section, the declared imports and exports and nothing else, none of the
// tokens a canary scan refuses), and loaded through src/wasm/module.ts the
// way every realm loads them: compiled once, instantiated from the compiled
// module, strings in and out, the routing import answered by the host.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// the loader, bundled from src so the suite runs what the bundles run
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}wasm-artifact-entry.mjs`;
writeFileSync(
	entry,
	`export { compileModule, BufferInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n` +
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
const { compileModule, BufferInstance, thread } = await import(bundle);

if (artifacts.includes('rewriter.wasm')) {
	const bytes = readFileSync(`${root}dist/rewriter.wasm`);
	const module = await compileModule(bytes);
	ok('the rewriter compiles from bytes', module instanceof WebAssembly.Module);
	const same = await compileModule(module);
	ok('a compiled module is taken as it is', same === module);

	const routed = [];
	const instance = new BufferInstance(module, (kind, text) => {
		routed.push([kind, text]);
		return text === 'decline' ? null : `routed:${text}`;
	});
	instance.configure('{"names":{"access":"$s$j"}}');
	const texts = [
		'',
		'a',
		'const x = location.href;',
		'über straße   \u{1F600} ' + 'x'.repeat(100000),
	];
	for (const text of texts) {
		const result = instance.call(text, 0);
		ok(
			`a ${text.length}-char input comes back as it went`,
			'output' in result && result.output === text,
			'output' in result ? '' : `status ${result.status}`,
		);
	}
	const viaHost = instance.call('https://example.com/a', 1);
	ok(
		'the routing import answers through the scratch',
		'output' in viaHost && viaHost.output === 'routed:https://example.com/a',
		JSON.stringify(viaHost),
	);
	ok(
		'the import saw the input once',
		routed.length === 1 &&
			routed[0][0] === 0 &&
			routed[0][1] === 'https://example.com/a',
		JSON.stringify(routed),
	);
	const declined = instance.call('decline', 1);
	ok(
		'a routing the host declines is a non-zero status',
		'status' in declined && declined.status === 2,
		JSON.stringify(declined),
	);
	const after = instance.call('still alive', 0);
	ok(
		'the instance answers after a declined call',
		'output' in after && after.output === 'still alive',
	);
	// a second instance from the same compiled module, as every realm makes
	const second = new BufferInstance(module);
	const other = second.call('other realm', 0);
	ok(
		'a second instance of the same module is independent',
		'output' in other && other.output === 'other realm',
	);
	ok(
		'the instance reports its memory',
		instance.memoryBytes >= 64 * 1024 &&
			instance.memoryBytes < 64 * 1024 * 1024,
		String(instance.memoryBytes),
	);

	// the thread's copy (src/wasm/thread.ts): one instance per module, made
	// on first use, and nothing at all for a module the thread was not handed
	ok(
		'a module the thread never got has no instance',
		!thread.hasModule('rewriter') && thread.instanceOf('rewriter') === null,
	);
	ok(
		'work without an instance is declined',
		thread.withInstance('rewriter', () => 'ran') === null,
	);
	await thread.adoptModules({ rewriter: module, junk: 'not a module' });
	ok(
		'a handshake adopts the compiled modules it carries',
		thread.hasModule('rewriter') && !thread.hasModule('junk'),
	);
	const first = thread.instanceOf('rewriter');
	ok(
		'the thread instantiates once',
		first instanceof BufferInstance && thread.instanceOf('rewriter') === first,
	);
	ok(
		'work runs with the instance',
		thread.withInstance('rewriter', (it) => it.call('abc', 0).output) === 'abc',
	);
	ok(
		'work that throws drops the instance and declines',
		thread.withInstance('rewriter', () => {
			throw new Error('trap');
		}) === null && thread.instanceOf('rewriter') !== first,
	);
	const replaced = thread.instanceOf('rewriter');
	thread.adoptModule('rewriter', module);
	ok(
		'the same module again keeps the instance',
		thread.instanceOf('rewriter') === replaced,
	);
	thread.adoptModule('rewriter', await compileModule(bytes));
	ok(
		'a new module replaces the instance',
		thread.instanceOf('rewriter') !== replaced,
	);
	thread.dropInstance('rewriter');
	ok(
		'a dropped instance is made again',
		thread.instanceOf('rewriter') !== null,
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
	ok(
		'an instance in a call is not entered again',
		thread.withInstance('rewriter', () =>
			thread.withInstance('rewriter', () => 'inner'),
		) === null && thread.withInstance('rewriter', () => 'after') === 'after',
	);

	// the service worker's way (a WebAssembly.Module cannot be posted to
	// it): the bytes, compiled by the thread, once for the same bytes
	const copy = () =>
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const adopting = thread.adoptModules({
		other: copy(),
		bad: new ArrayBuffer(4),
	});
	const held = await thread.heldModules();
	await adopting;
	ok(
		'a handshake compiles the bytes it carries, and says so once they are in',
		held.includes('other') &&
			!held.includes('bad') &&
			held.includes('rewriter'),
		String(held),
	);
	const fromBytes = thread.instanceOf('other');
	await thread.adoptModules({ other: copy() });
	ok(
		'the same bytes again keep the module and its instance',
		fromBytes instanceof BufferInstance &&
			thread.instanceOf('other') === fromBytes,
	);
}

await done();
