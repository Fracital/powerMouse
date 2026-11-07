// A standalone SVG document and an XHTML page load through the proxy as
// what they are: served under their own mime through an XML shell, parsed
// with it, injected (the spoofs hold: top is the window, location is the real
// URL), their scripts run rewritten, their links read back as written and
// their images and stylesheets fetch through the proxy. Same-origin mode, the
// demo's controller, the request reports for the fetches.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const result = await page.evaluate(async (fixture) => {
	const requests = [];
	window.controller.addEventListener('request', (event) =>
		requests.push([
			event.detail.url.split('/pages/').pop(),
			event.detail.status,
		]),
	);
	const show = async (file) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		await frame.go(`${fixture}pages/${file}`);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const doc = element.contentDocument;
		const root = doc?.documentElement;
		return {
			contentType: doc?.contentType,
			root: root?.nodeName,
			namespace: root?.namespaceURI,
			title: doc?.title,
			top: root?.getAttribute('data-top'),
			href: root?.getAttribute('data-href'),
			link: root?.getAttribute('data-link'),
			img: root?.getAttribute('data-img'),
			injected: doc?.defaultView ? '$P$s' in doc.defaultView : null,
		};
	};
	const svg = await show('standalone.svg');
	const xhtml = await show('standalone.xhtml');
	await new Promise((resolve) => setTimeout(resolve, 500));
	return { svg, xhtml, requests };
}, FIXTURE);
const fetched = (name) =>
	result.requests.some(([url, status]) => url === name && status === 200);
ok(
	'a standalone SVG document is served as SVG, injected, with its script rewritten',
	result.svg.contentType === 'image/svg+xml' &&
		result.svg.root === 'svg' &&
		result.svg.namespace === 'http://www.w3.org/2000/svg' &&
		result.svg.title === 'STANDALONE SVG' &&
		result.svg.top === 'self' &&
		result.svg.href === `${FIXTURE}pages/standalone.svg` &&
		result.svg.link === '/pages/hist-1.html' &&
		fetched('sprite.svg?svgdoc'),
	JSON.stringify([result.svg, result.requests]),
);
ok(
	'an XHTML page is served as XHTML, injected, its URLs the real ones',
	result.xhtml.contentType === 'application/xhtml+xml' &&
		result.xhtml.root === 'html' &&
		result.xhtml.title === 'STANDALONE XHTML' &&
		result.xhtml.top === 'self' &&
		result.xhtml.href === `${FIXTURE}pages/standalone.xhtml` &&
		result.xhtml.link === `${FIXTURE}pages/hist-1.html` &&
		result.xhtml.img === `${FIXTURE}pages/sprite.svg?xhtmldoc` &&
		fetched('sprite.svg?xhtmldoc') &&
		fetched('imp.css'),
	JSON.stringify([result.xhtml, result.requests]),
);
await done(browser);
