// <iframe srcdoc>: the inline document gets the same shell as a fetched one,
// so its scripts are rewritten (top is the outermost proxied page) and its
// resources are routed through the proxy.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/srcdoc.html`);

let sd = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		sd = (await frame.evaluate(() => window.__sd)) || {};
	} catch (error) {
		sd = {};
	}
	if (sd.result) break;
}
ok(
	'srcdoc script sees the proxied page as top',
	sd.result?.[0] === true,
	JSON.stringify(sd.result),
);
// the page reads its own URLs back from performance entries (readback
// suite): a routed fetch resolves to the fixture origin, a raw one would
// have hit the proxy origin
const names = (sd.result?.[1] || '').split(' ');
ok(
	'srcdoc resources are routed through the proxy',
	names.includes(`${FIXTURE}pages/echo.json`) &&
		!names.some((name) => name.startsWith(`${PROXY}pages/`)),
	JSON.stringify(sd.result?.[1]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
