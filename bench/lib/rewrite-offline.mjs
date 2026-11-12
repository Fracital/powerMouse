// Offline rewrite throughput: each contender's JavaScript rewriter run
// standalone in Node (no browser, no proxy path) over the rewrite corpus
// (bench/lib/scripts.mjs), called the way its proxy calls it for a script
// response. MB/s is input source bytes (1e6) per second of rewriting.
//
// Fairness: every row runs in a child process of its own on the same Node
// (process.execPath, the same flags), so no row's heap or JIT state lands
// on another's; the children stay up for the whole run, and each repeat
// asks every row for one pass over the corpus in turn (A B C D E, A B C D E,
// ...). A warm-up pass comes first and is not counted. Each pass starts
// with a full GC. The rewriter's own call is timed, with its input in the
// form the proxy holds it in (a string, or bytes where the proxy hands it
// bytes); fetching, decoding and serving are not.
//
// A script a rewriter fails (it throws, answers nothing usable or hands the
// script back unrewritten) is recorded per script and left out of that
// row's bytes and time; `common` gives every row's MB/s over the scripts
// every row rewrote.
//
// CLI: node bench/lib/rewrite-offline.mjs --cache <dir> [--repeats 5]
//      [--contenders <dir>] [--rows a,b] [--pkg <row>=<dir>] [--json <file>]
import { fork } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const ROWS = [
	'stomp-js',
	'stomp-wasm',
	'scramjet',
	'ultraviolet',
	'stompv1',
	'powermouse-v1',
];

/** the address every corpus script is rewritten as (the fixture server's, as the in-browser scenario loads it) */
const scriptURL = (id) => `http://a.bench.test:8000/rewrite/scripts/${id}.js`;
/** the proxy's own origin, where a rewriter asks for one */
const PROXY_ORIGIN = 'http://127.0.0.1:8080';

const SELF = fileURLToPath(import.meta.url);
/** the flags every row's process runs with */
const CHILD_FLAGS = ['--expose-gc', '--max-old-space-size=8192'];

/**
 * `{ median, min, max, p25, p75, n, runs, dnf }` of a list of numbers
 * (linear interpolation between ranks)
 *
 * @param {number[]} runs
 * @param {number} [dnf]
 */
export function stat(runs, dnf = 0) {
	const sorted = [...runs].sort((a, b) => a - b);
	const at = (q) => {
		if (!sorted.length) return null;
		const rank = (sorted.length - 1) * q;
		const low = Math.floor(rank);
		const high = Math.ceil(rank);
		return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
	};
	return {
		median: at(0.5),
		min: sorted.length ? sorted[0] : null,
		max: sorted.length ? sorted[sorted.length - 1] : null,
		p25: at(0.25),
		p75: at(0.75),
		n: runs.length,
		runs,
		dnf,
	};
}

// ---------------------------------------------------------------------------
// Where each contender's rewriter is (in the parent)

const exists = (path) => {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
};

const packageName = (dir) => {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
};

/**
 * The directory of the npm package `name` under `root` that has `files`:
 * the usual places first, then a search a few levels down (an extracted
 * tarball, a pnpm store)
 */
async function findPackage(root, name, files) {
	const fits = (dir) =>
		packageName(dir)?.name === name &&
		files.every((file) => exists(join(dir, file)));
	const likely = [
		join(root, 'node_modules', name),
		join(root, 'pkg', 'node_modules', name),
		root,
		join(root, 'package'),
		join(root, 'dist', 'package'),
	];
	for (const dir of likely) if (fits(dir)) return dir;
	let level = [root];
	for (let depth = 0; depth < 6 && level.length; depth++) {
		const next = [];
		for (const dir of level) {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name === '.git') continue;
				const path = join(dir, entry.name);
				if (fits(path)) return path;
				next.push(path);
			}
		}
		level = next;
	}
	return null;
}

/**
 * The wasm modules STomp's controller hands a rewrite worker (WASM_ASSETS in
 * src/config.ts): one core module since 3dfbc1c5, the rewriter, scanner and
 * suffix modules before it.
 */
function stompWasmNames(dir) {
	return exists(join(dir, 'core.wasm'))
		? ['core']
		: ['rewriter', 'scanner', 'suffix'];
}

