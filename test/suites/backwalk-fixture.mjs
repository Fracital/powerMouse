// Back, step by step, over fixture pages with internal links: the same walk
// as backwalk-single without the network, so it is deterministic and fast.
// Five pages reached by clicking links inside the frame, then Back must
// revisit them in reverse and end on the landing, never leaving the host.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	omni,
	onLanding,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

const frame = () =>
	page.frames().findLast((f) => f.url().includes('/stomp/html/'));
const waitOmni = (pred) =>
	page.waitForFunction(
		(src) =>
			new Function('v', `return (${src})(v)`)(
				document.querySelector('#omni input').value,
			),
		pred.toString(),
		{ timeout: 20000 },
	);

await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
await waitOmni((v) => v.endsWith('/pages/walk-1.html'));
await sleep(800);
const trail = [await omni(page)];
for (let n = 2; n <= 5; n++) {
	for (let i = 0; i < 40; i++) {
		try {
			if (await frame().evaluate((n) => document.title === `WALK ${n}`, n - 1))
				break;
		} catch (error) {
			// navigating
		}
		await sleep(250);
	}
	await frame().evaluate(() => document.getElementById('next').click());
	await waitOmni(
		new Function('v', `return v.endsWith('/pages/walk-${n}.html')`),
	);
	await sleep(800);
	trail.push(await omni(page));
}
ok(
	'five pages visited by in-frame links',
	new Set(trail).size === 5,
	trail.map((u) => u.slice(-11)).join(' '),
);

async function pressBack() {
	const before = await omni(page);
	await page.click('#back');
	await page
		.waitForFunction(
			(b) =>
				document.querySelector('#omni input').value !== b ||
				!document.getElementById('landing').classList.contains('hidden'),
			before,
			{ timeout: 15000 },
		)
		.catch(() => {});
	await sleep(500);
	return { omni: await omni(page), landing: await onLanding(page) };
}

const expected = [...trail].reverse().slice(1);
for (let i = 0; i < expected.length; i++) {
	const r = await pressBack();
	ok(
		`back ${i + 1} -> ${expected[i].slice(-11)}`,
		r.omni === expected[i] && !r.landing,
		`${r.omni.slice(-11)} landing=${r.landing}`,
	);
}
for (let i = 0; i < 3; i++) {
	const r = await pressBack();
	ok(
		`back ${expected.length + i + 1} -> landing`,
		r.landing,
		`omni=${r.omni.slice(-11)}`,
	);
}
ok('host page never left', page.url().startsWith(HOST), page.url());
ok(
	'tab still open',
	await page.evaluate(() => document.querySelectorAll('.frame').length === 1),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
