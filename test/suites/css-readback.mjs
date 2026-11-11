// What a page reads back from its stylesheets is what it wrote: a rule's
// cssText and style, a sheet's href, a style element's text and markup, a
// rule inserted or constructed at runtime, and a style attribute the browser
// serialised from a CSSOM write all show the page's url()s, never the routed
// ones the rewriter put there.
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
await submitLanding(page, `${FIXTURE}pages/css-readback.html`);
let css = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		css = (await frame.evaluate(() => window.__css)) || {};
	} catch (error) {
		css = {};
	}
	if (css.done) break;
}
const leaks = (value) => /stomp\/|#url/.test(JSON.stringify(value));
// the page's token comes back as written; the browser would quote it
const plain = (value) => String(value).replace(/url\("([^"]*)"\)/g, 'url($1)');
ok(
	"a rule's cssText and style show the page's url()",
	plain(css.ruleText) === '#bg { background-image: url(/pages/sprite.svg); }' &&
		plain(css.ruleStyle) === 'url(/pages/sprite.svg)',
	JSON.stringify([css.ruleText, css.ruleStyle]),
);
ok(
	"a style element's text and outerHTML are the page's",
	/url\(\/pages\/sprite\.svg\)/.test(css.styleText) &&
		!leaks(css.styleText) &&
		!leaks(css.styleOuter),
	JSON.stringify([css.styleText, css.styleOuter]),
);
ok(
	'stylesheet hrefs are the real URLs',
	JSON.stringify(css.sheetHrefs) ===
		JSON.stringify([
			`${FIXTURE}pages/imp.css`,
			`${FIXTURE}pages/bad.css.bin`,
			null,
		]) && css.linkSheetHref === `${FIXTURE}pages/imp.css`,
	JSON.stringify([css.sheetHrefs, css.linkSheetHref]),
);
ok(
	'inserted and constructed rules read back as written',
	plain(css.inserted) === '#ins { background: url(/pages/sprite.svg); }' &&
		JSON.stringify(css.constructed.map(plain)) ===
			JSON.stringify([
				'#con { background-image: url(/pages/sprite.svg); }',
				'url(/pages/sprite.svg)',
			]),
	JSON.stringify([css.inserted, css.constructed]),
);
ok(
	'a style attribute serialised from a CSSOM write reads back unrouted',
	plain(css.inline?.[0]) === 'background-image: url(/pages/sprite.svg);' &&
		!leaks(css.inline),
	JSON.stringify(css.inline),
);
ok(
	// natively a computed url() is absolute (url-shapes measures it)
	'the computed value is the page url, absolute as natively (the image loads through the proxy)',
	plain(css.computed) === `url(${FIXTURE}pages/sprite.svg)`,
	JSON.stringify(css.computed),
);

await done(browser, page.errors);
