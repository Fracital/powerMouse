// `npm run dev`: the esbuild watch and the demo server in one terminal, with
// live reload between them (build.js posts each rebuild to the server, the
// server pushes it to the page over /__dev, demo/public/pm/dev.js applies it).
// The server runs under `node --watch`, so editing demo/server.js restarts it
// and the page reloads once it is back.
//
//   PORT   port for the demo server and the rebuild notifications (8080)
//
// Both children share this process's terminal; Ctrl+C (or any signal that
// ends this process) stops both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = String(parseInt(process.env.PORT || '') || 8080);
const env = {
	...process.env,
	PORT: port,
	STOMP_DEV: '1',
	WISP_ALLOW_LOOPBACK: process.env.WISP_ALLOW_LOOPBACK ?? '1',
};

const children = [
	spawn(process.execPath, ['build.js', '--dev'], {
		cwd: root,
		env,
		stdio: 'inherit',
	}),
	spawn(
		process.execPath,
		[
			'--watch-path=demo/server.js',
			'--watch-path=lib',
			'--watch-preserve-output',
			'demo/server.js',
		],
		{ cwd: root, env, stdio: 'inherit' },
	),
];

let stopping = false;
function stop(signal = 'SIGTERM') {
	if (stopping) return;
	stopping = true;
	for (const child of children) if (child.exitCode === null) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
	process.on(signal, () => {
		stop(signal);
		// let the children's own handlers run before this process goes
		setTimeout(() => process.exit(130), 500).unref();
	});

for (const child of children)
	child.on('exit', (code, signal) => {
		if (stopping) return;
		// one half is gone (esbuild crashed, or the server watcher itself died);
		// the other cannot do anything useful alone
		console.error(
			`dev: ${child.spawnargs.at(-1)} exited (${signal || code}), stopping`,
		);
		stop();
		process.exitCode = code || 1;
	});
