// What frameworks read back from the DOM must look like what the page wrote:
// no marker attributes in getAttributeNames / hasAttribute / attributes,
// innerHTML and outerHTML serialise the page's own URLs, attribute selectors
// match the page's values, and nodes that arrive from setAttributeNS, SVG
// hrefs, DOMParser or createContextualFragment are routed too.
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
await submitLanding(page, `${FIXTURE}pages/dom.html`);

let dom = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		dom = (await frame.evaluate(() => window.__dom)) || {};
	} catch (error) {
		dom = {};
	}
	if (dom.done) break;
}
ok(
	'getAttributeNames hides the markers',
	JSON.stringify(dom.names) === '["id","href"]',
	JSON.stringify(dom.names),
);
ok(
	'hasAttribute hides the markers',
	dom.hasMarker === false,
	JSON.stringify(dom.hasMarker),
);
ok(
	'attributes has the page attributes only',
	dom.attributesLength === 2,
	JSON.stringify(dom.attributesLength),
);
ok(
	'Attr.value is the page value',
	dom.attrNode === '/x',
	JSON.stringify(dom.attrNode),
);
ok(
	'innerHTML reads back what the page wrote',
	dom.innerHTML === '<a id="a" href="/x">x</a>',
	JSON.stringify(dom.innerHTML),
);
ok(
	'outerHTML reads back what the page wrote',
	dom.outerHTML === '<a id="a" href="/x">x</a>',
	JSON.stringify(dom.outerHTML),
);
ok(
	'attribute selector with the page value matches',
	dom.selectorExact === true && dom.matches === true,
	JSON.stringify([dom.selectorExact, dom.matches]),
);
ok(
	'prefix attribute selector matches',
	dom.selectorPrefix === true,
	JSON.stringify(dom.selectorPrefix),
);
ok(
	'setAttributeNS shows the page value',
	dom.nsView === '/pages/echo.json?ns',
	JSON.stringify(dom.nsView),
);
const requests = (dom.requests || []).map((name) => decodeURIComponent(name));
const proxyOrigin = new URL(PROXY).origin;
const raw = requests.filter((name) => name.startsWith(`${proxyOrigin}/pages/`));
ok(
	'nothing was fetched from the proxy origin unrouted',
	raw.length === 0,
	raw.join(' '),
);
// routed URLs are codec-encoded, so the originals cannot be matched by
// substring: count the routed binary fetches instead (three images, the
// SVG sprite) with no raw fetch left
// the page reads its own URLs back from performance entries (readback
// suite): a routed fetch resolves to the fixture origin (three images, the
// SVG sprite), a raw one would have hit the proxy origin, checked above
const routed = requests.filter((name) => name.startsWith(`${FIXTURE}pages/`));
ok(
	'setAttributeNS, DOMParser, createContextualFragment nodes and the SVG sprite are routed',
	routed.length >= 4,
	`${routed.length} routed fetches`,
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
