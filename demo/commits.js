// The home page's latest commits: /api/commits and its live stream,
// /api/commits/stream (demo/server.js mounts both).
//
// One poller asks GitHub's commits API for the default branch, conditionally
// (If-None-Match with the last ETag), about once a minute while a page
// watches and every ten minutes while none does. Visitors never cause a
// request: /api/commits answers from what the poller last heard, and the
// stream pushes each change to every open page from that one poller.
//
// GitHub's budget: a 304 is free only for a request with an Authorization
// header (docs.github.com, "Best practices for using the REST API",
// conditional requests); without GITHUB_TOKEN every request, 304s
// included, is one of the address's 60 an hour (measured: an
// unauthenticated 304 takes x-ratelimit-remaining down by one). So the
// interval also stretches to what x-ratelimit-remaining leaves until
// x-ratelimit-reset, keeping a few for whatever else shares the address; a
// refusal waits for retry-after or the reset time, and an error backs off
// exponentially. The last answer (list, ETag, avatars, the limit's state)
// is kept on disk, so a restart (every deploy) neither starts empty nor
// asks at once.
//
// This checkout's git log is merged in: it is what is deployed (terp
// deploys a git checkout), the whole answer when GitHub cannot be reached,
// and it marks each of GitHub's commits as deployed or pushed but not
// deployed yet (`deployed`, only when there is a checkout to tell).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const DEFAULT_REPO = 'Fracital/powerMouse';
export const DEFAULT_API = 'https://api.github.com';
const COMMITS = 30;
// how far back this checkout's history is looked through for a commit
// GitHub lists: a deploy more than this far behind marks none deployed
const HISTORY = 1000;
// requests left for anything else on this address before the reset
const RESERVE = 5;
const MAX_BACKOFF = 15 * 60000;
// a page that polls /api/commits instead of streaming counts as watching
// for this long after its last request
const WATCHED_FOR = 3 * 60000;
// a comment this often keeps an idle stream open through fronts that drop
// quiet connections (Cloudflare's is 100 s)
const KEEPALIVE = 25000;
const MAX_STREAMS = 2000;

const run = promisify(execFile);

/**
 * @param {object} options
 * @param {string} options.repo `owner/name`
 * @param {string | undefined} options.token GITHUB_TOKEN
 * @param {string} options.api the API's base URL, or `off` to ask nothing
 * @param {number} options.interval ms between requests while watched
 * @param {string | null} options.checkout a git checkout of `repo`, or null
 */
