// Documents that used to escape the rewrite: a child iframe's sandbox and
// csp attributes (which would give it an origin or a policy the service
// worker cannot serve) are dropped but read back as written; an import map's
// URLs are routed, so bare specifiers resolve to proxied modules; an
// about:blank popup the page writes into is injected like a child frame, so
// what it writes is routed. Same-origin mode (the host realm reads the
// frame's real attributes).
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__el = element;
	await window.controller.createFrame(element).go(`${fixture}pages/docs.html`);
}, FIXTURE);
await sleep(2500);
const frame = page
	.frames()
	.find(
		(f) =>
			f.parentFrame() === page.mainFrame() && f.url().includes('/stomp/html/'),
	);

const sandbox = await page.evaluate(() => {
	const sb = window.__el.contentDocument.getElementById('sb');
	const real = (name) => Element.prototype.getAttribute.call(sb, name);
	return {
		sandbox: real('sandbox'),
		csp: real('csp'),
		child: (() => {
			try {
				return sb.contentWindow?.location.href;
			} catch (error) {
				return `error ${error.message.slice(0, 40)}`;
			}
		})(),
	};
});
ok(
	'iframe sandbox and csp are dropped and the child loads through the proxy',
	sandbox.sandbox === null &&
		sandbox.csp === null &&
		typeof sandbox.child === 'string' &&
		sandbox.child.includes('/stomp/html/'),
	JSON.stringify(sandbox),
);
const seen = await frame.evaluate(() => {
	const sb = document.getElementById('sb');
	return [sb.getAttribute('sandbox'), sb.hasAttribute('csp')];
});
ok(
	'the page reads the sandbox it wrote',
	seen[0] === 'allow-scripts allow-same-origin' && seen[1] === true,
	JSON.stringify(seen),
);

const im = await frame.evaluate(() => window.__im);
ok(
	'a bare specifier resolves through the routed import map',
	im === 'A',
	JSON.stringify(im),
);

const popupEvent = context.waitForEvent('page', { timeout: 5000 });
const opened = await frame.evaluate(() => window.__popup());
const popup = await popupEvent.catch(() => null);
await sleep(1000);
// the real attribute, through the host realm's getAttribute (the popup's own
// is hooked and answers with what the page wrote)
const written = await page
	.evaluate(() => {
		const img = window.__el.contentWindow.__w.document.getElementById('i');
		return img && Element.prototype.getAttribute.call(img, 'src');
	})
	.catch((error) => `error ${error.message.slice(0, 60)}`);
ok(
	'what the page writes into an about:blank popup is routed',
	opened === 'opened' &&
		popup !== null &&
		typeof written === 'string' &&
		written.includes('/stomp/binary/'),
	JSON.stringify({ opened, popup: popup?.url(), written }),
);
await done(browser);
