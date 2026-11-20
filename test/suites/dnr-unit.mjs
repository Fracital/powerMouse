// chrome.declarativeNetRequest semantics (src/extensions/dnr), in node,
// against the rows of test/dnr/cases.mjs: one check per row Chrome 157
// answered natively (urlFilter matching, isRegexSupported, rule validation
// on install and on update, testMatchOutcome). A match row also checks the
// request path for what testMatchOutcome does not report: the redirect
// target and the request and response headers after modifyHeaders. Rows
// marked native: false (several extensions, frame chains, withheld host
// access) run through the request path too but are not checks: their
// count is printed, and DNR_UNIT_VERBOSE=1 lists the ones that differ.
// Skips when esbuild is not installed, as the other unit suites do.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
	matchCases,
	regexCases,
	urlFilterCases,
	validationCases,
} from '../dnr/cases.mjs';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP dnr-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}dnr-unit-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/extensions/dnr/index.ts`)};`,
);
const bundle = `${OUT}dnr-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { DnrEngine, compileStatic } = await import(`${bundle}?${Date.now()}`);

const VERBOSE = !!process.env.DNR_UNIT_VERBOSE;
const show = (value) => {
	const text = JSON.stringify(value);
	return text && text.length > 400 ? `${text.slice(0, 400)}...` : text;
};
const base = (id) => `chrome-extension://${id}/`;
// the oracle's unpacked extensions name their rulesets' files rs<n>.json
const stripFile = (message) =>
	typeof message === 'string' ? message.replace(/^rs\d+\.json: /, '') : message;

/** an engine with the extensions of a row installed, in the row's install order */
async function engineFor(extensions, onDebug) {
	const access = new Map(
		extensions.map((ext) => [ext.id, ext.hostAccess ?? 'allowed']),
	);
	const engine = new DnrEngine({
		access: (extensionId) => access.get(extensionId) ?? 'allowed',
		debug: onDebug,
	});
	const errors = [];
	for (const [index, ext] of extensions.entries()) {
		const extensionBase = base(ext.id);
		const staticRulesets = (ext.rulesets ?? []).map((ruleset, at) => {
			const result = compileStatic(ruleset.rules, {
				extensionBase,
				path: `rs${at}.json`,
				rulesetId: at + 1,
			});
			if (result.error) errors.push(`load: ${result.error}`);
			return {
				id: ruleset.id,
				enabled: ruleset.enabled !== false,
				ruleset: result.ruleset,
			};
		});
		engine.install({
			id: ext.id,
			installTime: index + 1,
			extensionBase,
			staticRulesets,
			permissions: {
				declarativeNetRequest:
					ext.permission !== 'declarativeNetRequestWithHostAccess',
				declarativeNetRequestFeedback: true,
			},
			state: {
				dynamicRules: ext.dynamic ?? [],
				disabledRuleIds: ext.disabledRuleIds ?? {},
			},
		});
		if (ext.dynamic?.length) {
			const kept = await engine.getDynamicRules(ext.id);
			if (kept.length !== ext.dynamic.length)
				errors.push(`dynamic: ${kept.length} of ${ext.dynamic.length} kept`);
		}
		if (ext.session?.length)
			await engine
				.updateSessionRules(ext.id, { addRules: ext.session })
				.catch((error) => errors.push(`session: ${error.message}`));
	}
	return { engine, errors };
}

const extensionsOf = (row) =>
	row.rules
		? [{ id: 'ext1', rulesets: [{ id: 'ruleset', rules: row.rules }] }]
		: row.extensions;

/** a HeaderList over [name, value] pairs, names case-insensitive */
function headerList(pairs) {
	const map = new Map();
	for (const [name, value] of pairs) {
		const key = name.toLowerCase();
		map.set(key, map.has(key) ? `${map.get(key)}, ${value}` : value);
	}
	return {
		map,
		get: (name) => map.get(name.toLowerCase()) ?? null,
		has: (name) => map.has(name.toLowerCase()),
		set: (name, value) => map.set(name.toLowerCase(), value),
		delete: (name) => map.delete(name.toLowerCase()),
	};
}

// header lists compared by name, in their order within a name
const byName = (pairs) =>
	pairs
		.map(([name, value], at) => [name.toLowerCase(), value, at])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]))
		.map(([name, value]) => [name, value]);