export function createCommits({ repo, token, api, interval, checkout }) {
	const polling = api !== 'off';
	const apiBase = (api || DEFAULT_API).replace(/\/+$/, '');
	const idle = interval * 10;
	const stateFile = join(
		tmpdir(),
		`stomp-demo-commits2-${repo.replace(/[^\w.-]/g, '_')}${
			apiBase === DEFAULT_API
				? ''
				: `-${createHash('sha256').update(apiBase).digest('hex').slice(0, 8)}`
		}.json`,
	);
	// what GitHub last said: its list, an avatar per author email, its ETag,
	// and where its rate limit stood
	let github = {
		checkedAt: 0,
		retryAt: 0,
		failures: 0,
		etag: null,
		error: null,
		remaining: null,
		reset: 0,
		commits: [],
		avatars: {},
	};
	try {
		github = { ...github, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
	} catch {
		// nothing kept yet
	}

	// ---- this checkout -------------------------------------------------
	let local = { at: 0, commits: null, history: new Set() };
	async function readLocal() {
		if (!checkout) return local;
		let commits = null;
		let history = new Set();
		try {
			const [log, ancestors] = await Promise.all([
				run(
					'git',
					[
						'-C',
						checkout,
						'log',
						`-${COMMITS}`,
						'--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1e',
					],
					{ timeout: 5000 },
				),
				run('git', ['-C', checkout, 'rev-list', `-${HISTORY}`, 'HEAD'], {
					timeout: 5000,
					maxBuffer: 1 << 20,
				}),
			]);
			commits = log.stdout
				.split('\x1e')
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => {
					const [sha, author, email, date, committed, message] =
						line.split('\x1f');
					return { sha, author, email, date, committed, message };
				});
			history = new Set(ancestors.stdout.split('\n').filter(Boolean));
		} catch {
			// no git, or not a checkout
		}
		local = { at: Date.now(), commits, history };
		return local;
	}

	// an author's avatar: GitHub's for that email (the page adds `&s=` for size)
	function avatarOf(email) {
		if (github.avatars[email]) return github.avatars[email];
		const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
		if (noreply)
			return `https://avatars.githubusercontent.com/u/${noreply[1]}?v=4`;
		return email
			? `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}`
			: null;
	}

	// ---- the answer ----------------------------------------------------
	/** the list the pages show: GitHub's newest and this checkout's log,
	 * newest first by commit date (as both order them), each GitHub commit
	 * marked by whether this checkout has it */
	function build() {
		const ours = local.commits?.length ? local.commits : null;
		const theirs = github.commits;
		if (!ours && !theirs.length) return null;
		const known = !!ours;
		const rows = new Map();
		// each row's commit date, which orders them
		const committed = new Map();
		for (const commit of [...theirs, ...(ours ?? [])])
			committed.set(commit.sha, Date.parse(commit.committed) || 0);
		for (const commit of theirs)
			rows.set(commit.sha, {
				sha: commit.sha.slice(0, 7),
				url: commit.url,
				message: commit.message,
				author: commit.author,
				avatar: commit.avatar || avatarOf(commit.email),
				date: commit.date,
				...(known && { deployed: local.history.has(commit.sha) }),
			});
		// this checkout's own rows are the same as with no GitHub at all
		for (const commit of ours ?? [])
			rows.set(commit.sha, {
				sha: commit.sha.slice(0, 7),
				url: `https://github.com/${repo}/commit/${commit.sha}`,
				message: commit.message,
				author: commit.author,
				avatar: avatarOf(commit.email),
				date: commit.date,
				deployed: true,
			});
		const commits = [...rows]
			.sort(([a], [b]) => committed.get(b) - committed.get(a))
			.slice(0, COMMITS)
			.map(([, row]) => row);
		return {
			repo,
			url: `https://github.com/${repo}`,
			commits,
			...(polling && {
				live: { stream: '/api/commits/stream', interval },
			}),
		};
	}
	let answer = null;
	let answerText = '';
	const streams = new Set();
	function update() {
		const next = build();
		const text = JSON.stringify(next);
		if (text === answerText) return;
		answer = next;
		answerText = text;
		if (answer) for (const res of streams) send(res);
	}
	function send(res) {
		res.write(`event: commits\ndata: ${answerText}\n\n`);
	}

	// ---- the poller ----------------------------------------------------
	let lastAsked = 0;
	let polledAt = 0;
	let timer = null;
	let asking = null;
	const watched = () => streams.size > 0 || Date.now() - polledAt < WATCHED_FOR;
	/** when the next request may go out */
	function nextAt() {
		const now = Date.now();
		let at = github.checkedAt + (watched() ? interval : idle);
		if (github.failures)
			at = Math.max(
				at,
				github.checkedAt +
					Math.min(interval * 2 ** github.failures, MAX_BACKOFF),
			);
		// the limit's budget: what is left, spread to its reset
		if (github.remaining !== null && github.reset > now) {
			const spare = github.remaining - (token ? 0 : RESERVE);
			at = Math.max(
				at,
				spare > 0
					? github.checkedAt + (github.reset - github.checkedAt) / spare
					: github.reset + 1000,
			);
		}
		return Math.max(at, github.retryAt, lastAsked + interval / 2);
	}
	function schedule() {
		clearTimeout(timer);
		if (!polling) return;
		timer = setTimeout(
			poll,
			Math.min(Math.max(nextAt() - Date.now(), 0), 2 ** 31 - 1),
		);
		timer.unref();
	}
	async function poll() {
		if (asking) return asking;
		asking = ask().finally(() => {
			asking = null;
			schedule();
		});
		return asking;
	}
	async function ask() {
		lastAsked = Date.now();
		try {
			const response = await fetch(
				`${apiBase}/repos/${repo}/commits?per_page=${COMMITS}`,
				{
					headers: {
						'user-agent': 'stomp-demo',
						accept: 'application/vnd.github+json',
						...(github.etag && { 'if-none-match': github.etag }),
						...(token && { authorization: `Bearer ${token}` }),
					},
					signal: AbortSignal.timeout(8000),
				},
			);
			const now = Date.now();
			github.checkedAt = now;
			const remaining = response.headers.get('x-ratelimit-remaining');
			const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
			github.remaining = remaining === null ? null : Number(remaining);
			github.reset = reset || 0;
			const after = Number(response.headers.get('retry-after')) * 1000;
			if (response.status === 304) {
				github.error = null;
				github.failures = 0;
			} else if (response.ok) {
				const list = await response.json();
				for (const entry of list) {
					const email = entry.commit.author?.email;
					if (email && entry.author?.avatar_url)
						github.avatars[email] = entry.author.avatar_url;
				}
				github.commits = list.map((entry) => {
					const who = entry.commit.author || entry.commit.committer || {};
					return {
						sha: entry.sha,
						url: entry.html_url,
						message: entry.commit.message.split('\n')[0],
						author: who.name || entry.author?.login || 'unknown',
						email: who.email || null,
						avatar: entry.author?.avatar_url || null,
						date: who.date || null,
						committed: entry.commit.committer?.date || who.date || null,
					};
				});
				github.etag = response.headers.get('etag');
				github.error = null;
				github.failures = 0;
			} else {
				// refused (rate limited, 403/429) or failed: retry-after, else
				// the limit's reset when it is spent, else back off (at least a
				// minute, as GitHub asks)
				github.failures++;
				github.retryAt = after
					? now + after
					: github.remaining === 0 && reset > now
						? reset
						: now +
							Math.max(
								60000,
								Math.min(interval * 2 ** github.failures, MAX_BACKOFF),
							);
				github.error = `GitHub answered ${response.status}`;
				// a cut short body is not kept
				await response.body?.cancel().catch(() => {});
			}
			await writeFile(stateFile, JSON.stringify(github)).catch(() => {});
		} catch (error) {
			// unreachable or timed out: back off, the checkout's log answers
			github.checkedAt = Date.now();
			github.failures++;
			github.error = error.message;
		}
		if (Date.now() - local.at > 30000) await readLocal();
		update();
	}
	const ready = (async () => {
		await readLocal();
		update();
		// the first request when the kept answer is old enough: at once on
		// a first start, after the rest of its interval after a restart
		if (polling) {
			if (nextAt() <= Date.now()) await poll();
			else schedule();
		}
	})();

	// ---- the routes ----------------------------------------------------
	/** GET /api/commits */
	async function list(req, res) {
		polledAt = Date.now();
		// a page polling again after a quiet spell: the poller back to its
		// watched pace (this request itself asks GitHub nothing)
		schedule();
		// the first answer, if this server has none yet: at most the first
		// request's own timeout
		if (!answer) await ready;
		else if (checkout && Date.now() - local.at > 30000) {
			await readLocal();
			update();
		}
		if (!answer)
			return res
				.status(502)
				.json({ error: github.error || 'no answer from GitHub yet' });
		res.set('Cache-Control', 'public, max-age=60');
		res.json(answer);
	}
	/** GET /api/commits/stream: Server-Sent Events, one `commits` event
	 * with the current list on connect and one at every change, and a
	 * comment every KEEPALIVE */
	function stream(req, res) {
		if (!polling) return res.sendStatus(404);
		if (streams.size >= MAX_STREAMS) {
			res.set('Retry-After', '60');
			return res.sendStatus(503);
		}
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			// never cached, never compressed or held back by a front:
			// no-transform for Cloudflare, X-Accel-Buffering for nginx
			// (OpenResty), whose proxy buffering would hold every event
			'Cache-Control': 'no-cache, no-store, no-transform',
			'X-Accel-Buffering': 'no',
			Connection: 'keep-alive',
		});
		res.flushHeaders();
		req.socket.setNoDelay(true);
		req.socket.setTimeout(0);
		// a reconnect after a refusal waits at least this long (the page's own
		// backoff decides beyond it)
		res.write('retry: 5000\n\n');
		const first = !streams.size;
		streams.add(res);
		if (answer) send(res);
		if (first) schedule();
		const keepalive = setInterval(
			() => res.write(': keepalive\n\n'),
			KEEPALIVE,
		);
		const close = () => {
			clearInterval(keepalive);
			streams.delete(res);
		};
		res.once('close', close);
	}
	return { list, stream, ready };
}
