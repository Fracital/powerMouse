// One Wisp connection split into lanes for the transport's shards
// (src/transport/wispSplit.ts), Node-side: a relay's side made of streams,
// lanes on MessageChannels read and written as epoxy would (lanePipe).
//
// - the first lane gets the relay's greeting (v2 INFO, then stream 0's
//   CONTINUE) and its INFO goes to the relay; a later lane gets the same
//   greeting, byte for byte, and its INFO is dropped;
// - a relay that sends INFO and CONTINUE at once (it opened the Wisp stream,
//   wisp-lanes SPEC section 2): the first lane's INFO, written after the
//   CONTINUE, still reaches the relay, before any CONNECT, and a later
//   lane is greeted only once it has;
// - each lane's CONNECT takes the next id of the connection, every packet
//   after it goes out under that id, and the relay's packets come back
//   under the lane's own id; a CLOSE either way ends the pairing;
// - a lane's CLOSE of stream 0 never reaches the relay; a lane that ends
//   closes its open streams with one CLOSE each, and the other lane goes on;
// - the relay's CLOSE of stream 0 reaches every lane, and when the relay's
//   connection ends every lane's read ends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch {
	console.log('SKIP wisp-split: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}wisp-split-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/transport/wispSplit.ts`)};\n`,
);
const bundle = `${OUT}wisp-split.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { WispSplit, lanePipe } = await import(`${bundle}?${Date.now()}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECT = 1;
const DATA = 2;
const CONTINUE = 3;
const CLOSE = 4;
const INFO = 5;

/** a packet: type, stream id, payload bytes */
function packet(type, id, ...payload) {
	const bytes = new Uint8Array(5 + payload.length);
	bytes[0] = type;
	new DataView(bytes.buffer).setUint32(1, id, true);
	bytes.set(payload, 5);
	return bytes;
}
const idOf = (bytes) =>
	new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
const show = (bytes) =>
	`${bytes[0]}:${idOf(bytes)}:${[...bytes.slice(5)].join('.')}`;

/** the relay's end: what it sends, what it got */
function relay() {
	let controller;
	const got = [];
	const read = new ReadableStream({
		start(c) {
			controller = c;
		},
	});
	const write = new WritableStream({
		write(bytes) {
			got.push(new Uint8Array(bytes));
		},
	});
	return {
		pipe: { read, write },
		got,
		send: (bytes) => controller.enqueue(bytes.slice().buffer),
		end: () => controller.close(),
	};
}

/** a lane, read and written as epoxy reads and writes its function transport */
function lane(split) {
	const { port1, port2 } = new MessageChannel();
	split.attach(port1);
	const pipe = lanePipe(port2);
	const got = [];
	let ended = false;
	const reader = pipe.read.getReader();
	void (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			got.push(new Uint8Array(value));
		}
		ended = true;
	})();
	const writer = pipe.write.getWriter();
	return {
		got,
		get ended() {
			return ended;
		},
		send: (bytes) => writer.write(bytes),
		close: () => writer.close(),
	};
}

const r = relay();
const split = new WispSplit(r.pipe);
const info = packet(INFO, 0, 2, 0, 1, 0, 0, 0, 0);
const greeting = packet(CONTINUE, 0, 128, 0, 0, 0);
r.send(info);
const a = lane(split);
await sleep(20);
ok(
	'the first lane hears the relay first',
	a.got.map(show).join() === show(info),
	a.got.map(show).join(),
);
a.send(packet(INFO, 0, 2, 0, 1, 0, 0, 0, 0));
await sleep(20);
r.send(greeting);
await sleep(20);
ok(
	'its INFO reaches the relay',
	r.got.length === 1 && r.got[0][0] === INFO,
	r.got.map(show).join(),
);
ok(
	'it hears the whole greeting',
	a.got.map(show).join() === [info, greeting].map(show).join(),
);

const b = lane(split);
await sleep(20);
ok(
	'a later lane hears the same greeting, byte for byte',
	b.got.map(show).join() === [info, greeting].map(show).join(),
	b.got.map(show).join(),
);
b.send(packet(INFO, 0, 2, 0, 1, 0, 0, 0, 0));
await sleep(20);
ok('its INFO is dropped', r.got.length === 1, r.got.map(show).join());

