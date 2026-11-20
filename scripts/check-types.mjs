// The published declarations (dist/types, the package's `types`) work for a
// consumer: a file that imports '@sysce/stomp', '@sysce/stomp/path' and
// '@sysce/stomp/omnibox' through the package's exports compiles under each
// moduleResolution a TypeScript project uses (nodenext, node16, bundler),
// declaration files checked too (skipLibCheck off). Under nodenext and
// node16 a relative import in a .d.ts needs its extension (TS2834), which
// this catches.
//
// Run after the build (it reads dist/types):
//   npm run build && npm run check:types
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!existsSync(join(ROOT, 'dist/types/controller/index.d.ts'))) {
	console.error('dist/types is missing: run `npm run build` first');
	process.exit(1);
}

// what a host writes: the controller, its options and the named types a
// host's own code annotates with
const CONSUMER = `import {
	DEFAULT_SANDBOX,
	RemoteController,
	SearchBuilder,
	StompController,
	type ControllerInit,
	type RemotePermissionRequest,
	type RemoteRequestEvent,
	type RequestErrorKind,
	type Shields,
	type ShardsOption,
	type SiteShields,
	type SitePoolInit,
	type TransportDescriptor,
} from '@sysce/stomp';
import {
	attachOmnibox,
	type OmniboxOptions,
	type Suggestion,
} from '@sysce/stomp/omnibox';
import { stompPath } from '@sysce/stomp/path';

export const path: string = stompPath;
export const sandbox: string = DEFAULT_SANDBOX;
export const shards: ShardsOption = { max: 2, start: 1 };
export const transport: TransportDescriptor = {
	module: '/epoxy/index.mjs',
	options: [{ wisp: 'wss://relay.invalid/' }],
	shards,
};
export const pool: SitePoolInit | undefined = undefined;
export const init: ControllerInit = {
	serviceworker: {} as ServiceWorker,
	transport,
};
export function kind(k: RequestErrorKind): string {
	return k;
}
export function onRequest(event: RemoteRequestEvent): string {
	return event.url;
}
export function onPermission(request: RemotePermissionRequest): string {
	return request.permission;
}
export function site(shields: Shields, s: SiteShields | null): unknown {
	return [shields, s];
}
export const classes = [StompController, RemoteController, SearchBuilder];
export const omnibox: typeof attachOmnibox = attachOmnibox;
export function row(s: Suggestion, o: OmniboxOptions | null): unknown {
	return [s, o];
}
`;

const RESOLUTIONS = [
	{ moduleResolution: 'nodenext', module: 'nodenext' },
	{ moduleResolution: 'node16', module: 'node16' },
	{ moduleResolution: 'bundler', module: 'esnext' },
];

const dir = mkdtempSync(join(tmpdir(), 'stomp-types-'));
let failed = false;
try {
	// the package as npm installs it: package.json and the files it lists
	const pkg = join(dir, 'node_modules/@sysce/stomp');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, 'package.json'), JSON.stringify(PACKAGE));
	for (const name of PACKAGE.files)
		symlinkSync(join(ROOT, name), join(pkg, name), 'dir');
	// beside it only what installing the package brings: its dependencies,
	// not the checkout's devDependencies
	for (const name of Object.keys(PACKAGE.dependencies ?? {})) {
		mkdirSync(join(dir, 'node_modules', name, '..'), { recursive: true });
		symlinkSync(
			join(ROOT, 'node_modules', name),
			join(dir, 'node_modules', name),
			'dir',
		);
	}
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
	);
	writeFileSync(join(dir, 'consumer.ts'), CONSUMER);
	for (const { moduleResolution, module } of RESOLUTIONS) {
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'es2022',
					module,
					moduleResolution,
					lib: ['es2023', 'dom', 'dom.iterable'],
					types: [],
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					preserveSymlinks: true,
				},
				files: ['consumer.ts'],
			}),
		);
		let out = '';
		try {
			execFileSync(process.execPath, [TSC, '-p', dir, '--pretty', 'false'], {
				cwd: dir,
				encoding: 'utf8',
				stdio: 'pipe',
			});
		} catch (error) {
			out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		}
		const errors = out.split('\n').filter((line) => /error TS\d+/.test(line));
		// @mercuryworkshop/proxy-transports 1.0.2's own declarations import
		// their siblings without an extension, so under nodenext and node16
		// its index exports no types (ProxyTransport reads as `any`): that is
		// the dependency's to fix, and reported here as a note
		const upstream = errors.filter(
			(line) =>
				line.startsWith('node_modules/@mercuryworkshop/') ||
				/"[^"]*@mercuryworkshop\/proxy-transports[^"]*"/.test(line),
		);
		const own = errors.filter((line) => !upstream.includes(line));
		if (own.length) {
			failed = true;
			console.error(
				`types fail under moduleResolution ${moduleResolution} (${own.length} errors):\n${own.join('\n')}`,
			);
		} else console.log(`types ok under moduleResolution ${moduleResolution}`);
		if (upstream.length)
			console.log(
				`  (${upstream.length} in or about @mercuryworkshop/proxy-transports' declarations, not counted)`,
			);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
