// The site pool never relaxes the emulated same-origin policy
// (docs/site-pool.md, "Threat model"). The pool shows sites from a few slot
// origins; sites that share a slot (a pool of one slot, more sites than
// slots, a kept assignment) are one origin to the browser, and only the
// emulation keeps them apart, as it keeps every site apart without a pool.
// Each probe runs natively, with the single-origin controller (the demo's
// `?nopool`), with the run's pool (the demo's default), with a pool of one
// slot and with a pool of two (demo servers of this suite's own,
// STOMP_SITE_POOL=1 and 2; the pool of two runs site-pool-sop.html alone),
// and every answer of a pool must be native's or single origin's:
// - window-refs.html, every path to another site's window (window-references);
// - site-pool-sop.html: the window window.open(url) of another site
//   returns, the frame's window the page held while the frame went to a
//   third site (c.localhost, which a pool of two shows from the page's
//   slot), the browser's own `top` getter from the frame, messages a frame
//   of another site posts through the browser's own postMessage past the
//   hooked call (natively from its origin; never from an origin the proxy
//   shows it from), and every URL and origin the documents can read (never
//   a slot's), and the lead of the shell (the hub token, the codec key).
import { spawn } from 'node:child_process';
import { createServer as createNet } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const REFS = `${FIXTURE}pages/window-refs.html`;
const SOP = `${FIXTURE}pages/site-pool-sop.html`;
const OTHER = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const REF_ROLES = ['top', 'child', 'sib', 'popup', 'frameset'];
const SOP_ROLES = ['top', 'child', 'popup'];

const freePort = () =>
	new Promise((resolve, reject) => {
		const probe = createNet();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});

/** a demo server of this suite's own with a pool of `slots` slots */
async function poolServer(slots) {
	const port = await freePort();
	const server = spawn(process.execPath, [`${root}demo/server.js`], {
		env: {
			...process.env,
			PORT: String(port),
			STOMP_SITE_POOL: String(slots),
			// the fixture's third site, c.localhost
			STOMP_TEST_TRANSPORT: '1',
			WISP_ALLOW_LOOPBACK: '1',
			STOMP_ISOLATION: 'off',
			STOMP_SHIELDS_DEFAULTS: '0',
		},
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	process.on('exit', () => server.kill());
	const base = `http://127.0.0.1:${port}/`;
	await waitForServer(`${base}api/status`);
	return base;
}
// a pool of one slot: every site shares it
const ONE = await poolServer(1);
// a pool of two slots: the page's and its frame's sites take one each, and
// a third site the frame goes to is shown from the page's slot
const TWO = await poolServer(2);

/** every report `global` names of the documents of `context`, by role, once `roles` are done */
async function collect(context, global, roles) {
	const reports = {};
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const page of context.pages())
			for (const frame of page.frames()) {
				const value = await frame
					.evaluate((global) => window[global], global)
					.catch(() => null);
				if (value?.role && value.done) reports[value.role] = value;
				// site-pool-sop.html's top opens its popup on a user's click
				else if (global === '__sop' && value?.role === 'top' && !value.clicked)
					await frame.click('#open', { timeout: 1000 }).catch(() => null);
			}
		if (roles.every((role) => reports[role])) break;
	}
	return reports;
}

const browser = await launch();
const nativeContext = await browser.newContext();
const nativeRuns = {};
for (const [name, url, global, roles] of [
	['refs', REFS, '__refs', REF_ROLES],
	['sop', SOP, '__sop', SOP_ROLES],
]) {
	const page = await nativeContext.newPage();
	await page.goto(url);
	nativeRuns[name] = await collect(nativeContext, global, roles);
	for (const other of nativeContext.pages()) await other.close();
}
await nativeContext.close();
ok(
	'natively, every document reports',
	REF_ROLES.every((role) => nativeRuns.refs[role]) &&
		SOP_ROLES.every((role) => nativeRuns.sop[role]),
	JSON.stringify([Object.keys(nativeRuns.refs), Object.keys(nativeRuns.sop)]),
);
ok(
	'natively, the popup window.open(url) returns, and the frame window held while it went to a third site, are restricted, and every post arrives from the frame origin',
	nativeRuns.sop.top?.paths.openURL === 'restricted' &&
		nativeRuns.sop.top.paths.thirdArrived === 'true' &&
		nativeRuns.sop.top.paths.heldThird === 'restricted' &&
		nativeRuns.sop.top.paths.frameThird === 'restricted' &&
		['callRead', 'callCall', 'descriptor', 'hooked'].every((key) =>
			nativeRuns.sop.top.messages.some(
				(message) => message.key === key && message.origin === OTHER,
			),
		),
	JSON.stringify({
		paths: nativeRuns.sop.top?.paths,
		messages: nativeRuns.sop.top?.messages,
		child: nativeRuns.sop.child?.paths,
	}),
);

/** one mode's runs of the fixtures, and the ports its documents are shown from */
async function proxiedRuns(base, fixtures = ['refs', 'sop']) {
	const runs = {};
	let ports = [];
	for (const [name, url, global, roles] of [
		['refs', REFS, '__refs', REF_ROLES],
		['sop', SOP, '__sop', SOP_ROLES],
	]) {
		if (!fixtures.includes(name)) continue;
		const page = await openDemo(browser, base);
		ports = await page.evaluate(() => [
			Number(location.port),
			...(window.STOMP_CONFIG.sitePool ?? []),
		]);
		await submitLanding(page, url);
		runs[name] = await collect(page.context(), global, roles);
		runs.errors = [...(runs.errors ?? []), ...page.errors];
		await page.context().close();
	}
	return { runs, ports };
}

