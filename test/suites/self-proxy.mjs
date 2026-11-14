// Proxy-ception (config.allowSelfProxy, here through the demo's
// STOMP_ALLOW_SELF_PROXY; the server env is set in test/run.mjs). With it on
// the proxy forwards its own origin instead of refusing it, so the demo can be
// loaded through itself: the inner demo renders and its own controller boots
// through the outer proxy. The default-refused path is the fetch-credentials
// suite's.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
// the demo's own URL into the landing omnibar: load the demo through itself
await submitLanding(page, HOST);

// the outer proxied frame that shows the inner demo
const innerFrame = () =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
let rendered = null;
// the inner controller tunnels its transport through the outer one, so give
// its boot the patience a single transport gets elsewhere (~60 s)
for (let i = 0; i < 160; i++) {
	await sleep(500);
	const frame = innerFrame();
	if (!frame || frame.url() === 'about:blank') continue;
	try {
		rendered = await frame.evaluate(() => ({
			title: document.title,
			landing: !!document.getElementById('landing'),
			status: document.getElementById('logMsg')?.textContent || '',
		}));
	} catch (error) {
		rendered = null;
		continue;
	}
	if (/^(Ready|Error)/.test(rendered.status)) break;
}
ok(
	'the demo renders inside the demo through the proxy',
	!!rendered && rendered.landing && /powerMouse/i.test(rendered.title || ''),
	JSON.stringify(rendered),
);
ok(
	"the inner demo's own controller boots through the outer proxy",
	rendered?.status === 'Ready',
	JSON.stringify(rendered?.status),
);
await done(browser, page.errors);