/** where each row's rewriter is, or why it is not there */
async function locate(row, { repoRoot, contendersDir, dirs }) {
	const given = dirs?.[row];
	const contender = (id) => (contendersDir ? join(contendersDir, id) : null);
	switch (row) {
		case 'stomp-js':
		case 'stomp-wasm': {
			const dir = given ?? join(repoRoot, 'dist');
			const need = ['rewriteWorker.js'];
			if (row === 'stomp-wasm')
				need.push(...stompWasmNames(dir).map((n) => `${n}.wasm`));
			const missing = need.filter((file) => !exists(join(dir, file)));
			return missing.length
				? { error: `no ${missing.join(', ')} in ${dir} (npm run build)` }
				: { dir };
		}
		case 'scramjet':
		case 'ultraviolet': {
			const [name, files] =
				row === 'scramjet'
					? [
							'@mercuryworkshop/scramjet',
							['dist/scramjet.mjs', 'dist/scramjet.wasm'],
						]
					: ['@titaniumnetwork-dev/ultraviolet', ['dist/uv.bundle.js']];
			const root = given ?? contender(row);
			if (!root) return { error: 'no contenders directory given' };
			const dir = given ?? (await findPackage(root, name, files));
			if (!dir || !files.every((file) => exists(join(dir, file))))
				return { error: `no ${name} with ${files.join(', ')} under ${root}` };
			return { dir, version: packageName(dir)?.version };
		}
		case 'stompv1': {
			const dir = given ?? contender('stompv1');
			if (!dir) return { error: 'no contenders directory given' };
			if (!exists(join(dir, 'src/RewriteJS.js')))
				return { error: `no src/RewriteJS.js in ${dir}` };
			try {
				const require = createRequire(join(dir, 'src/RewriteJS.js'));
				for (const name of [
					'meriyah',
					'@javascript-obfuscator/escodegen',
					'ast-types',
				])
					require.resolve(name);
			} catch (error) {
				return {
					error: `its dependencies are not installed: ${error.message}`,
				};
			}
			return { dir };
		}
		case 'powermouse-v1': {
			const dir = given ?? contender('powermouse-v1');
			if (!dir || !exists(join(dir, 'server.js')))
				return { error: `no server.js in ${dir}` };
			return { dir };
		}
		default:
			return { error: `unknown row ${row}` };
	}
}

// ---------------------------------------------------------------------------
// Each row's rewriter (in its child process)

/**
 * STomp: its rewrite worker (dist/rewriteWorker.js), the thread the
 * controller starts for the service worker's script rewrites
 * (src/server/rewrites.ts rewriteScript; the service worker itself runs the
 * same modifyJS when no worker answers). It is evaluated here with `self`
 * standing in for the worker's global and is handed a port, as the
 * controller hands it one, and asked over the same RPC the pool uses with the
 * config the demo's StompController sends (codec xor, adblock on, a minted
 * client name; rewriter 'wasm' with the modules of WASM_ASSETS for
 * stomp-wasm). One worker, no split: the pool's split of a large script
 * across workers is the in-browser scenario's.
 */