const responseLines = (headers) =>
	Object.entries(headers ?? {}).flatMap(([name, values]) =>
		values.length ? values.map((value) => [name, value]) : [[name, '']],
	);

const canon = (url) => {
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
};

/**
 * The request path over one row: beforeRequest, beforeSendHeaders (over the
 * row's headers before DNR) and headersReceived (over its response headers)
 */
function requestPath(engine, row, frame) {
	const request = row.request;
	const out = { problems: [] };
	const { state, outcome } = engine.beforeRequest({
		url: request.url,
		initiator: request.initiator ?? null,
		type: request.type,
		method: request.method,
		tabId: request.tabId,
		topUrl: request.topUrl ?? null,
		frame,
	});
	out.outcome = outcome;
	if (outcome.type !== 'none') return out;
	const sendList = headerList(row.expect.requestHeaders?.before ?? []);
	engine.beforeSendHeaders(state, sendList);
	out.requestHeaders = [...sendList.map];
	const before =
		row.expect.responseHeaders?.before ??
		responseLines(request.responseHeaders);
	const after = engine.headersReceived(state, before);
	if (after.outcome.type !== 'none') out.outcome = after.outcome;
	else out.responseHeaders = after.lines ?? before;
	return out;
}

/** what the request path's result says against the row's redirect and header expectations */
function pathProblems(row, path) {
	const problems = [];
	const expect = row.expect;
	if (expect.redirectUrl !== undefined) {
		const seen =
			path.outcome.type === 'redirect' ? path.outcome.redirectUrl : null;
		if (canon(seen) !== canon(expect.redirectUrl))
			problems.push(
				`redirectUrl expected ${expect.redirectUrl} got ${seen ?? `outcome ${path.outcome.type}`}`,
			);
	}
	if (expect.requestHeaders && path.requestHeaders) {
		const want = byName([...headerList(expect.requestHeaders.after).map]);
		const got = byName(path.requestHeaders);
		if (!isDeepStrictEqual(want, got))
			problems.push(`requestHeaders expected ${show(want)} got ${show(got)}`);
	}
	if (expect.responseHeaders && path.responseHeaders) {
		const want = byName(expect.responseHeaders.after);
		const got = byName(path.responseHeaders);
		if (!isDeepStrictEqual(want, got))
			problems.push(`responseHeaders expected ${show(want)} got ${show(got)}`);
	}
	if (
		(expect.requestHeaders || expect.responseHeaders) &&
		path.outcome.type !== 'none'
	)
		problems.push(`headers expected, request ${path.outcome.type}`);
	return problems;
}

// --- urlFilter rows: one block rule, a request of type 'other' ------------
{
	const engine = new DnrEngine();
	engine.install({ id: 'ext1', extensionBase: base('ext1') });
	for (const row of urlFilterCases) {
		if (row.native === false) continue;
		const condition = { urlFilter: row.urlFilter };
		if (row.isUrlFilterCaseSensitive !== undefined)
			condition.isUrlFilterCaseSensitive = row.isUrlFilterCaseSensitive;
		let actual;
		try {
			await engine.updateSessionRules('ext1', {
				removeRuleIds: [1],
				addRules: [{ id: 1, action: { type: 'block' }, condition }],
			});
			actual =
				engine.beforeRequest({ url: row.url, type: 'other' }).outcome.type ===
				'block';
		} catch (error) {
			actual = { error: error.message };
		}
		ok(
			`urlFilter: ${row.name}`,
			actual === row.expect,
			`expected ${row.expect} got ${show(actual)}`,
		);
	}
}

// --- regex rows: isRegexSupported ------------------------------------------
{
	const engine = new DnrEngine();
	for (const row of regexCases) {
		const options = { regex: row.regex };
		if (row.isCaseSensitive !== undefined)
			options.isCaseSensitive = row.isCaseSensitive;
		if (row.requireCapturing !== undefined)
			options.requireCapturing = row.requireCapturing;
		const actual = await engine.isRegexSupported(options);
		const want = { isSupported: row.expect.isSupported };
		if (row.expect.reason !== undefined) want.reason = row.expect.reason;
		const got = { isSupported: actual.isSupported };
		if (actual.reason !== undefined) got.reason = actual.reason;
		ok(
			`regex: ${row.name}`,
			isDeepStrictEqual(want, got),
			`expected ${show(want)} got ${show(got)}`,
		);
	}
}

