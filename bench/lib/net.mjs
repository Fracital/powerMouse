// Small process and network helpers shared by the harness and the adapters.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** a TCP port nothing listens on right now, on 127.0.0.1 */
export function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** resolves once `url` answers anything at all (any status) */
export async function waitForHttp(url, timeoutMs = 60000) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(2000) });
			return;
		} catch (error) {
			if (Date.now() > end)
				throw new Error(`nothing answered at ${url}`, { cause: error });
			await sleep(200);
		}
	}
}

/**
 * Starts a child process with its output in `logFile`. The returned object
 * has `pid` and `stop()`, which sends SIGTERM to that one PID (then SIGKILL
 * after 5 s) and waits for it to exit.
 */
export function startProcess(command, args, { logFile, env, cwd } = {}) {
	const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
	const child = spawn(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	if (log) {
		log.write(`$ ${command} ${args.join(' ')}\n`);
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
	} else {
		child.stdout.resume();
		child.stderr.resume();
	}
	let exited = false;
	const exit = new Promise((resolve) =>
		child.on('exit', (code, signal) => {
			exited = true;
			log?.write(`exited ${code ?? signal}\n`);
			resolve({ code, signal });
		}),
	);
	child.on('error', (error) => log?.write(`spawn error ${error.message}\n`));
	return {
		pid: child.pid,
		child,
		exit,
		get exited() {
			return exited;
		},
		async stop() {
			if (exited) return;
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
			await exit;
			clearTimeout(timer);
		},
	};
}

/** bytes a process has read and written through syscalls (/proc/<pid>/io) */
export async function processIO(pid) {
	const { readFile } = await import('node:fs/promises');
	try {
		const text = await readFile(`/proc/${pid}/io`, 'utf8');
		const field = (name) =>
			Number(text.match(new RegExp(`${name}: (\\d+)`))[1]);
		return { rchar: field('rchar'), wchar: field('wchar') };
	} catch {
		return null;
	}
}

/** user + system CPU time of a process and its descendants that exited, ms */
export async function processCPU(pid) {
	const { readFile } = await import('node:fs/promises');
	try {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
		const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		// utime stime cutime cstime are fields 14-17 (1-based) of the full line
		const ticks = fields.slice(11, 15).map(Number);
		return ((ticks[0] + ticks[1]) * 1000) / 100;
	} catch {
		return null;
	}
}

/**
 * The value of `promise`, or `fallback` if it has not settled in `ms`. The
 * promise is left to settle on its own afterwards (its result is dropped), so
 * an operation that wedges a renderer (a screenshot or a context close on a
 * hung page) cannot hang the caller forever.
 */
export function withTimeout(promise, ms, fallback) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
		timer.unref?.();
	});
	return Promise.race([
		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(timer);
				return value;
			},
			() => {
				clearTimeout(timer);
				return fallback;
			},
		),
		timeout,
	]);
}
