// Shared by the performance-* suites: a fixture page of test/perf-server.mjs
// records what its Performance APIs show (window.__perf.record), natively a
// few times and through the proxy in both demo modes, and the proxied record
// is compared with the native ones wherever the native runs agree with each
// other: a time, or anything else that changes from one native run to the
// next, is not the proxy's to match.
//
// A difference the architecture cannot close is listed by the suite with its
// reason (`expected`: a pattern over `path: native -> proxied` lines); a
// listed difference that no longer shows fails the suite, so the list cannot
// outlive its reasons.
//
// PERF_DUMP=<path prefix> writes every record to <prefix>-<name>-<mode>.json.
import { writeFileSync } from 'node:fs';
import {
	FIXTURE,
	HOST,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from './lib.mjs';

export const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

let runs = 0;
/** the fixture page `name`, with a run name no earlier load had */
export const pageURL = (name, query = '') =>
	`${FIXTURE}perf/page/${name}?run=${Date.now().toString(36)}${runs++}${query}`;

/** the frame of `page` whose fixture page is `name`, once it says `state` */
async function fixtureFrame(page, name, state, timeout) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(
					([name, state]) =>
						window.__perf?.page === name && !!window.__perf[state],
					[name, state],
				)
				.catch(() => false);
			if (found) return frame;
		}
		await sleep(200);
	}
	return null;
}

const dump = (name, mode, record) => {
	if (process.env.PERF_DUMP)
		writeFileSync(
			`${process.env.PERF_DUMP}-${name}-${mode}.json`,
			JSON.stringify(record, null, '\t'),
		);
};

async function finish(page, name, drive, timeout) {
	if (drive) {
		const frame = await fixtureFrame(page, name, 'ready', timeout);
		if (frame) await drive(page, frame);
	}
	const frame = await fixtureFrame(page, name, 'done', timeout);
	if (!frame) return null;
	return JSON.parse(
		await frame.evaluate(() => JSON.stringify(window.__perf.record)),
	);
}

/**
 * The record of the fixture page `name` loaded natively, in a context of
 * its own (no cache of an earlier run). `drive(page, frame)` runs once the
 * page says it is `ready` (a click, a navigation), `query` is added to the
 * page's URL, `prepare(page)` runs before the page loads (a listener).
 */
export async function nativeRecord(
	browser,
	name,
	{
		drive = null,
		query = '',
		timeout = 60000,
		label = 'native',
		viewport,
		prepare = null,
	} = {},
) {
	const context = await browser.newContext({
		viewport: viewport ?? { width: 1280, height: 720 },
	});
	const page = await context.newPage();
	try {
		if (prepare) await prepare(page);
		await page.goto(pageURL(name, query));
		const record = await finish(page, name, drive, timeout);
		dump(name, label, record);
		return record;
	} finally {
		await context.close();
	}
}

/** the same through the proxy, from the demo at `base` */
export async function proxiedRecord(
	browser,
	base,
	name,
	{
		drive = null,
		query = '',
		timeout = 60000,
		label = 'proxied',
		prepare = null,
	} = {},
) {
	const page = await openDemo(browser, base);
	try {
		if (prepare) await prepare(page);
		await submitLanding(page, pageURL(name, query));
		const record = await finish(page, name, drive, timeout);
		dump(name, label, record);
		return { record, errors: page.errors.slice() };
	} finally {
		await page.context().close();
	}
}

/** every leaf of a record by its path; `raw` members are for reading only */
export function flatten(value, path = '', out = new Map()) {
	if (value && typeof value === 'object') {
		const keys = Object.keys(value);
		if (!keys.length) out.set(path, Array.isArray(value) ? '[]' : '{}');
		for (const key of keys) {
			if (key === 'raw') continue;
			flatten(value[key], path ? `${path}.${key}` : key, out);
		}
		return out;
	}
	out.set(path, JSON.stringify(value) ?? 'undefined');
	return out;
}

/**
 * Where the proxied record differs from the native ones, as
 * `path: native -> proxied` lines: every path the native runs agree on, and
 * every path only the proxied record has (unless a native run has one under
 * the same parent that the others lack: a list that varies natively).
 */
export function differences(natives, proxied) {
	const flats = natives.map((native) => flatten(native));
	const mine = flatten(proxied);
	const [first, ...rest] = flats;
	const lines = [];
	const unstable = new Set();
	for (const flat of flats)
		for (const path of flat.keys())
			if (flats.some((other) => other.get(path) !== flat.get(path)))
				unstable.add(path);
	const unstableUnder = (path) => {
		for (const other of unstable)
			if (parent(other) === parent(path)) return true;
		return false;
	};
	for (const [path, value] of first) {
		if (rest.some((flat) => flat.get(path) !== value)) continue;
		const theirs = mine.get(path);
		if (theirs !== value)
			lines.push(`${path}: ${value} -> ${theirs ?? 'missing'}`);
	}
	for (const [path, value] of mine)
		if (!flats.some((flat) => flat.has(path)) && !unstableUnder(path))
			lines.push(`${path}: missing -> ${value}`);
	return lines;
}
const parent = (path) => path.slice(0, path.lastIndexOf('.'));

/**
 * One check per group of `groups` ([title, pattern over a line's path]) and
 * one for the lines no group takes; `expected` ([pattern over a line,
 * reason]) are the differences the suite lists, each of which must show.
 */
export function report(mode, lines, groups, expected = []) {
	const left = new Set(lines);
	for (const [pattern, reason] of expected) {
		const hit = lines.filter((line) => pattern.test(line));
		for (const line of hit) left.delete(line);
		ok(
			`${mode}: still differs, as listed: ${reason}`,
			hit.length > 0,
			hit.length
				? ''
				: `no difference matches ${pattern}: it reads as native now, take it off the list`,
		);
	}
	for (const [title, pattern] of groups) {
		const hit = [...left].filter((line) =>
			pattern.test(line.slice(0, line.indexOf(': '))),
		);
		for (const line of hit) left.delete(line);
		ok(
			`${mode}: ${title}`,
			hit.length === 0,
			hit.length
				? `${hit.length} differ: ${hit.slice(0, 12).join(' | ').slice(0, 1800)}`
				: '',
		);
	}
	ok(
		`${mode}: nothing else differs from native`,
		left.size === 0,
		[...left].slice(0, 12).join(' | ').slice(0, 1800),
	);
}
