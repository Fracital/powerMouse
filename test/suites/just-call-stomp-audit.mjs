// The "just call stomp" audit: where a walk's navigation state escapes, for
// each way of showing a site, and who can see it. Not a gate (it is a
// measurement for the experiment, run by name: `npm test --
// just-call-stomp-audit`); its checks only say each mode ran its walk.
//
// Modes (JCS_MODES, comma separated, default all four):
//   native        the fixture's sites in a tab of their own, no proxy
//   shape         the bare shape of just call stomp with no proxy at all
//                 (test/pages/jcs-shape-host.html): each document written
//                 into a fresh blank frame, history kept by the host. What
//                 the browser records of the shape itself; the pages read
//                 unemulated values there
//   nav           the demo's same-origin page (PROXY): a real frame
//                 navigated to /stomp/<id>/html/<sealed> routes
//   nav-isolated  the demo's isolated page (HOST, proxy on another origin)
//   nav-sealed    nav with the sealed route in the demo's own address
//                 (#html/<sealed>, STOMP_CONFIG.addressFragment 'sealed',
//                 which a framed demo gets): the demo's address as it was
//                 before its tokens (`?N`)
//   jcs           "just call stomp": the demo's ?mode=just-call-stomp
//                 (src/controller/justCallStomp.ts), a fresh frame of the
//                 call page for every document. JCS_QUERY names another
//                 query for it (empty: the mode is skipped). jcs-isolated is
//                 the same on HOST.
//
// The walk, the same in every mode: A1 (127.0.0.1, a frame of its own
// site in it), a link to A2, a pushState, a fragment link, a link to B1
// (localhost, a cross-site frame it makes by script), then the browser's own
// Back and Forward (DevTools' navigateToHistoryEntry, which is the toolbar
// button). B1's URL is only made by A2's script at run time, so its marker
// `visit7Q` in a file of the profile is a copy of the URL.
//
// Observers: the pages' own reports (test/pages/jcs-probe.js), a content
// script's view of every frame (an isolated world: real attributes,
// location, window.name, performance), DevTools (frame tree, the tab's
// navigation history, navigation requests), an extension a school filter
// would install (webNavigation, webRequest main_frame and sub_frame, tabs,
// history), the proxy's service worker (its clients), Chrome's net log, and
// the profile on disk after the browser closed (History, visited_links,
// Sessions, every other file). Each run is a persistent profile of its own,
// with the back/forward cache on as in a user's Chrome.
//
// JCS_AUDIT_OUT=<dir> keeps each mode's full record there as JSON. The walk
// and the table are test/jcs-audit.mjs, which top-url-tokens reads too.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jcsQuery, OUT, rows, runMode } from '../jcs-audit.mjs';
import { done, ok } from '../lib.mjs';

const MODES = (
	process.env.JCS_MODES || 'native,shape,nav,nav-isolated,jcs'
).split(',');

const query = jcsQuery();
const records = [];
for (const mode of MODES) {
	if (mode.startsWith('jcs') && !query) {
		console.log(`SKIP ${mode}: JCS_QUERY is empty`);
		continue;
	}
	console.log(`=== ${mode}`);
	let record;
	try {
		record = await runMode(mode, mode.startsWith('jcs') ? query : null);
	} catch (error) {
		ok(`${mode}: the walk ran`, false, String(error.message).slice(0, 300));
		continue;
	}
	ok(
		`${mode}: the walk reached B1 and its frame`,
		!!record.steps.b1 && !!record.steps.childB1,
		record.errors.join('; ').slice(0, 300),
	);
	if (record.errors.length)
		console.log(`  errors: ${record.errors.join(' | ')}`);
	records.push(record);
}
if (records.length) {
	const table = records.map(rows);
	const names = Object.keys(table[0]);
	const head = ['probe', ...records.map((r) => r.mode)];
	const lines = [
		head,
		...names.map((n) => [n, ...table.map((t) => String(t[n] ?? ''))]),
	];
	console.log('');
	for (const line of lines) console.log(`| ${line.join(' | ')} |`);
	if (OUT)
		writeFileSync(
			join(OUT, 'table.md'),
			lines.map((l) => `| ${l.join(' | ')} |`).join('\n') + '\n',
		);
}
await done(null);
