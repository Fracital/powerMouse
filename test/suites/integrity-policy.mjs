// Integrity-Policy, as Chrome enforces it: a document whose header names
// blocked-destinations=(script) runs no external script that has no
// integrity metadata (one the parser met, one a script inserted) or that
// is not a CORS request, and still runs one whose integrity matches and its
// inline scripts;
// Integrity-Policy-Report-Only blocks nothing. The browser would apply the
// header to the proxy's own scripts and to the page's, whose integrity the
// worker checks itself (src/sri.ts), so the worker enforces it for the
// page instead. Compared with the same page loaded natively. Same-origin
// mode.
import { createHash } from 'node:crypto';
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const js = (name) => `window.__ran.push(${JSON.stringify(name)});`;
const script = (name) =>
	`/hdr/doc?ct=text/javascript&body=${encodeURIComponent(js(name))}`;
const hash = (text) =>
	`sha256-${createHash('sha256').update(text).digest('base64')}`;
const body = `<!doctype html><title>integrity policy</title>
<script>window.__ran = ['inline'];</script>
<script src="${script('checked')}" integrity="${hash(js('checked'))}" crossorigin="anonymous"></script>
<script src="${script('no-cors')}" integrity="${hash(js('no-cors'))}"></script>
<script src="${script('unchecked')}"></script>
<script src="${script('wrong')}" integrity="${hash('other')}"></script>
<script>
	const inserted = document.createElement('script');
	inserted.src = ${JSON.stringify(script('inserted'))};
	const insertedChecked = document.createElement('script');
	insertedChecked.src = ${JSON.stringify(script('inserted-checked'))};
	insertedChecked.integrity = ${JSON.stringify(hash(js('inserted-checked')))};
	insertedChecked.crossOrigin = 'anonymous';
	document.head.append(inserted, insertedChecked);
	setTimeout(() => (window.__result = [...window.__ran].sort().join(' ')), 1500);
</script>`;
const page = (header) =>
	`${FIXTURE}hdr/doc?h=${encodeURIComponent(header)}&body=${encodeURIComponent(body)}`;
const CASES = {
	enforced: 'integrity-policy:blocked-destinations=(script)',
	'report-only': 'integrity-policy-report-only:blocked-destinations=(script)',
	none: 'x-none:1',
};

async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(() => window.__result ?? null)
				.catch(() => null);
			if (found) return found;
		}
	}
	return null;
}

const browser = await launch();
const native = {};
for (const [name, header] of Object.entries(CASES)) {
	const nativePage = await browser.newPage();
	await nativePage.goto(page(header));
	native[name] = await report(nativePage);
	await nativePage.close();
}
console.log('native', JSON.stringify(native));
ok(
	'natively, the policy runs no external script without integrity, and report-only blocks nothing',
	native.enforced === 'checked inline inserted-checked' &&
		native['report-only'] === native.none,
	JSON.stringify(native),
);

const errors = [];
for (const [name, header] of Object.entries(CASES)) {
	const host = await browser.newPage();
	host.on('pageerror', (error) => errors.push(error.message));
	await host.goto(PROXY);
	await host.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	await host.evaluate(async (url) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		await window.controller.createFrame(element).go(url);
	}, page(header));
	const proxied = await report(host);
	await host.close();
	ok(
		`Integrity-Policy (${name}): the scripts that run, as natively`,
		proxied === native[name],
		JSON.stringify({ native: native[name], proxied }),
	);
}
await done(browser, errors);
