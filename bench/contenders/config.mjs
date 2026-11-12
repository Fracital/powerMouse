// What every adapter shares for reading its contender's setup from
// bench/configs/<id>.json, the single source of what is pinned and how it is
// configured: the adapters and their host pages take their values from it.
import { readFileSync } from 'node:fs';

/** the stand-in for the harness's holyWisp URL, filled in at start */
export const HARNESS_WISP = '<harness holyWisp>';

/** bench/configs/<id>.json */
export function loadConfig(id) {
	return JSON.parse(
		readFileSync(new URL(`../configs/${id}.json`, import.meta.url), 'utf8'),
	);
}

/** `value` with every HARNESS_WISP string replaced by the run's wisp URL */
export function withWisp(value, wispUrl) {
	if (value === HARNESS_WISP) return wispUrl;
	if (Array.isArray(value)) return value.map((item) => withWisp(item, wispUrl));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				withWisp(item, wispUrl),
			]),
		);
	return value;
}

/** a note with `{name}` replaced by values[name] (values known at run time) */
export const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, name) =>
		name in values ? String(values[name]) : match,
	);

/** an express handler serving `window.BENCH_CONFIG = <value>` for a host page */
export const configScript = (value) => (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.type('application/javascript');
	res.send(`window.BENCH_CONFIG = ${JSON.stringify(value)};\n`);
};

/** the response headers a host server sends on every response */
export const headers = (values) => (req, res, next) => {
	res.set(values);
	next();
};
