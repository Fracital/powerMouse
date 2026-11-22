// Back/Forward must keep a frame's original history indices even when its
// navigation report arrives before the awaited frame method resolves.
// Firefox can report the destination on either side of that promise.
/* global recordUrl, step, visitHistory:writable */
import { done, HOST, launch, ok, openDemo } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, HOST);

const actual = await page.evaluate(async () => {
	const first = 'https://fixture.test/first';
	const second = 'https://fixture.test/second';
	const results = [];
	const savedVisits = visitHistory;
	visitHistory = null;
	try {
		for (const moment of ['during', 'after', 'from-before-destination']) {
			const frame = {
				url: second,
				title: 'Synthetic page',
				canGoBack: true,
				canGoForward: false,
			};
			const tab = {
				frame,
				history: [first, second],
				index: 1,
				traversal: null,
				pending: Promise.resolve(),
				goingTo: null,
				url: second,
			};
			const backwards = async () => {
				if (moment === 'from-before-destination') recordUrl(tab);
				if (moment !== 'after') {
					frame.url = first;
					recordUrl(tab);
				}
				return true;
			};
			const forwards = async () => {
				if (moment === 'from-before-destination') recordUrl(tab);
				if (moment !== 'after') {
					frame.url = second;
					recordUrl(tab);
				}
				return true;
			};
			frame.back = backwards;
			frame.forward = forwards;
			const wentBack = await step(tab, 'back');
			if (moment === 'after') {
				frame.url = first;
				recordUrl(tab);
			}
			const back = {
				went: wentBack,
				index: tab.index,
				entries: [...tab.history],
				traversal: tab.traversal,
			};
			frame.canGoBack = false;
			frame.canGoForward = true;
			const wentForward = await step(tab, 'forward');
			if (moment === 'after') {
				frame.url = second;
				recordUrl(tab);
			}
			const forward = {
				went: wentForward,
				index: tab.index,
				entries: [...tab.history],
				traversal: tab.traversal,
			};
			results.push({ moment, back, forward });
		}
	} finally {
		visitHistory = savedVisits;
	}
	return results;
});

for (const { moment, back, forward } of actual) {
	ok(
		`${moment}: Back preserves both history entries and its source token`,
		back.went &&
			back.index === 0 &&
			back.traversal === null &&
			JSON.stringify(back.entries) ===
				JSON.stringify([
					'https://fixture.test/first',
					'https://fixture.test/second',
				]),
		JSON.stringify(back),
	);
	ok(
		`${moment}: Forward reuses the second history entry`,
		forward.went &&
			forward.index === 1 &&
			forward.traversal === null &&
			JSON.stringify(forward.entries) ===
				JSON.stringify([
					'https://fixture.test/first',
					'https://fixture.test/second',
				]),
		JSON.stringify(forward),
	);
}

// Back can step between two distinct entries with the exact same URL. A
// completed step must not leave the pending-traversal marker behind: a later
// navigation to a different URL must become a new entry, not overwrite the
// back entry.
const duplicateUrl = await page.evaluate(async () => {
	const same = 'https://fixture.test/same';
	const next = 'https://fixture.test/new';
	const savedVisits = visitHistory;
	visitHistory = null;
	try {
		const frame = {
			url: same,
			title: 'Same URL',
			canGoBack: true,
			canGoForward: false,
			back: async () => true,
		};
		const tab = {
			frame,
			history: [same, same],
			index: 1,
			traversal: null,
			pending: Promise.resolve(),
			goingTo: null,
			url: same,
		};
		await step(tab, 'back');
		const afterBack = {
			index: tab.index,
			pending: tab.traversal !== null,
		};
		frame.url = next;
		recordUrl(tab);
		return {
			afterBack,
			index: tab.index,
			history: [...tab.history],
			pending: tab.traversal !== null,
		};
	} finally {
		visitHistory = savedVisits;
	}
});
ok(
	'a Back step between duplicate URLs does not corrupt the next navigation',
	duplicateUrl.afterBack.index === 0 &&
		!duplicateUrl.afterBack.pending &&
		duplicateUrl.index === 1 &&
		JSON.stringify(duplicateUrl.history) ===
			JSON.stringify([
				'https://fixture.test/same',
				'https://fixture.test/new',
			]) &&
		!duplicateUrl.pending,
	JSON.stringify(duplicateUrl),
);

await done(browser);