// each epoxy numbers its streams from 1
a.send(packet(CONNECT, 1, 1, 80, 0, 97));
b.send(packet(CONNECT, 1, 1, 80, 0, 98));
b.send(packet(DATA, 1, 7));
a.send(packet(DATA, 1, 9));
await sleep(20);
// (each lane's packets in its order; the lanes' batches in theirs)
const sent = r.got.slice(1).map(show);
const fromA = sent.filter((line) => /\.97$|:9$/.test(line));
const fromB = sent.filter((line) => /\.98$|:7$/.test(line));
ok(
	"each lane's CONNECT takes the connection's next id and its DATA follows it",
	sent.length === 4 &&
		fromA.join() === ['1:1:1.80.0.97', '2:1:9'].join() &&
		fromB.join() === ['1:2:1.80.0.98', '2:2:7'].join(),
	sent.join(),
);
r.send(packet(DATA, 2, 42));
r.send(packet(CONTINUE, 1, 64, 0, 0, 0));
r.send(packet(DATA, 1, 43));
await sleep(20);
ok(
	"the relay's packets come back to their lane under its own id",
	a.got.slice(2).map(show).join() === ['3:1:64.0.0.0', '2:1:43'].join() &&
		b.got.slice(2).map(show).join() === '2:1:42',
	`${a.got.slice(2).map(show)} / ${b.got.slice(2).map(show)}`,
);
r.send(packet(CLOSE, 2, 2));
r.send(packet(DATA, 2, 44));
await sleep(20);
ok(
	"the relay's CLOSE reaches the lane, and a packet after it is dropped",
	b.got.slice(3).map(show).join() === '4:1:2',
	b.got.slice(3).map(show).join(),
);
const before = r.got.length;
b.send(packet(DATA, 1, 8));
b.send(packet(CLOSE, 0, 2));
await sleep(20);
ok(
	"a lane's packets for a closed stream and its CLOSE of stream 0 never reach the relay",
	r.got.length === before,
	r.got.slice(before).map(show).join(),
);

// a lane that ends closes what it had open
b.send(packet(CONNECT, 2, 1, 80, 0, 99));
await sleep(20);
const opened = idOf(r.got.at(-1));
b.close();
await sleep(20);
const closing = r.got.at(-1);
ok(
	'a lane that ends closes its open streams, one CLOSE each',
	closing[0] === CLOSE && idOf(closing) === opened && b.ended,
	`${show(closing)} for ${opened}, ended ${b.ended}`,
);
a.send(packet(DATA, 1, 10));
await sleep(20);
ok(
	'the other lane goes on',
	show(r.got.at(-1)) === '2:1:10',
	show(r.got.at(-1)),
);

// the relay's word to the whole connection, and its end
const c = lane(split);
await sleep(20);
r.send(packet(CLOSE, 0, 2));
await sleep(20);
ok(
	"the relay's CLOSE of stream 0 reaches every lane",
	show(a.got.at(-1)) === '4:0:2' && show(c.got.at(-1)) === '4:0:2',
	`${show(a.got.at(-1))} / ${show(c.got.at(-1))}`,
);
r.end();
await sleep(20);
ok('when the relay ends, every lane ends', a.ended && c.ended && split.ended);
const late = lane(split);
await sleep(20);
ok(
	'a lane attached after it ends at once',
	late.ended && late.got.length === 0,
);

// a relay that opened the Wisp stream: INFO and CONTINUE before the client's INFO
{
	const r = relay();
	const split = new WispSplit(r.pipe);
	r.send(info);
	r.send(greeting);
	const a = lane(split);
	await sleep(20);
	const b = lane(split);
	await sleep(20);
	ok(
		'early CONTINUE: the first lane hears INFO and CONTINUE, a later lane nothing yet',
		a.got.map(show).join() === [info, greeting].map(show).join() &&
			b.got.length === 0,
		`${a.got.map(show)} / ${b.got.map(show)}`,
	);
	a.send(packet(INFO, 0, 2, 0, 1, 0, 0, 0, 0));
	a.send(packet(CONNECT, 1, 1, 80, 0, 97));
	await sleep(20);
	ok(
		"early CONTINUE: the first lane's INFO reaches the relay first, its CONNECT after",
		r.got.map(show).join() === ['5:0:2.0.1.0.0.0.0', '1:1:1.80.0.97'].join(),
		r.got.map(show).join(),
	);
	ok(
		'early CONTINUE: a later lane is greeted once it has',
		b.got.map(show).join() === [info, greeting].map(show).join(),
		b.got.map(show).join(),
	);
	b.send(packet(INFO, 0, 2, 0, 1, 0, 0, 0, 0));
	b.send(packet(CONNECT, 1, 1, 80, 0, 98));
	await sleep(20);
	ok(
		"early CONTINUE: the later lane's INFO is dropped, its CONNECT takes the next id",
		r.got.slice(2).map(show).join() === '1:2:1.80.0.98',
		r.got.slice(2).map(show).join(),
	);
	r.end();
}

// a v1 opening (the carrier said the INFO for its epoxy): CONTINUE alone
{
	const r = relay();
	const split = new WispSplit(r.pipe);
	r.send(greeting);
	const a = lane(split);
	await sleep(20);
	const b = lane(split);
	await sleep(20);
	ok(
		'v1: a later lane is greeted with the CONTINUE at once',
		b.got.map(show).join() === show(greeting),
		b.got.map(show).join(),
	);
	a.send(packet(CONNECT, 1, 1, 80, 0, 97));
	await sleep(20);
	ok(
		"v1: the first lane's CONNECT goes out",
		r.got.map(show).join() === '1:1:1.80.0.97',
		r.got.map(show).join(),
	);
	r.end();
}

await done();
