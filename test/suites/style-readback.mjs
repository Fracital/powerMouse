// What a page reads back about styles and references is its own: computed
// and inline style values show the URLs the page wrote (property, getPropertyValue,
// cssText, the Typed OM's values), an SVG reference's href.baseVal is the
// written value and setting it routes, document.domain accepts the page's
// own host and refuses another like a browser, and a script created from a
// markup string reads back the source the page wrote. Same-origin mode. The
// SVG interfaces the inject hooks `href` on are named in
// src/inject/dom/svgReferences.ts (reading every SVG global made them all in
// each frame): the list is checked against this browser's.
import { readFileSync } from 'node:fs';
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
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
	await window.controller
		.createFrame(element)
		.go(`${fixture}pages/readback-style.html`);
}, FIXTURE);
await sleep(2500);
const frame = page
	.frames()
	.find(
		(f) =>
			f.parentFrame() === page.mainFrame() &&
			/\/stomp\/[\w-]+\/html\//.test(f.url()),
	);
const rb = await frame.evaluate(() => window.__rb);
const own = (value) =>
	typeof value === 'string' &&
	value.includes('sprite.svg') &&
	!value.includes('/stomp/');
ok(
	'computed style values show the URL the page wrote',
	own(rb.computed) && own(rb.computedProperty),
	JSON.stringify([rb.computed, rb.computedProperty]),
);
ok(
	'inline getPropertyValue and cssText show the URL the page wrote',
	own(rb.inlineProperty) && own(rb.inlineCssText),
	JSON.stringify([rb.inlineProperty, rb.inlineCssText]),
);
ok(
	'Typed OM values read back the written URL and a parsed value routes when set',
	own(rb.typed) &&
		own(rb.typedComputed) &&
		typeof rb.typedSet === 'string' &&
		rb.typedSet.includes('hdr.json') &&
		!rb.typedSet.includes('/stomp/'),
	JSON.stringify([rb.typed, rb.typedComputed, rb.typedSet, rb.typedError]),
);
const realUse = await page.evaluate(() =>
	Element.prototype.getAttribute.call(
		window.__el.contentDocument.getElementById('use'),
		'href',
	),
);
const listed = [
	...readFileSync(
		new URL('../../src/inject/dom/svgReferences.ts', import.meta.url),
		'utf8',
	).matchAll(/'(SVG\w+Element)'/g),
]
	.map((match) => match[1])
	.sort();
const native = await page.evaluate(() =>
	Object.getOwnPropertyNames(window)
		.filter(
			(name) =>
				/^SVG\w+Element$/.test(name) &&
				Object.getOwnPropertyDescriptor(window[name].prototype, 'href')?.get,
		)
		.sort(),
);
ok(
	'the inject hooks href on every SVG interface that has one, and only those',
	JSON.stringify(listed) === JSON.stringify(native),
	`listed ${listed.join(' ')}; this browser ${native.join(' ')}`,
);
ok(
	'href.baseVal is the written value and setting it routes',
	rb.baseVal === 'sprite.svg#icon' &&
		rb.animVal === 'sprite.svg#icon' &&
		rb.baseValSet === 'sprite.svg#other' &&
		/\/stomp\/[\w-]+\/binary\//.test(realUse) &&
		realUse.endsWith('#other'),
	JSON.stringify([rb.baseVal, rb.animVal, rb.baseValSet, realUse]),
);
const fixtureHost = new URL(FIXTURE).hostname;
ok(
	'document.domain accepts the own host and refuses another',
	rb.domainSame === fixtureHost && rb.domainOther === 'SecurityError',
	JSON.stringify([rb.domainSame, rb.domainOther]),
);
// a browser never runs a script that arrives in a markup string (the
// fragment parser marks it "already started"); it still reads back as written
ok(
	'a script from a markup string does not run and reads back as written',
	rb.markupRan === undefined &&
		rb.markupText === 'window.__rb.markupRan = top === window;',
	JSON.stringify([rb.markupRan, rb.markupText]),
);
ok(
	'image-set strings are routed and read back as the page wrote them',
	Array.isArray(rb.imageSet) &&
		rb.imageSet.every((v) => /sprite\.svg\?set/.test(v) && !/stomp\//.test(v)),
	JSON.stringify(rb.imageSet),
);

await done(browser);