async function loadStomp(dir, wasm) {
	const file = join(dir, 'rewriteWorker.js');
	// the worker's global: what it listens to and posts on
	let onWorkerMessage = null;
	const posted = [];
	const self = {
		addEventListener: (type, listener) => {
			if (type === 'message') onWorkerMessage = listener;
		},
		postMessage: (data) => posted.push(data),
	};
	vm.runInThisContext(
		`(function (self) {\n${await readFile(file, 'utf8')}\n})`,
		{ filename: file },
	)(self);
	if (!onWorkerMessage) throw new Error(`${file} listens to no message`);
	if (wasm) {
		const modules = {};
		for (const name of stompWasmNames(dir))
			modules[name] = await WebAssembly.compile(
				await readFile(join(dir, `${name}.wasm`)),
			);
		onWorkerMessage({ data: { $stomp$rewriteModules: modules }, ports: [] });
		for (let i = 0; i < 100 && !posted.length; i++)
			await new Promise((done) => setTimeout(done, 10));
		const held = posted[0]?.$stomp$rewriteModules;
		if (
			!Array.isArray(held) ||
			!(held.includes('core') || held.includes('rewriter'))
		)
			throw new Error(`the rewrite worker holds ${JSON.stringify(held)}`);
	}
	// the port the service worker would hold, in this thread: a call hands
	// the worker the script itself, where a MessagePort would copy it in
	// and the output out (20 to 30 ms for typescript.js), which no other
	// row pays
	let onPortMessage = null;
	const pending = new Map();
	let token = 0;
	let ready;
	const isReady = new Promise((done) => (ready = done));
	const port = {
		addEventListener: (type, listener) => {
			if (type === 'message') onPortMessage = listener;
		},
		start: () => {},
		postMessage: (data) => {
			if (data?.$stomp$rewriteReady) return ready();
			const answer = data?.['stomp-rewrite'];
			const call = pending.get(answer?.$token);
			if (!call) return;
			pending.delete(answer.$token);
			if (answer.$error !== undefined) call.reject(new Error(answer.$error));
			else call.resolve(answer.$data);
		},
	};
	onWorkerMessage({ data: { $stomp$rewritePort: true }, ports: [port] });
	await isReady;
	if (!onPortMessage) throw new Error(`${file} does not listen on its port`);
	const directory = '/stomp/benchctl/';
	const config = {
		codec: 'xor',
		directory,
		scope: '/stomp/',
		adblock: true,
		names: { client: '$Bq7xK2mPzR' },
		...(wasm ? { rewriter: 'wasm' } : {}),
	};
	const by = { wasm: 0, js: 0 };
	return {
		describe: `${file} (the rewrite worker bundle) evaluated in Node with \`self\` standing in for the worker's global, handed a port in the same thread (no copy of the script or output); per script the pool's RPC 'rewrite' with { url, directory: '${directory}', codecKey: '3a42', config: ${JSON.stringify(config)}, type: 'generic' | 'genericModule', scopes: ['${PROXY_ORIGIN}${directory}'] }${wasm ? '; the WASM_ASSETS modules compiled from dist/ and handed over as the controller does (REWRITE_MODULES)' : ''}; one worker, no split`,
		// which backend made each output of the last pass
		info: () => {
			const told = wasm ? { lastPassAnsweredBy: { ...by } } : {};
			by.wasm = by.js = 0;
			return told;
		},
		rewrite: (text, { url, module }) =>
			new Promise((resolve, reject) => {
				const t = token++;
				pending.set(t, {
					resolve: (answer) => {
						if (typeof answer === 'string') return resolve(answer);
						if (answer?.by) by[answer.by] = (by[answer.by] ?? 0) + 1;
						resolve(answer?.output);
					},
					reject,
				});
				onPortMessage({
					data: {
						'stomp-rewrite': {
							$type: 'request',
							$method: 'rewrite',
							$token: t,
							$args: {
								script: text,
								url,
								directory,
								codecKey: '3a42',
								config,
								type: module ? 'genericModule' : 'generic',
								scopes: [`${PROXY_ORIGIN}${directory}`],
							},
						},
					},
				});
			}),
	};
}

/**
 * scramjet: its wasm rewriter as the controller's fetch handler calls it
 * for a script response (packages/core/src/fetch/body.ts `case "script"`):
 * rewriteJs(body bytes, url, frame context, { origin: url, base: url },
 * isModule), with the controller's defaultConfig (deepmerged under the
 * host's, which sets nothing), the frame prefix and the controller's codec
 * (encodeURIComponent). With sourcemaps on (the default) its output is
 * decoded and prefixed with the source map push, which is timed too.
 */
