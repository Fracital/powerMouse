// src/transport/promptSink.ts, checked in node against the order
// wasm-bindgen-futures 0.4.50's JsFuture works in: it calls `then` with its
// two closures and keeps them after `then` returns, and the closure that is
// called drops what it finds kept. A closure called inside `then` finds
// nothing, so both stay, keeping the future's state, which keeps them.
//
// epoxy with deploy/epoxy's epoxy-tls 0075 (the build STomp pins) never
// reads the writer's `ready` and watches every `write()` in a JsFuture: its
// futures must all drop (a shard kept two closures a packet, 6 to 8 MB a
// minute on news sites). A build without 0075 reads `ready` before each
// write and must still find `ready` and `write()` settled at once (it holds
// wisp-mux's lock while it waits, test/suites/carrier-epoxy-build.mjs). A
// write the stream rejects fails the writes after it, for both.
// Skips when esbuild is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch {
	console.log('SKIP prompt-sink-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}prompt-sink-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { promptSink } from ${JSON.stringify(`${root}src/transport/promptSink.ts`)};\n`,
);
const bundle = `${OUT}prompt-sink-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { promptSink } = await import(`${bundle}?${Date.now()}`);

/** JsFuture::from as wasm-bindgen-futures 0.4.50 orders it, counting the futures whose closures stay */
const futures = () => {
	const kept = new Set();
	const from = (promise) => {
		const state = { callbacks: null, result: null };
		const finish = (result) => {
			if (state.callbacks) kept.delete(state);
			state.callbacks = null;
			state.result ??= result;
		};
		promise.then(
			(value) => finish({ ok: true, value }),
			(error) => finish({ ok: false, error }),
		);
		state.callbacks = 'resolve, reject';
		kept.add(state);
		return state;
	};
	return { from, kept };
};
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
const PACKETS = 200;

// a stream that takes every packet, and one that fails the third
const streams = () => {
	const taken = [];
	let writes = 0;
	const good = new WritableStream({ write: (chunk) => void taken.push(chunk) });
	const bad = new WritableStream({
		write: () => {
			if (++writes === 3) throw new Error('the relay went');
		},
	});
	return { good, bad, taken };
};

// 0075: write() only, each watched in a future of its own
{
	const { good, taken } = streams();
	const writer = promptSink(good).getWriter();
	const { from, kept } = futures();
	for (let i = 0; i < PACKETS; i++) from(writer.write(new Uint8Array([i])));
	await macrotask();
	ok(
		'a writer that never reads ready: every future of its writes drops its closures',
		kept.size === 0,
		`${kept.size} of ${PACKETS} kept`,
	);
	ok(
		'a writer that never reads ready: its packets are written in order',
		taken.length === PACKETS && taken.every((chunk, i) => chunk[0] === i),
		`${taken.length} written`,
	);
}
{
	const { bad } = streams();
	const writer = promptSink(bad).getWriter();
	const { from } = futures();
	for (let i = 0; i < 3; i++) from(writer.write(new Uint8Array([i])));
	await macrotask();
	const after = from(writer.write(new Uint8Array([3])));
	await macrotask();
	ok(
		'a writer that never reads ready: a write after one the stream failed fails',
		after.result?.ok === false && /relay went/.test(String(after.result.error)),
		JSON.stringify(after.result),
	);
}

// without 0075: ready then write(), each awaited as the sink polls it
{
	const { good, taken } = streams();
	const writer = promptSink(good).getWriter();
	const { from } = futures();
	let pending = 0;
	for (let i = 0; i < PACKETS; i++) {
		if (!from(writer.ready).result) pending++;
		if (!from(writer.write(new Uint8Array([i]))).result) pending++;
	}
	ok(
		'a writer that reads ready: ready and write() are settled as they are returned',
		pending === 0,
		`${pending} of ${PACKETS * 2} pending`,
	);
	await macrotask();
	ok(
		'a writer that reads ready: its packets are written in order',
		taken.length === PACKETS && taken.every((chunk, i) => chunk[0] === i),
		`${taken.length} written`,
	);
}
{
	const { bad } = streams();
	const writer = promptSink(bad).getWriter();
	const { from } = futures();
	for (let i = 0; i < 3; i++) {
		from(writer.ready);
		from(writer.write(new Uint8Array([i])));
	}
	await macrotask();
	const ready = from(writer.ready);
	ok(
		'a writer that reads ready: ready fails at once after the stream failed a write',
		ready.result?.ok === false && /relay went/.test(String(ready.result.error)),
		JSON.stringify(ready.result),
	);
}

await done();
