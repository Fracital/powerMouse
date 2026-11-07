// `storage` events reach the other documents of the same proxied origin
// (the writer never hears its own changes), and never another origin.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const other = FIXTURE.replace('127.0.0.1', 'localhost');
// a reader on the origin, a reader on another origin, then the writer
for (const url of [
	`${FIXTURE}pages/storage.html`,
	`${other}pages/storage.html`,
	`${FIXTURE}pages/storage.html#writer`,
]) {
	await page.click('#home');
	await submitLanding(page, url);
	await sleep(1500);
}
await sleep(4000);
const frames = page
	.frames()
	.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
const results = [];
for (const frame of frames) {
	try {
		results.push(await frame.evaluate(() => window.__st));
	} catch (error) {
		results.push({ error: error.message });
	}
}
const [reader, foreign, writer] = results;
ok('the writer wrote', writer?.wrote === true, JSON.stringify(writer));
ok(
	'a same-origin reader gets set, change and remove events in order',
	JSON.stringify(reader?.events?.map((e) => e.slice(0, 3))) ===
		JSON.stringify([
			['k', null, 'v1'],
			['k', 'v1', 'v2'],
			['k', 'v2', null],
		]),
	JSON.stringify(reader?.events),
);
ok(
	'the event carries the localStorage area and the page URL',
	reader?.events?.[0]?.[3] === true &&
		reader?.events?.[0]?.[4] === `${FIXTURE}pages/storage.html#writer`,
	JSON.stringify(reader?.events?.[0]),
);
ok(
	'the writer does not hear its own changes',
	writer?.events?.length === 0,
	JSON.stringify(writer?.events),
);
ok(
	'another proxied origin hears nothing',
	foreign?.events?.length === 0,
	JSON.stringify(foreign?.events),
);

// a value far over the beacon quota: the writer sees it at once, the worker
// stores it asynchronously, and another document reads it whole
const show = async (url) => {
	await page.click('#home');
	await submitLanding(page, url);
	let value = null;
	for (let i = 0; i < 60 && !value?.done; i++) {
		await sleep(500);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		value = await frame?.evaluate(() => window.__big).catch(() => null);
	}
	return value ?? {};
};
const big = await show(`${FIXTURE}pages/big-storage.html`);
await sleep(1500);
const bigReader = await show(`${FIXTURE}pages/big-storage.html#reader`);
ok(
	'a 200 KiB localStorage value is accepted, read back and listed by its writer at once',
	big.stored === true && big.readBack === true && big.listed === true,
	JSON.stringify(big),
);
ok(
	'the value is stored for another document, whole',
	bigReader.readerLength === 200 * 1024 + 4 && bigReader.readerEnd === '-end',
	JSON.stringify(bigReader),
);
ok(
	'a 2 MiB value stores too, and a removal right after it keeps the order',
	big.huge === 'stored' && big.hugeGone === true,
	JSON.stringify([big.huge, big.hugeGone]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