const single = await proxiedRuns(`${PROXY}?nopool`);
const modes = [
	['the run pool', await proxiedRuns(PROXY)],
	['a pool of one slot', await proxiedRuns(ONE)],
	['a pool of two slots', await proxiedRuns(TWO, ['sop'])],
];
const errors = [...single.runs.errors];

/** the keys of `seen` that name one of `ports` on a loopback name */
const leaks = (seen, ports) =>
	Object.keys(seen ?? {}).filter((key) =>
		ports.some((port) =>
			new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(seen[key]),
		),
	);

// the shell's lead (createClient with the config and the codec key, and
// with a pool the hub's message token a forged envelope would need) is
// never in what a document reads of its markup and scripts
const leadIn = (runs) =>
	SOP_ROLES.filter((role) =>
		['markup', 'scriptText', 'globals'].some((key) =>
			/createClient|"token"|"sites"/.test(runs.sop[role]?.seen?.[key] ?? ''),
		),
	);
ok(
	'single origin: no document reads the lead of its shell',
	leadIn(single.runs).length === 0,
	JSON.stringify(leadIn(single.runs)),
);
for (const [mode, { runs, ports }] of modes) {
	ok(
		`${mode}: no document reads the lead of its shell (the hub token, the codec key)`,
		leadIn(runs).length === 0,
		JSON.stringify(leadIn(runs)),
	);
	errors.push(...runs.errors);
	for (const role of runs.refs ? REF_ROLES : []) {
		const nativePaths = nativeRuns.refs[role]?.paths ?? {};
		const singlePaths = single.runs.refs[role]?.paths ?? {};
		const paths = runs.refs[role]?.paths ?? {};
		ok(
			`${mode}: the ${role} document of window-refs reports`,
			!!runs.refs[role],
			JSON.stringify(Object.keys(runs.refs)),
		);
		for (const path of Object.keys(nativePaths))
			ok(
				`${mode}: ${role} ${path} as natively or as with single origin`,
				paths[path] === nativePaths[path] ||
					paths[path] === singlePaths[path] ||
					// a raw window that reaches nothing of the other site: the
					// held frame's old document (window-references HELD)
					(String(singlePaths[path]).startsWith('RAW ') &&
						String(paths[path]).startsWith('RAW ') &&
						!String(paths[path]).includes('REFS')),
				JSON.stringify({
					native: nativePaths[path],
					single: singlePaths[path],
					pool: paths[path],
				}),
			);
	}
	const top = runs.sop.top;
	ok(
		`${mode}: the site-pool-sop documents report`,
		SOP_ROLES.every((role) => runs.sop[role]),
		JSON.stringify(Object.keys(runs.sop)),
	);
	ok(
		`${mode}: the popup window.open(url) of another site returns is as natively or as with single origin`,
		[
			nativeRuns.sop.top?.paths.openURL,
			single.runs.sop.top?.paths.openURL,
		].includes(top?.paths.openURL),
		JSON.stringify({ pool: top?.paths, single: single.runs.sop.top?.paths }),
	);
	ok(
		`${mode}: the frame goes to a third site`,
		top?.paths.thirdArrived === 'true',
		JSON.stringify(top?.paths),
	);
	for (const path of ['heldThird', 'frameThird'])
		ok(
			`${mode}: the frame window held while it went to a third site (${path}) is as natively or as with single origin`,
			top?.paths[path] === nativeRuns.sop.top?.paths[path] ||
				top?.paths[path] === single.runs.sop.top?.paths[path] ||
				// the old document of the page's own origin (window-references HELD)
				(String(top?.paths[path]).startsWith('RAW ') &&
					!String(top?.paths[path]).includes('THIRD')),
			JSON.stringify({
				native: nativeRuns.sop.top?.paths[path],
				single: single.runs.sop.top?.paths[path],
				pool: top?.paths[path],
			}),
		);
	ok(
		`${mode}: a message the frame of another site posts arrives from its origin or not at all`,
		!!top &&
			top.messages.every(
				(message) => message.key === 'third' || message.origin === OTHER,
			) &&
			top.messages.some((message) => message.key === 'hooked'),
		JSON.stringify({
			pool: top?.messages,
			single: single.runs.sop.top?.messages,
		}),
	);
	// the browser's own top getter from the frame of another site, and the
	// frames of that top it can read: never more than single origin hands
	// out (there the raw top is the host's page itself, docs/site-pool.md
	// "Threat model"): the agent of its slot, same-origin with it, is one of
	// that top's frames
	for (const path of ['descriptorTop', 'descriptorTopFrames']) {
		const answers = {
			native: nativeRuns.sop.child?.paths[path],
			single: single.runs.sop.child?.paths[path],
			pool: runs.sop.child?.paths[path],
		};
		ok(
			`${mode}: the frame of another site gets ${path} as natively or as with single origin`,
			answers.pool === answers.native || answers.pool === answers.single,
			JSON.stringify(answers),
		);
	}
	for (const role of SOP_ROLES) {
		const named = leaks(runs.sop[role]?.seen, ports);
		const singleNamed = leaks(single.runs.sop[role]?.seen, single.ports);
		ok(
			`${mode}: the ${role} document reads no origin the proxy shows it from, beyond single origin`,
			named.every((key) => singleNamed.includes(key)),
			JSON.stringify(
				Object.fromEntries(
					named.map((key) => [key, runs.sop[role].seen[key].slice(0, 300)]),
				),
			),
		);
	}
}
await done(browser, errors);
