// A blob: URL the page mints carries the page's origin, not the proxy's, and
// everything the page hands it to still finds the blob: fetch and XHR (whose
// response URLs read back in the same form), an image, a worker (whose own
// object URLs are the same story), a revoke. A blob: URL of another origin
// does not resolve, as the browser refuses blob: URLs across origins. Both
// demo modes.
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

const browser = await launch();
const errors = [];
const origin = new URL(FIXTURE).origin;
const pageBlob = (url) =>
	typeof url === 'string' && url.startsWith(`blob:${origin}/`);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/blob-origin.html`);
	let result = null;
	for (let i = 0; i < 60 && !result?.done; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		result = await frame?.evaluate(() => window.__blob).catch(() => null);
	}
	result ||= {};
	ok(
		`${mode}: createObjectURL answers with the page's origin, for a Blob and a File`,
		pageBlob(result.url) &&
			pageBlob(result.file) &&
			result.origin === origin &&
			result.error === undefined,
		JSON.stringify([result.url, result.file, result.origin, result.error]),
	);
	ok(
		`${mode}: fetch and XHR read the blob and report the same URL back`,
		result.fetchUrl === result.url &&
			result.text === 'hello' &&
			result.xhrUrl === result.url &&
			result.xhrText === 'hello',
		JSON.stringify([
			result.fetchUrl,
			result.text,
			result.xhrUrl,
			result.xhrText,
		]),
	);
	ok(
		`${mode}: an image loads from the blob: URL and reads it back as written`,
		result.imgLoaded === true && result.imgSrc === result.imageURL,
		JSON.stringify([result.imgLoaded, result.imgSrc, result.imageURL]),
	);
	ok(
		`${mode}: a worker started from a blob: URL mints and fetches its own under the page's origin`,
		pageBlob(result.worker?.u) &&
			result.worker?.fetchUrl === result.worker?.u &&
			result.worker?.text === 'w' &&
			result.worker?.origin === origin,
		JSON.stringify(result.worker),
	);
	ok(
		`${mode}: a blob: URL of another origin does not resolve; a revoked one is gone`,
		result.foreign === 'rejected TypeError' &&
			result.revoked === 'rejected TypeError',
		JSON.stringify([result.foreign, result.revoked]),
	);
	errors.push(...page.errors.map((e) => `${mode}: ${e}`));
	await page.close();
}
await done(browser, errors);