async function loadScramjet(dir) {
	const sj = await import(pathToFileURL(join(dir, 'dist/scramjet.mjs')).href);
	sj.setWasm(new Uint8Array(await readFile(join(dir, 'dist/scramjet.wasm'))));
	const config = structuredClone(sj.defaultConfig);
	const codecEncode = (url) => (url ? encodeURIComponent(url) : url);
	const codecDecode = (url) => (url ? decodeURIComponent(url) : url);
	const prefix = new URL('/~/sj/benchctl/benchfrm/', PROXY_ORIGIN);
	const context = {
		config,
		prefix,
		cookieJar: new sj.CookieJar(),
		interface: { codecEncode, codecDecode },
	};
	const decoder = new TextDecoder();
	return {
		describe: `${join(dir, 'dist/scramjet.mjs')} (version ${packageName(dir)?.version}): setWasm(dist/scramjet.wasm); per script rewriteJs(Uint8Array body, url, { config: defaultConfig, prefix: '${prefix.href}', interface.codecEncode: encodeURIComponent, cookieJar }, { origin: url, base: url }, isModule); flags ${JSON.stringify(config.flags)}`,
		bytes: true,
		rewrite: (bytes, { url, module }) => {
			const base = new URL(url);
			const out = sj.rewriteJs(
				bytes,
				url,
				context,
				{ origin: base, base },
				module,
			);
			return typeof out === 'string' ? out : decoder.decode(out);
		},
		unrewritten: (output) => !output.includes('$scramjet'),
	};
}

/**
 * Ultraviolet: dist/uv.bundle.js's Ultraviolet class as its service worker
 * uses it for a response of destination "script" (src/uv.sw.js): a new
 * Ultraviolet per request with uv.config.js's defaults, meta.origin the
 * proxy's, meta.base = meta.url the script's URL, then js.rewrite(text).
 * It parses every script as a module and hands back the input when its
 * parser refuses it (src/rewrite/js.js).
 */
async function loadUltraviolet(dir) {
	const file = join(dir, 'dist/uv.bundle.js');
	const holder = {};
	vm.runInThisContext(
		`(function (self) {\n${await readFile(file, 'utf8')}\n})`,
		{
			filename: file,
		},
	)(holder);
	const { Ultraviolet } = holder;
	if (typeof Ultraviolet !== 'function')
		throw new Error('uv.bundle.js did not define Ultraviolet');
	const config = {
		prefix: '/service/',
		encodeUrl: Ultraviolet.codec.xor.encode,
		decodeUrl: Ultraviolet.codec.xor.decode,
		handler: '/uv.handler.js',
		client: '/uv.client.js',
		bundle: '/uv.bundle.js',
		config: '/uv.config.js',
		sw: '/uv.sw.js',
	};
	return {
		describe: `${file} (version ${packageName(dir)?.version}) evaluated with \`self\` a plain object; per script new Ultraviolet(uv.config.js defaults: prefix /service/, xor codec), meta.origin '${PROXY_ORIGIN}', meta.base = meta.url = new URL(url), js.rewrite(text) (uv.sw.js, destination "script"; no module flag: it parses everything as a module)`,
		rewrite: (text, { url }) => {
			const ultraviolet = new Ultraviolet(config);
			ultraviolet.meta.origin = PROXY_ORIGIN;
			ultraviolet.meta.base = ultraviolet.meta.url = new URL(url);
			return ultraviolet.js.rewrite(text);
		},
	};
}

/**
 * stompV1: src/RewriteJS.js (meriyah, ast-types, escodegen) as its service
 * worker's `js` route calls it (src/Worker/send.js sendJS:
 * `tomp.js.wrap(text, url)`, with no worker or module flag: every script
 * response is parsed as a classic script). The TOMP instance stands in as
 * the fields wrap reads (noscript, log.trace, url.wrap, directory).
 */
