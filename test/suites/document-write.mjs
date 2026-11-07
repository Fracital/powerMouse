// Markup split over several document.write calls (a tag name, an attribute
// value, a script body, a style block, a comment, a textarea) must come out
// as the browser's own parser would see it: one element, with the inline
// script and the URLs rewritten. The fixture's /pages/docwrite.html writes
// each shape and records what the document ended up with.
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
await submitLanding(page, `${FIXTURE}pages/docwrite.html`);

const PAGE = `${FIXTURE}pages/docwrite.html`;
let dw = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		dw = (await frame.evaluate(() => window.__dw)) || {};
	} catch (error) {
		dw = {};
	}
	if (dw.done) break;
}
ok('the page finished loading', dw.done === true, JSON.stringify(dw));

const rewritten = (key) => {
	const r = dw[key];
	ok(
		`${key} script ran rewritten`,
		Array.isArray(r) && r[0] === true && r[1] === PAGE,
		JSON.stringify(r),
	);
};
// '<scr' + 'ipt src=...></scr' + 'ipt>'
rewritten('ext');
// '<script>' + half the body + the rest and the end tag
rewritten('body');
// '<script>' + body, then '</script>' alone
rewritten('bodyEnd');
// '<scr' held while an about:blank child was written and closed
rewritten('inter');

ok(
	'an attribute value split across writes reads back whole',
	dw.splitAttr === '/pages/x.html',
	JSON.stringify(dw.splitAttr),
);
const requests = (dw.requests || []).map((name) => decodeURIComponent(name));
const raw = requests.filter((name) =>
	name.startsWith(`${new URL(PROXY).origin}/pages/`),
);
ok(
	'nothing was fetched from the proxy origin unrouted',
	raw.length === 0,
	raw.join(' '),
);
ok(
	'the image with a split src and the style url() were fetched routed',
	requests.includes(`${FIXTURE}pages/sprite.svg`),
	requests.join(' '),
);
ok(
	'a style block written in pieces applies',
	dw.styled === 'rgb(1, 2, 3)',
	JSON.stringify(dw.styled),
);
ok(
	'a complete write after a partial one keeps both',
	dw.wrap === 'c' && dw.inner === '/pages/y.html' && dw.after === true,
	JSON.stringify([dw.wrap, dw.inner, dw.after]),
);
ok(
	'a comment split across writes stays a comment',
	dw.afterComment === true && !/-->/.test(dw.bodyText || ''),
	JSON.stringify([dw.afterComment, dw.bodyText]),
);
ok(
	'a textarea written in pieces holds its text',
	dw.textarea === '<a href="/x">not a link</a>',
	JSON.stringify(dw.textarea),
);
ok(
	'writeln inside a tag and text split in data work',
	dw.ln === true && dw.p1 === 'hello',
	JSON.stringify([dw.ln, dw.p1]),
);
ok(
	'an element left open across writes holds the next write',
	JSON.stringify(dw.open) ===
		JSON.stringify(['ad', true, '/pages/z.html', true]),
	JSON.stringify(dw.open),
);
ok(
	'an end tag closes the element the writing script is in',
	JSON.stringify(dw.outside) === JSON.stringify([true, true]),
	JSON.stringify(dw.outside),
);
ok(
	'no tag fragments leaked into the body text',
	!/ipt>|">|<scr|\/fragment/.test(dw.bodyText || ''),
	JSON.stringify(dw.bodyText),
);
ok(
	'document.close() flushes a pending tail into the child as the browser would',
	dw.childTail === true && dw.childBody === '<p id="tail">x</p>',
	JSON.stringify([dw.childTail, dw.childBody]),
);
const errors = [
	...(dw.errors || []),
	...page.errors.filter((e) => !/max cycles/.test(e)),
];
ok('no script errors', errors.length === 0, JSON.stringify(errors));

await done(browser);
