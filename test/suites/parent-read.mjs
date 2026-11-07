// What a frame nested in a proxied page reaches through `parent` and `top`,
// in every way the property can be read, and what the proxied page reads of
// its children's framing from the outside. The outermost proxied page is the
// end of the world a nested frame can see: a same-origin child reads it as
// its parent and top, a cross-origin child (the fixture's other host name)
// gets an opaque window that throws SecurityError, and the host never
// appears. Both demo modes, since the same-origin controller and the
// isolated one hand the page different real ancestors.
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
const errors = [];
const origin = new URL(FIXTURE).origin;
const PARENT = 'title:PARENT FRAMES';
const PARENT_FORMS = [
	'parent',
	'windowParent',
	'selfParent',
	'globalThisParent',
	'defaultViewParent',
	'computedParent',
	'reflectParent',
	'destructuredParent',
	'descriptorParent',
];
const allBlank = (blank) =>
	blank?.parentIsSelf === true &&
	blank?.topIsTop === true &&
	blank?.topIsParent === true;

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/parent-frames.html`);
	const result = { children: {} };
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => f.url().includes('/stomp/html'))) {
			const value = await frame
				.evaluate(() => ({ reach: window.__reach, view: window.__parentView }))
				.catch(() => null);
			if (!value) continue;
			if (value.view) result.view = value.view;
			if (value.reach) result.children[value.reach.who] = value.reach;
		}
		if (result.view?.done && result.children.same && result.children.cross)
			break;
	}
	const same = result.children.same ?? {};
	const cross = result.children.cross ?? {};
	const view = result.view ?? {};
	ok(
		`${mode}: a same-origin nested frame reads the proxied page as its parent in every form`,
		PARENT_FORMS.every((form) => same[form] === PARENT) &&
			same.parentLocation === `${FIXTURE}pages/parent-frames.html` &&
			same.frameElement === 'IFRAME#same' &&
			same.parentFramesHasSelf === true,
		JSON.stringify(same),
	);
	ok(
		`${mode}: the proxied page is the top of a same-origin nested frame's world`,
		same.parentParent === PARENT &&
			same.parentTop === PARENT &&
			same.top === PARENT &&
			same.windowTop === PARENT &&
			same.topParent === PARENT &&
			same.topIsParent === true &&
			same.parentParentIsParent === true &&
			same.parentFrameElement === 'null' &&
			same.parentLength === 2 &&
			same.topLength === 2 &&
			allBlank(same.blankParent),
		JSON.stringify(same),
	);
	ok(
		`${mode}: a cross-origin nested frame gets an opaque parent and top that throw SecurityError`,
		PARENT_FORMS.every((form) => cross[form] === 'opaque SecurityError') &&
			cross.parentParent === 'opaque SecurityError' &&
			cross.top === 'opaque SecurityError' &&
			cross.topParent === 'opaque SecurityError' &&
			cross.parentFrameElement === 'threw SecurityError' &&
			cross.parentLocation === 'threw SecurityError' &&
			cross.topIsParent === true &&
			cross.parentParentIsParent === true &&
			cross.parentLength === 2 &&
			cross.topLength === 2 &&
			cross.frameElement === 'null' &&
			allBlank(cross.blankParent),
		JSON.stringify(cross),
	);
	ok(
		`${mode}: ancestorOrigins names the proxied parent's real origin, not the host`,
		JSON.stringify(same.ancestorOrigins) === JSON.stringify([origin]) &&
			JSON.stringify(cross.ancestorOrigins) === JSON.stringify([origin]),
		JSON.stringify([same.ancestorOrigins, cross.ancestorOrigins]),
	);
	ok(
		`${mode}: the proxied page reads its children's framing as the browser would`,
		view.same?.parentIsSelf === true &&
			view.same?.topIsSelf === true &&
			view.same?.framesParentIsSelf === true &&
			view.same?.length === 0 &&
			view.same?.framesIsContentWindow === true &&
			view.same?.framesHasObject === true &&
			view.cross?.parentIsSelf === true &&
			view.cross?.topIsSelf === true &&
			view.cross?.framesParentIsSelf === true &&
			view.cross?.length === 0 &&
			view.cross?.framesIsContentWindow === true &&
			view.cross?.framesHasObject === 'threw SecurityError',
		JSON.stringify(view),
	);
	errors.push(...page.errors);
	await page.close();
}
await done(browser, errors);
