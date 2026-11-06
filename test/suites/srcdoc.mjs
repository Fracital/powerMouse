// <iframe srcdoc>: the inline document gets the same shell as a fetched one,
// so its scripts are rewritten (top is the outermost proxied page) and its
// resources are routed through the proxy.
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
await submitLanding(page, `${FIXTURE}pages/srcdoc.html`);

let sd = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
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
ok(
	'srcdoc resources are routed through the proxy',
	/\/stomp\/binary\//.test(sd.result?.[1] || ''),
	JSON.stringify(sd.result?.[1]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
