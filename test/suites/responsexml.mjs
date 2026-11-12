// XMLHttpRequest.responseXML is a Window member: a document's XHR has it and
// parses an XML body into a document, a worker's XHR has none. The proxied
// stand-in must match both, and mirroring the worker's XMLHttpRequest class
// must not leave the "Key not present in global: responseXML" warning on the
// console (the worker stand-in used to expose a member the real worker XHR
// lacks). Both modes, against the page loaded natively.
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
const PAGE = `${FIXTURE}pages/responsexml.html`;

async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		const report = await getFrame()
			?.evaluate(() =>
				window.__rx?.docDone && window.__rx?.workerDone ? window.__rx : null,
			)
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return {};
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: a document XHR has responseXML and parses the XML, a worker XHR has none',
	native.docHasResponseXML === true &&
		native.docRoot === 'root' &&
		native.worker?.onInstance === false &&
		native.worker?.onPrototype === false,
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the worker's mirror warning surfaces on the page console
	const warnings = [];
	page.on('console', (message) => warnings.push(message.text()));
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	ok(
		`${mode}: a document XHR has responseXML and parses the XML as natively`,
		proxied.docHasResponseXML === native.docHasResponseXML &&
			proxied.docRoot === native.docRoot,
		`native ${JSON.stringify([native.docHasResponseXML, native.docRoot])} proxied ${JSON.stringify([proxied.docHasResponseXML, proxied.docRoot])}`,
	);
	ok(
		`${mode}: a worker XHR has no responseXML, as natively`,
		proxied.worker?.onInstance === false &&
			proxied.worker?.onPrototype === false,
		JSON.stringify(proxied.worker),
	);
	ok(
		`${mode}: mirroring the worker XMLHttpRequest class leaves no "Key not present" warning`,
		!warnings.some((text) => text.includes('Key not present in global')),
		warnings.filter((text) => text.includes('Key not present')).join(' | '),
	);
	await page.close();
}

await done(browser);
