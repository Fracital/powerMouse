// Many storage reads in one task (storage-burst.html): every read through
// the proxy was a synchronous beacon to the service worker, and Chrome
// refuses beacons once a document has 64 KiB of them in flight, which a task
// with a few hundred reads reaches (Twitch reads one flag key 117 times while
// it renders). The reads after that threw QuotaExceededError, which a native
// read never does, and Twitch's error logger, which reads a flag again,
// recursed until the stack overflowed. Repeated reads are answered from a
// per-document copy now; the cases also check that another document's write
// is read at once. Each case is compared with the page loaded natively, in
// both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/storage-burst.html`;
const read = () =>
	window.__sb?.done
		? { cases: window.__sb.cases, reported: window.__sb.reported }
		: null;

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 40 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read);
}
await nativePage.close();
ok(
	'natively, no read throws and the logger reports nothing',
	native !== null &&
		native.reported === null &&
		Object.values(native.cases).every(
			(value) => !String(value).startsWith('threw'),
		),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// a slow runner can take more than ten seconds to show the frame
	for (let i = 0; i < 160 && !proxied; i++) {
		await sleep(250);
		// the page's child frame is newer, so every proxied frame is asked
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			proxied ??= await frame.evaluate(read).catch(() => null);
	}
	ok(`${mode}: the page finishes through the proxy`, !!proxied);
	ok(
		`${mode}: the error logger reports nothing`,
		proxied?.reported === null,
		String(proxied?.reported),
	);
	for (const name of Object.keys(native?.cases ?? {})) {
		const a = JSON.stringify(native.cases[name]);
		const b = JSON.stringify(proxied?.cases?.[name]);
		ok(
			`${mode}: ${name} reads as natively`,
			a === b,
			a === b ? a.slice(0, 160) : `native ${a} proxied ${b}`,
		);
	}
	await page.close();
}
await done(browser);
