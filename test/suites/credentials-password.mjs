// Password and federated credentials (the Credential Management API),
// natively and through the proxy in both demo modes: the browser keeps them
// under the origin it sees, the proxy's, for every proxied site alike, so a
// get finds none and a store keeps nothing, as for a site with nothing
// saved; in a frame of another site than one of its ancestors both reject
// with Chrome's NotAllowedError, as natively.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const FILES = ['cred-password.html'];

/** the cases the page reported, from whichever frame reports them */
async function read(page, proxied) {
	for (let i = 0; i < 250; i++) {
		await sleep(200);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame.evaluate(() => window.__pi).catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

const native = {};
for (const file of FILES) {
	const page = await browser.newPage();
	await page.goto(`${FIXTURE}pages/${file}`, { waitUntil: 'commit' });
	native[file] = await read(page, false);
	await page.close();
}
ok(
	'natively, every page reported',
	FILES.every((file) => native[file]),
	JSON.stringify(native),
);

const proxyOrigin = new URL(PROXY).origin;
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const file of FILES) {
		const page = await openDemo(browser, base);
		const recorder = await recordRequests(page.context());
		await submitLanding(page, `${FIXTURE}pages/${file}`);
		const proxied = await read(page, true);
		for (const [name, want] of Object.entries(native[file] ?? {})) {
			const got = proxied?.[name];
			ok(
				`${mode}: ${file} ${name} as natively`,
				JSON.stringify(got) === JSON.stringify(want),
				JSON.stringify({ native: want, proxied: got ?? null }),
			);
		}
		const text = JSON.stringify(proxied ?? null);
		ok(
			`${mode}: ${file} reads no proxy URL`,
			!text.includes('/stomp/') && !text.includes(proxyOrigin),
			text.slice(0, 400),
		);
		const raw = recorder.raw();
		ok(
			`${mode}: ${file} makes no request past the proxy`,
			raw.length === 0,
			raw.map((entry) => `${entry.url} (${entry.type})`).join(' | '),
		);
		await page.context().close();
	}
}
await done(browser);
