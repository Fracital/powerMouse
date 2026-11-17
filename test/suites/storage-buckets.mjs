// navigator.storageBuckets, natively and through the proxy
// (test/pages/storage-buckets.html). Every proxied site shares the proxy's
// real origin, so the browser keys every site's buckets together: a site
// would list another's bucket names, open its buckets and read the
// databases in them. Through the proxy each site's (and partition's)
// buckets are its own, under the names it gave them: the names refused, the
// names kept and read back, the stores inside a bucket, a worker's buckets,
// and a frame of another site and a sandboxed frame are compared with the
// same pages loaded natively.
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

const PAGE = `${FIXTURE}pages/storage-buckets.html`;

async function measure(frames) {
	for (let i = 0; i < 160; i++) {
		for (const frame of frames()) {
			const value = await frame
				?.evaluate(() => window.__buckets)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.frames());
await nativePage.close();
ok(
	"natively, a frame of another site finds none of the page's buckets",
	Array.isArray(native?.crossSite?.keys) &&
		native.crossSite.keys.length === 0 &&
		JSON.stringify(native.crossSite.databases) === '[]',
	JSON.stringify(native),
);

// what each check compares
const CHECKS = {
	"invalid names are refused with Chrome's errors": [
		'invalid',
		'deleteInvalid',
		'noArgument',
		'options',
	],
	'the names a page gave come back from open(), keys() and delete()': [
		'opened',
		'keys',
		'delete',
		'identity',
		'long',
	],
	"a bucket's databases, caches and files are the page's own, apart from its default storage":
		['database', 'caches', 'directory'],
	"a worker's buckets are its page's": ['worker', 'keysAfterWorker'],
	"a frame of another site finds none of the page's buckets": ['crossSite'],
	'a sandboxed frame is refused the buckets': ['sandboxed'],
};
const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page
			.context()
			.pages()
			.flatMap((p) => p.frames()),
	);
	for (const [name, keys] of Object.entries(CHECKS)) {
		const pick = (value) => JSON.stringify(keys.map((key) => value?.[key]));
		ok(
			`${mode}: ${name}, as natively`,
			pick(proxied) === pick(native),
			JSON.stringify({ native: pick(native), proxied: pick(proxied) }),
		);
	}
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	for (const other of page.context().pages()) await other.close();
}
await done(browser, errors);