async function loadStompV1(dir) {
	const file = join(dir, 'src/RewriteJS.js');
	const { default: RewriteJS } = await import(pathToFileURL(file).href);
	const tomp = {
		noscript: false,
		directory: '/tomp/',
		log: { trace() {} },
		url: {
			wrap: (url, service) => `/tomp/${service}/${encodeURIComponent(url)}`,
		},
	};
	const js = new RewriteJS(tomp);
	return {
		describe: `${file}: new RewriteJS(tomp).wrap(text, url) as sendJS calls it (no worker or module argument, so every script is parsed as a classic script); tomp stands in as { noscript: false, log.trace: no-op, url.wrap, directory }`,
		rewrite: (text, { url }) => js.wrap(text, url),
		unrewritten: (output) => /^throw new SyntaxError\(/.test(output),
	};
}

/**
 * powerMouseV1 rewrites a JavaScript response on the server, with string
 * operations and one regular expression (server.js, the proxy route: every
 * text/ or application/ body is read as UTF-8, split on newlines and joined
 * again, and a javascript one has `this.xhr.open("GET",a)` replaced). The
 * same statements are run here on the response body; the file is checked to
 * still hold them. Serving (express's res.send, its ETag) is not timed.
 */
const POWERMOUSE_LINES = [
	"var tmp=sendData.toString('utf8'),",
	"sendData.split('\\n').forEach(e=>str+=e+'\\n');",
	"if(ct.includes('javascript'))sendData=await str",
	'.replace(/this\\.xhr\\.open\\("GET",a\\)/gi,`this.xhr.open("GET",location.origin+"/"+a)`)',
];

async function loadPowermouse(dir) {
	const file = join(dir, 'server.js');
	const source = await readFile(file, 'utf8');
	const gone = POWERMOUSE_LINES.filter((line) => !source.includes(line));
	if (gone.length)
		throw new Error(`server.js no longer holds ${JSON.stringify(gone)}`);
	const ct = 'text/javascript';
	return {
		describe: `${file}: the proxy route's body handling for content-type ${ct} (read as UTF-8, split on newlines and joined, then the one javascript replace), run on the body Buffer as the route does; it parses nothing`,
		bytes: 'buffer',
		rewrite: (sendData) => {
			const tmp = sendData.toString('utf8');
			let str = '';
			sendData = tmp;
			sendData.split('\n').forEach((e) => (str += e + '\n'));
			if (ct.includes('javascript'))
				sendData = str.replace(
					/this\.xhr\.open\("GET",a\)/gi,
					`this.xhr.open("GET",location.origin+"/"+a)`,
				);
			return sendData;
		},
		// its output is the script with a newline added, by design
		same: true,
	};
}

const LOADERS = {
	'stomp-js': (dir) => loadStomp(dir, false),
	'stomp-wasm': (dir) => loadStomp(dir, true),
	scramjet: loadScramjet,
	ultraviolet: loadUltraviolet,
	stompv1: loadStompV1,
	'powermouse-v1': loadPowermouse,
};

/** a row's process: loads its rewriter, then answers one pass over the corpus per message */
async function childMain(row) {
	let rewriter;
	let scripts;
	let parse;
	/** each script's output length in the warm-up pass */
	const warmLength = new Map();
	const UNREWRITTEN_END = '\n;this.#STomp_could_not_rewrite_this_script;\n';

	const check = (script, output, warm) => {
		if (typeof output !== 'string') return `answered ${typeof output}`;
		// (a printer drops comments: lodash comes out at under half its length)
		if (output.length < Math.min(1024, script.text.length / 10))
			return `output ${output.length} chars for ${script.text.length}: ${JSON.stringify(output.slice(0, 120))}`;
		if (!rewriter.same && output === script.text)
			return 'handed back unrewritten';
		if (output.endsWith(UNREWRITTEN_END))
			return 'handed back with the could-not-rewrite end';
		if (rewriter.unrewritten?.(output))
			return `not rewritten: ${JSON.stringify(output.slice(0, 120))}`;
		if (!warm) return null;
		warmLength.set(script.id, output.length);
		if (rewriter.same || script.inputParses === false) return null;
		try {
			parse(output, {
				module: script.module,
				next: true,
				webcompat: true,
				globalReturn: !script.module,
			});
		} catch (error) {
			return `output does not parse: ${error.message}`;
		}
		return null;
	};

	const pass = async (warm) => {
		globalThis.gc?.();
		const results = [];
		for (const script of scripts) {
			let output;
			let ms;
			let reason;
			try {
				const t0 = performance.now();
				output = rewriter.rewrite(script.input, {
					url: script.url,
					module: script.module,
				});
				if (output instanceof Promise) output = await output;
				ms = performance.now() - t0;
				reason = check(script, output, warm);
			} catch (error) {
				reason = `threw: ${String(error?.message ?? error).slice(0, 300)}`;
			}
			results.push({
				id: script.id,
				ms,
				ok: reason === null,
				reason,
				outLength: typeof output === 'string' ? output.length : null,
			});
			output = null;
		}
		return results;
	};

	process.on('message', async (message) => {
		try {
			if (message.init) {
				const { dir, repoRoot } = message.init;
				({ parse } = createRequire(join(repoRoot, 'package.json'))('meriyah'));
				rewriter = await LOADERS[row](dir);
				scripts = [];
				for (const entry of message.init.scripts) {
					const buffer = await readFile(entry.file);
					const text = buffer.toString('utf8');
					let inputParses = true;
					try {
						parse(text, {
							module: entry.module,
							next: true,
							webcompat: true,
							globalReturn: !entry.module,
						});
					} catch {
						inputParses = false;
					}
					scripts.push({
						id: entry.id,
						module: entry.module,
						url: scriptURL(entry.id),
						text,
						inputParses,
						input:
							rewriter.bytes === 'buffer'
								? buffer
								: rewriter.bytes
									? new Uint8Array(buffer)
									: text,
					});
				}
				process.send({ ready: rewriter.describe });
			} else if (message.pass !== undefined) {
				const results = await pass(message.warm);
				process.send({ results, info: rewriter.info?.() ?? {} });
			}
		} catch (error) {
			process.send({ error: String(error?.stack ?? error) });
		}
	});
	process.send({ up: true });
}

/** a row's process, started and waiting for its first message */
function startChild(row, logs) {
	const child = fork(SELF, ['--child', row], {
		execPath: process.execPath,
		execArgv: CHILD_FLAGS,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		serialization: 'advanced',
	});
	let waiting = null;
	let ended = null;
	const keep = (chunk) => {
		logs.push(String(chunk));
		if (logs.length > 200) logs.shift();
	};
	child.stdout.on('data', keep);
	child.stderr.on('data', keep);
	child.on('message', (message) => {
		const call = waiting;
		waiting = null;
		call?.resolve(message);
	});
	child.on('exit', (code, signal) => {
		ended = `exited (${signal ?? code})`;
		const call = waiting;
		waiting = null;
		call?.reject(new Error(ended));
	});
	/** the child's next message (after sending `message`, if any), within `ms` */
	const ask = (message, ms) =>
		new Promise((resolve, reject) => {
			if (ended) return reject(new Error(ended));
			const timer = setTimeout(() => {
				waiting = null;
				child.kill('SIGKILL');
				reject(new Error(`no answer in ${ms} ms`));
			}, ms);
			waiting = {
				resolve: (value) => (clearTimeout(timer), resolve(value)),
				reject: (error) => (clearTimeout(timer), reject(error)),
			};
			if (message) child.send(message);
		});
	return { child, ask, pid: child.pid };
}

/**
 * Offline rewrite throughput of every row.
 *
 * @param {object} options
 * @param {string} options.repoRoot STomp's checkout (its dist/ is used)
 * @param {string} [options.contendersDir] where the contenders are (bench/lib/setup.mjs)
 * @param {{ id: string, file: string, bytes: number, module: boolean }[]} options.scripts ensureScripts' list
 * @param {number} [options.repeats]
 * @param {string[]} [options.rows]
 * @param {Record<string, string>} [options.dirs] a row's rewriter directory, where it is not the usual one
 * @param {number} [options.passTimeout] ms one pass of one row may take
 * @param {(line: string) => void} [options.log]
 */
export async function measureOffline({
	repoRoot,
	contendersDir,
	scripts,
	repeats = 5,
	rows = ROWS,
	dirs = {},
	passTimeout = 15 * 60_000,
	log = () => {},
}) {
	const notes = {};
	const failures = {};
	const info = {};
	/** row -> repeat -> [{ id, ms, ok }] */
	const passes = {};
	const children = {};
	const logs = {};
	const init = {
		repoRoot,
		scripts: scripts.map(({ id, file, bytes, module }) => ({
			id,
			file,
			bytes,
			module,
		})),
	};

	for (const row of rows) {
		const where = await locate(row, { repoRoot, contendersDir, dirs });
		if (where.error) {
			notes[row] = `not run: ${where.error}`;
			continue;
		}
		logs[row] = [];
		const child = startChild(row, logs[row]);
		try {
			await child.ask(null, 60_000);
			const ready = await child.ask(
				{ init: { ...init, dir: where.dir } },
				10 * 60_000,
			);
			if (ready.error) throw new Error(ready.error);
			notes[row] = ready.ready;
			children[row] = child;
			passes[row] = [];
			failures[row] = {};
			log(`${row}: ${ready.ready}`);
		} catch (error) {
			notes[row] = `not run: it did not load: ${error.message}`;
			child.child.kill('SIGKILL');
		}
	}

	const live = Object.keys(children);
	const dnf = Object.fromEntries(live.map((row) => [row, 0]));
	const failed = new Set();
	const runPass = async (row, repeat) => {
		if (failed.has(row)) {
			dnf[row]++;
			return;
		}
		try {
			const answer = await children[row].ask(
				{ pass: repeat, warm: repeat < 0 },
				passTimeout,
			);
			if (answer.error) throw new Error(answer.error);
			info[row] = answer.info;
			for (const result of answer.results)
				if (!result.ok)
					failures[row][result.id] ??=
						`${repeat < 0 ? 'warm-up' : `repeat ${repeat}`}: ${result.reason}`;
			if (repeat >= 0) passes[row].push(answer.results);
			const ms = answer.results.reduce((sum, r) => sum + (r.ms ?? 0), 0);
			log(
				`${row} ${repeat < 0 ? 'warm-up' : `repeat ${repeat + 1}/${repeats}`}: ${ms.toFixed(0)} ms, ${answer.results.filter((r) => !r.ok).length} failed`,
			);
		} catch (error) {
			failed.add(row);
			notes[row] +=
				`; stopped: ${error.message}${logs[row].length ? ` (${logs[row].join('').slice(-500)})` : ''}`;
			if (repeat >= 0) dnf[row]++;
		}
	};
	for (const row of live) await runPass(row, -1);
	for (let repeat = 0; repeat < repeats; repeat++)
		for (const row of live) await runPass(row, repeat);
	for (const row of live) children[row].child.kill();

	const bytesOf = Object.fromEntries(scripts.map((s) => [s.id, s.bytes]));
	/** MB/s of one pass over `ids` (the scripts that failed in any pass of the row left out) */
	const rate = (results, ids) => {
		let bytes = 0;
		let ms = 0;
		for (const r of results)
			if (ids.has(r.id)) {
				bytes += bytesOf[r.id];
				ms += r.ms;
			}
		return ms > 0 ? bytes / 1e6 / (ms / 1000) : null;
	};
	const okIds = (row) =>
		new Set(scripts.map((s) => s.id).filter((id) => !(id in failures[row])));
	const result = {};
	const perScript = {};
	for (const row of rows) {
		if (!passes[row]) {
			result[row] = stat([], repeats);
			continue;
		}
		const ids = okIds(row);
		result[row] = stat(
			passes[row]
				.map((results) => rate(results, ids))
				.filter((v) => v !== null),
			dnf[row],
		);
		perScript[row] = {};
		for (const s of scripts) {
			const times = passes[row]
				.map((results) => results.find((r) => r.id === s.id))
				.filter((r) => r?.ok)
				.map((r) => r.ms);
			perScript[row][s.id] = times.length ? stat(times).median : null;
		}
		const skipped = scripts.filter((s) => !ids.has(s.id));
		if (skipped.length)
			notes[row] +=
				`; MB/s over ${ids.size} of ${scripts.length} scripts (${skipped.map((s) => s.id).join(', ')} failed: see failures)`;
		if (info[row] && Object.keys(info[row]).length)
			notes[row] += `; ${JSON.stringify(info[row])}`;
	}
	// every row over the scripts every run row rewrote
	const common = new Set(
		scripts
			.map((s) => s.id)
			.filter((id) => live.every((row) => !(id in failures[row]))),
	);
	const commonStats = {};
	for (const row of live)
		commonStats[row] = stat(
			passes[row]
				.map((results) => rate(results, common))
				.filter((v) => v !== null),
			dnf[row],
		);

	return {
		...result,
		notes,
		perScript,
		failures,
		common: {
			scripts: [...common],
			bytes: [...common].reduce((sum, id) => sum + bytesOf[id], 0),
			...commonStats,
		},
		meta: {
			node: process.version,
			execPath: process.execPath,
			flags: CHILD_FLAGS,
			repeats,
			order: live,
			scripts: scripts.map(({ id, bytes, module }) => ({ id, bytes, module })),
		},
	};
}

// ---------------------------------------------------------------------------
// CLI

function table(result, scripts, rows) {
	const fmt = (v, digits = 2) =>
		v === null || v === undefined ? '-' : v.toFixed(digits);
	const lines = [];
	const pad = (cells, widths) =>
		cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
	const head = [
		'row',
		'MB/s median',
		'p25-p75',
		'n',
		'dnf',
		'failed',
		'common MB/s',
	];
	const body = rows.map((row) => {
		const s = result[row];
		const c = result.common[row];
		return [
			row,
			fmt(s.median),
			s.n ? `${fmt(s.p25)}-${fmt(s.p75)}` : '-',
			s.n,
			s.dnf,
			Object.keys(result.failures[row] ?? {}).length,
			c ? fmt(c.median) : '-',
		];
	});
	const widths = head.map((_, i) =>
		Math.max(...[head, ...body].map((cells) => String(cells[i]).length)),
	);
	lines.push(pad(head, widths), ...body.map((cells) => pad(cells, widths)));
	lines.push(
		'',
		`per-script median ms (common set: ${result.common.scripts.join(', ')})`,
	);
	const shead = ['script', 'bytes', 'mod', ...rows];
	const sbody = scripts.map((s) => [
		s.id,
		s.bytes,
		s.module ? 'esm' : '',
		...rows.map((row) => {
			if (result.failures[row]?.[s.id]) return 'FAIL';
			return fmt(result.perScript[row]?.[s.id], 1);
		}),
	]);
	const swidths = shead.map((_, i) =>
		Math.max(...[shead, ...sbody].map((cells) => String(cells[i]).length)),
	);
	lines.push(pad(shead, swidths), ...sbody.map((cells) => pad(cells, swidths)));
	lines.push('', 'notes:');
	for (const row of rows) lines.push(`  ${row}: ${result.notes[row] ?? ''}`);
	lines.push('', 'failures:');
	for (const row of rows)
		for (const [id, why] of Object.entries(result.failures[row] ?? {}))
			lines.push(`  ${row} ${id}: ${why}`);
	return lines.join('\n');
}

async function cli(argv) {
	const args = { repeats: 5, pkg: {} };
	for (let i = 0; i < argv.length; i++) {
		const [flag, value] = [argv[i], argv[i + 1]];
		if (flag === '--cache') args.cache = value;
		else if (flag === '--repeats') args.repeats = Number(value);
		else if (flag === '--contenders') args.contenders = value;
		else if (flag === '--rows') args.rows = value.split(',');
		else if (flag === '--json') args.json = value;
		else if (flag === '--pkg') {
			const at = value.indexOf('=');
			args.pkg[value.slice(0, at)] = resolve(value.slice(at + 1));
		} else continue;
		i++;
	}
	if (!args.cache) {
		console.error(
			'usage: node bench/lib/rewrite-offline.mjs --cache <dir> [--repeats 5] [--contenders <dir>] [--rows a,b] [--pkg <row>=<dir>] [--json <file>]',
		);
		process.exit(2);
	}
	const { ensureScripts } = await import('./scripts.mjs');
	const scripts = await ensureScripts(resolve(args.cache));
	const rows = args.rows ?? ROWS;
	const result = await measureOffline({
		repoRoot: resolve(dirname(SELF), '../..'),
		contendersDir: args.contenders
			? resolve(args.contenders)
			: process.env.BENCH_CONTENDERS,
		scripts,
		repeats: args.repeats,
		rows,
		dirs: args.pkg,
		log: (line) => console.error(line),
	});
	if (args.json) await writeFile(args.json, JSON.stringify(result, null, '\t'));
	console.log(table(result, scripts, rows));
}

if (process.argv[2] === '--child' && process.send) childMain(process.argv[3]);
else if (process.argv[1] && resolve(process.argv[1]) === SELF)
	await cli(process.argv.slice(2));
