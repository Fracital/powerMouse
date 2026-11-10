// navigator.storage.estimate() for IndexedDB, against Chrome. A page stores
// values of several shapes (compressible and not, large and small, many
// small records), each in a database of its own, and reads how much the
// estimate grew for each (test/pages/storage-estimate.html). Natively the
// usage is what the database takes on disk, so the native page runs in a
// profile on disk (an off-the-record one counts in pages); through the proxy
// the StorageEstimate module estimates the same from the values
// (src/inject/idbSize.ts). Each figure must be within a quarter of
// Chrome's, in both modes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
	CHROME,
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

const PAGE = `${FIXTURE}pages/storage-estimate.html`;
/** how far a proxied figure may be from Chrome's, as a share of it */
const TOLERANCE = 0.25;

async function measure(frames) {
	for (let i = 0; i < 120; i++) {
		for (const frame of frames()) {
			const value = await frame
				?.evaluate(() => window.__estimate)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const profile = mkdtempSync(join(tmpdir(), 'stomp-estimate-'));
let native;
try {
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: CHROME,
		headless: true,
		args: [
			'--no-sandbox',
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
		],
	});
	const page = await context.newPage();
	await page.goto(PAGE);
	native = await measure(() => page.frames());
	await context.close();
} finally {
	rmSync(profile, { recursive: true, force: true });
}
ok(
	'natively, every value was stored and counted',
	native && !native.error && Object.keys(native).length === 8,
	JSON.stringify(native),
);
// what the comparison relies on: a large compressible value counts its
// compressed size
ok(
	'natively, a megabyte of zeros counts as compressed',
	native?.['zeros 1M'] > 0 && native['zeros 1M'] < 200000,
	JSON.stringify(native?.['zeros 1M']),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page
			.frames()
			.filter((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url())),
	);
	ok(
		`${mode}: every value was stored`,
		proxied && !proxied.error,
		JSON.stringify(proxied),
	);
	for (const name of Object.keys(native ?? {})) {
		if (name === 'warm') continue;
		const want = native[name];
		const got = proxied?.[name];
		ok(
			`${mode}: ${name} counts as natively, within ${TOLERANCE * 100}%`,
			typeof got === 'number' && Math.abs(got - want) <= want * TOLERANCE,
			`native ${want}, proxied ${got}`,
		);
	}
	await page.context().close();
}

await done(browser);
