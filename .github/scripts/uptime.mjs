// Production uptime check, run by .github/workflows/uptime.yml every ten
// minutes and runnable by hand:
//
//   node .github/scripts/uptime.mjs --dry-run   measure and print, nothing else
//   node .github/scripts/uptime.mjs             also open, comment on or close
//                                               the `outage` issue
//
// It reads public URLs only: it never deploys, restarts or logs in anywhere.
// What it checks:
//   - https://stomp.fracit.al/ answers 2xx within UPTIME_TTFB_MS (5 s) to the
//     first byte, and Cloudflare did not serve it STALE (the edge keeps
//     answering from its cache while the origin is down, so a 200 alone
//     proves nothing); a 52x or 504 is Cloudflare failing to reach terp
//   - /api/status with a cache-busting query answers JSON with an uptime
//   - https://holywisp.fracit.al/ (the relay behind wss://holywisp.fracit.al/)
//     answers 200
// A round that fails is measured once more after UPTIME_RETRY_MS (30 s), and
// only a second failure counts, so one dropped packet opens no issue.
//
// Without --dry-run it needs GITHUB_TOKEN (or GH_TOKEN) with issues: write
// and GITHUB_REPOSITORY; GITHUB_API_URL points it at another API (a mock in
// a local test). UPTIME_SITE_URL and UPTIME_WISP_URL point the checks at
// other hosts. Exit 0 healthy, 1 down, 2 the check itself failed.
import { appendFileSync } from 'node:fs';

const env = process.env;
const DRY = process.argv.includes('--dry-run');
const SITE = (env.UPTIME_SITE_URL || 'https://stomp.fracit.al').replace(
	/\/+$/,
	'',
);
const WISP = env.UPTIME_WISP_URL || 'https://holywisp.fracit.al/';
const TTFB_MS = Number(env.UPTIME_TTFB_MS || 5000);
const TIMEOUT_MS = Number(env.UPTIME_TIMEOUT_MS || 20000);
const RETRY_MS = Number(env.UPTIME_RETRY_MS || 30000);
// a comment repeats the same failure at most this often
const REPEAT_MS = Number(env.UPTIME_REPEAT_MS || 60 * 60 * 1000);
const LABEL = 'outage';
const MARK = 'uptime-check';

async function probe(name, url, judge) {
	const started = performance.now();
	const result = { name, url, ok: false, reasons: [] };
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			cache: 'no-store',
			headers: { 'user-agent': 'stomp-uptime-check' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		// fetch settles when the status line and headers are in: the first byte
		result.ttfbMs = Math.round(performance.now() - started);
		result.status = res.status;
		result.cfCacheStatus = res.headers.get('cf-cache-status');
		result.cfRay = res.headers.get('cf-ray');
		const mitigated = res.headers.get('cf-mitigated');
		const body = await res.text();
		if (res.status >= 520 && res.status <= 530)
			result.reasons.push(
				`Cloudflare could not reach the origin (${res.status})`,
			);
		else if (res.status === 504) result.reasons.push('gateway timeout (504)');
		else if (mitigated)
			result.reasons.push(`Cloudflare ${mitigated} the probe (${res.status})`);
		else if (res.status < 200 || res.status > 299)
			result.reasons.push(`status ${res.status}`);
		if (result.ttfbMs > TTFB_MS)
			result.reasons.push(
				`first byte after ${result.ttfbMs} ms (limit ${TTFB_MS})`,
			);
		judge?.(result, body);
	} catch (error) {
		result.ttfbMs = Math.round(performance.now() - started);
		const cause = error?.cause?.code || error?.cause?.message;
		result.reasons.push(
			error?.name === 'TimeoutError'
				? `no answer in ${TIMEOUT_MS} ms`
				: `request failed: ${error?.message}${cause ? ` (${cause})` : ''}`,
		);
	}
	result.ok = result.reasons.length === 0;
	return result;
}

function measure() {
	return Promise.all([
		probe('site', `${SITE}/`, (r) => {
			if (r.cfCacheStatus?.toUpperCase() === 'STALE')
				r.reasons.push('Cloudflare served a STALE copy (origin down)');
		}),
		probe(
			'status',
			`${SITE}/api/status?uptime-check=${Date.now()}`,
			(r, body) => {
				try {
					const json = JSON.parse(body);
					if (typeof json.uptime !== 'number') throw new Error('no uptime');
					r.uptime = json.uptime;
					r.version = json.version;
				} catch {
					if (r.reasons.length === 0)
						r.reasons.push('answer is not the status JSON');
				}
			},
		),
		probe('wisp', WISP, (r) => {
			if (r.status !== 200 && r.reasons.length === 0)
				r.reasons.push(`status ${r.status}, not 200`);
		}),
	]);
}