// --- validation rows: install, updateDynamicRules, updateSessionRules -------
function rulesOf(row) {
	if (row.rules) return row.rules;
	if (row.count === undefined) return [row.rule];
	return Array.from({ length: row.count }, (_, at) => ({
		...row.rule,
		id: at + 1,
	}));
}

/** the oracle's verdict over { error?, warnings?, enabled? } */
function validationAgrees(row, actual) {
	const fails =
		row.expectError !== null &&
		row.expectError !== undefined &&
		!row.expectWarning;
	if (row.expectWarning) {
		const warnings = (actual.warnings ?? []).map(stripFile);
		if (actual.error || !warnings.length) return false;
		return row.message === undefined || warnings.includes(row.message);
	}
	if (
		row.expectEnabledRulesets &&
		!isDeepStrictEqual(actual.enabled, row.expectEnabledRulesets)
	)
		return false;
	if (!fails) return !actual.error && !(actual.warnings ?? []).length;
	if (!actual.error) return false;
	return row.message === undefined || stripFile(actual.error) === row.message;
}

for (const row of validationCases) {
	if (row.native === false) continue;
	const kind = row.rulesetKind ?? 'static';
	const rules = rulesOf(row);
	const engine = new DnrEngine();
	let actual;
	if (kind === 'dynamic' || kind === 'session') {
		engine.install({ id: 'ext1', extensionBase: base('ext1') });
		const update =
			kind === 'dynamic' ? 'updateDynamicRules' : 'updateSessionRules';
		actual = await engine[update]('ext1', { addRules: rules }).then(
			() => ({}),
			(error) => ({ error: error.message }),
		);
	} else {
		const sets = row.rulesetCount ?? 1;
		const enabled = row.enabledRulesetCount ?? sets;
		const warnings = [];
		let error;
		const staticRulesets = Array.from({ length: sets }, (_, at) => {
			const result = compileStatic(rules, {
				extensionBase: base('ext1'),
				path: `rs${at}.json`,
				rulesetId: at + 1,
			});
			warnings.push(...result.warnings);
			if (result.error && error === undefined) error = result.error;
			return {
				id: sets === 1 ? 'ruleset' : `ruleset_${at + 1}`,
				enabled: at < enabled,
				ruleset: result.ruleset,
			};
		});
		if (error !== undefined) actual = { error };
		else {
			try {
				warnings.push(
					...engine.install({
						id: 'ext1',
						extensionBase: base('ext1'),
						staticRulesets,
						permissions: { declarativeNetRequest: true },
					}),
				);
				actual = {
					warnings,
					enabled: await engine.getEnabledRulesets('ext1'),
				};
			} catch (installError) {
				actual = { error: installError.message, warnings };
			}
		}
	}
	const shown = { ...actual };
	if (row.expectEnabledRulesets === undefined) delete shown.enabled;
	ok(
		`validation: ${row.name}`,
		validationAgrees(row, actual),
		`expected ${show({ expectError: row.expectError, message: row.message, expectWarning: row.expectWarning, expectEnabledRulesets: row.expectEnabledRulesets })} got ${show(shown)}`,
	);
}

