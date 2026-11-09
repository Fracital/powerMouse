// A media element's currentSrc and src read as natively for the page's own
// MediaSource and blob object URLs (media-blobs.html). SoundCloud and YouTube
// Music read currentSrc back and got the proxy origin's blob: URL
// (blob:http://<proxy>/<id>) where natively it is the URL the page made,
// blob:<page origin>/<id>. Each case (a MediaSource on audio through the src
// property and on video through setAttribute, a blob through new Audio()
// and in a video's <source>) is read at once and once the media has loaded,
// before and after the page reaches into an about:blank frame of its own and
// in that frame's document, and compared with the page loaded natively, in
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

const target = `${FIXTURE}pages/media-blobs.html`;
const read = () => (window.__mb?.done ? window.__mb : null);
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);

const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
ok(
	"natively, currentSrc is the page's own object URL once the media loads",
	native &&
		['alone', 'withFrame', 'inFrame'].every((phase) =>
			Object.values(native[phase]).every(
				(result) =>
					result.loaded?.currentIsURL === true &&
					result.loaded.currentSrc === 'blob:PAGE/ID',
			),
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
	for (let i = 0; i < 80 && !proxied; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			proxied ??= await frame.evaluate(read).catch(() => null);
	}
	ok(`${mode}: the page ran to the end`, !!proxied);
	for (const [phase, where] of [
		['alone', 'no other frame'],
		['withFrame', 'after an about:blank frame'],
		['inFrame', 'in the about:blank frame'],
	])
		for (const name of Object.keys(native?.[phase] ?? {})) {
			const x = JSON.stringify(native[phase][name]);
			const y = JSON.stringify(proxied?.[phase]?.[name]);
			ok(
				`${mode}: ${name} (${where}) reads src and currentSrc as natively`,
				x === y,
				`native ${x} proxied ${y}`,
			);
		}
	ok(
		`${mode}: no error reached the page`,
		page.errors.length === 0,
		page.errors.join(' | '),
	);
	await page.close();
}
await done(browser);