function duration(seconds) {
	const s = Math.floor(seconds);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function table(round) {
	const rows = round.map((r) => {
		const extra = [
			r.cfCacheStatus && `cf-cache-status ${r.cfCacheStatus}`,
			r.uptime !== undefined &&
				`uptime ${duration(r.uptime)}, version ${r.version}`,
		]
			.filter(Boolean)
			.join(', ');
		const verdict = r.ok ? 'ok' : r.reasons.join('; ');
		return `| ${r.name} | \`${r.url}\` | ${r.status ?? '-'} | ${r.ttfbMs} ms | ${extra || '-'} | ${verdict} |`;
	});
	return [
		'| check | url | status | first byte | details | verdict |',
		'| --- | --- | --- | --- | --- | --- |',
		...rows,
	].join('\n');
}

function report(rounds, at) {
	const run =
		env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
			? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
			: null;
	return [
		`Measured ${at.toISOString()}${run ? ` by [this run](${run})` : ''}.`,
		...rounds.map(
			(round, i) =>
				`\n${rounds.length > 1 ? `Attempt ${i + 1}:\n\n` : ''}${table(round)}`,
		),
	].join('\n');
}

// what is failing, so a comment is made when it changes and not every run
const signature = (round) =>
	round
		.filter((r) => !r.ok)
		.map((r) => `${r.name}:${r.reasons.map((x) => x.split(' ')[0]).join('+')}`)
		.join(',');
const marker = (sig) => `<!-- ${MARK} ${sig} -->`;
const markerOf = (body) =>
	body?.match(new RegExp(`<!-- ${MARK} (\\S*) -->`))?.[1];

async function github(method, path, body) {
	const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(
		/\/+$/,
		'',
	);
	const res = await fetch(`${api}${path}`, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${env.GITHUB_TOKEN || env.GH_TOKEN}`,
			'x-github-api-version': '2022-11-28',
			'user-agent': 'stomp-uptime-check',
			...(body && { 'content-type': 'application/json' }),
		},
		body: body && JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 404 && method === 'GET') return null;
	if (!res.ok)
		throw new Error(
			`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`,
		);
	return res.status === 204 ? null : res.json();
}

async function track(down, rounds, at) {
	const repo = env.GITHUB_REPOSITORY;
	if (!repo || !(env.GITHUB_TOKEN || env.GH_TOKEN))
		throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed');
	const last = rounds.at(-1);
	const sig = signature(last);
	const open = (
		(await github(
			'GET',
			`/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=20`,
		)) ?? []
	).filter((i) => !i.pull_request);
	const issue = open.sort((a, b) => a.number - b.number)[0];

	if (!down) {
		if (!issue) return 'healthy, no open outage issue';
		await github('POST', `/repos/${repo}/issues/${issue.number}/comments`, {
			body: `Healthy again.\n\n${report(rounds, at)}`,
		});
		await github('PATCH', `/repos/${repo}/issues/${issue.number}`, {
			state: 'closed',
			state_reason: 'completed',
		});
		return `healthy, closed #${issue.number}`;
	}

	const failing = last.filter((r) => !r.ok).map((r) => r.name);
	if (!issue) {
		if (!(await github('GET', `/repos/${repo}/labels/${LABEL}`)))
			await github('POST', `/repos/${repo}/labels`, {
				name: LABEL,
				color: 'b60205',
				description: 'Production is down (uptime workflow)',
			});
		const made = await github('POST', `/repos/${repo}/issues`, {
			title: `Production outage: ${failing.join(', ')} failing`,
			labels: [LABEL],
			body: [
				'The uptime workflow (`.github/workflows/uptime.yml`) found production down.',
				'It comments here when what fails changes (and at most hourly while it does not), and closes this issue when every check passes again.',
				'',
				report(rounds, at),
				'',
				marker(sig),
			].join('\n'),
		});
		return `down, opened #${made.number}`;
	}

	// the newest measurement this workflow left on the issue
	const since = new Date(at.getTime() - 3 * REPEAT_MS).toISOString();
	const comments =
		(await github(
			'GET',
			`/repos/${repo}/issues/${issue.number}/comments?since=${since}&per_page=100`,
		)) ?? [];
	const previous = [
		{ body: issue.body, at: issue.created_at },
		...comments.map((c) => ({ body: c.body, at: c.created_at })),
	]
		.filter((c) => markerOf(c.body) !== undefined)
		.at(-1);
	if (
		previous &&
		markerOf(previous.body) === sig &&
		at.getTime() - Date.parse(previous.at) < REPEAT_MS
	)
		return `down, #${issue.number} already says so`;
	await github('POST', `/repos/${repo}/issues/${issue.number}/comments`, {
		body: `Still down (${failing.join(', ')}).\n\n${report(rounds, at)}\n\n${marker(sig)}`,
	});
	return `down, commented on #${issue.number}`;
}

const rounds = [await measure()];
if (rounds[0].some((r) => !r.ok)) {
	await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
	rounds.push(await measure());
}
const down = rounds.at(-1).some((r) => !r.ok);
const at = new Date();
const text = report(rounds, at);
console.log(`${down ? 'DOWN' : 'UP'}\n\n${text}`);
if (env.GITHUB_STEP_SUMMARY)
	appendFileSync(
		env.GITHUB_STEP_SUMMARY,
		`## Production ${down ? 'down' : 'up'}\n\n${text}\n`,
	);
if (!DRY) {
	try {
		console.log(`\n${await track(down, rounds, at)}`);
	} catch (error) {
		console.error(`issue tracking failed: ${error.message}`);
		process.exit(2);
	}
}
process.exit(down ? 1 : 0);