// --- match rows ------------------------------------------------------------
const informational = { checked: 0, agree: 0, differ: [] };
for (const row of matchCases) {
	const extensions = extensionsOf(row);
	if (row.native) {
		const { engine, errors } = await engineFor(extensions);
		const ext = extensions[0].id;
		const problems = [...errors];
		const want = row.expect.matched.map(({ ruleId, rulesetId }) => ({
			ruleId,
			rulesetId,
		}));
		let got;
		try {
			got = (await engine.testMatchOutcome(ext, row.request)).matchedRules.map(
				({ ruleId, rulesetId }) => ({ ruleId, rulesetId }),
			);
		} catch (error) {
			got = { error: error.message };
		}
		if (!isDeepStrictEqual(want, got))
			problems.push(`matched expected ${show(want)} got ${show(got)}`);
		try {
			problems.push(...pathProblems(row, requestPath(engine, row, null)));
		} catch (error) {
			problems.push(`request path threw ${error.message}`);
		}
		ok(`match: ${row.name}`, !problems.length, problems.join('; '));
		continue;
	}
	// not native: the request path, its matches as onRuleMatchedDebug reports them
	informational.checked++;
	const matched = [];
	const problems = [];
	try {
		const { engine, errors } = await engineFor(
			extensions,
			(extensionId, info) => matched.push({ extensionId, ...info.rule }),
		);
		problems.push(...errors);
		let frame = null;
		const frames = row.frames ?? [];
		const originOf = (url) => {
			try {
				return new URL(url).origin;
			} catch {
				return null;
			}
		};
		frames.forEach((entry, at) => {
			engine.onNavigationCommitted({
				frame: `f${at}`,
				parent: at ? `f${at - 1}` : null,
				url: entry.url,
				origin: originOf(entry.url),
				parentOrigin: at ? originOf(frames[at - 1].url) : null,
				topOrigin: originOf(frames[0].url),
				isPost: entry.method === 'post',
				// a committed document always has its response's lines (empty when the row gives none)
				responseHeaders: responseLines(entry.responseHeaders),
			});
			frame = `f${at}`;
		});
		const request = row.frames
			? {
					...row.request,
					initiator:
						row.request.initiator ??
						(row.request.type === 'main_frame'
							? undefined
							: originOf(frames[frames.length - 1].url)),
					topUrl:
						row.request.topUrl ??
						(row.request.type === 'main_frame' ? undefined : frames[0].url),
				}
			: row.request;
		const path = requestPath(
			engine,
			{ ...row, request },
			row.request.type === 'main_frame' ? null : frame,
		);
		problems.push(...pathProblems(row, path));
	} catch (error) {
		problems.push(`threw ${error.message}`);
	}
	const single = extensions.length === 1;
	const key = (m) =>
		`${single ? '' : `${m.extensionId}/`}${m.rulesetId}/${m.ruleId}`;
	const want = row.expect.matched.map(key).sort();
	const got = [...new Set(matched.map(key))].sort();
	if (!isDeepStrictEqual(want, got))
		problems.push(`matched expected ${show(want)} got ${show(got)}`);
	if (problems.length) informational.differ.push([row.name, problems]);
	else informational.agree++;
}
console.log(
	`not native (request path, not checks): ${informational.agree}/${informational.checked} agree`,
);

// two main frames of no known tab at once (navigations no hooked document
// announced): each one's matches are held for its own document, and go to
// the tab that document is placed in, whichever is placed first
{
	const { engine } = await engineFor([
		{
			id: 'held',
			rulesets: [
				{
					id: 'r',
					rules: [
						{
							id: 1,
							action: { type: 'allow' },
							condition: {
								urlFilter: '||one.example^',
								resourceTypes: ['main_frame'],
							},
						},
						{
							id: 2,
							action: { type: 'block' },
							condition: {
								urlFilter: '||two.example^',
								resourceTypes: ['main_frame'],
							},
						},
					],
				},
			],
		},
	]);
	const navigate = (url, held) =>
		engine.beforeRequest({
			url,
			initiator: null,
			type: 'main_frame',
			method: 'get',
			tabId: -1,
			held,
			topUrl: url,
			frame: null,
		});
	navigate('https://one.example/', 'c1');
	navigate('https://two.example/', 'c2');
	engine.onMainFramePlaced(8, 'c2');
	engine.onMainFramePlaced(7, 'c1');
	const rules = async (tabId) =>
		(
			await engine.getMatchedRules('held', { tabId }, true)
		).rulesMatchedInfo.map((info) => `${info.rule.ruleId}@${info.tabId}`);
	const placed = {
		7: await rules(7),
		8: await rules(8),
		none: await rules(-1),
	};
	ok(
		"overlapping main frames of no known tab: each one's matches go to the tab its document is placed in",
		placed[7].join() === '1@7' &&
			placed[8].join() === '2@8' &&
			!placed.none.length,
		JSON.stringify(placed),
	);
}
if (VERBOSE)
	for (const [name, problems] of informational.differ)
		console.log(`INFO ${name} - ${problems.join('; ')}`);

await done();
