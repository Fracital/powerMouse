// Import a transport module and construct it, wrapped so that it comes back
// after its wisp connection is lost (RevivingTransport), and in
// Http3Transport when the descriptor asks for HTTP/3. The transport worker,
// the controller page (`host: 'page'` and the worker fallback) and the
// controller frame all construct descriptors through here, so the options
// mean the same wherever the transport runs.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import Http3Transport, { type Http3Options } from './http3/Http3Transport';
import RevivingTransport from './RevivingTransport';
import { useWebTransportModule } from './webTransportHost';
import {
	CarrierTransport,
	type WispWebTransportOptions,
} from './wispWebTransport';

/** `http3` in a descriptor: a function (`udp`) cannot be cloned into a worker */
export type Http3DescriptorOptions = Omit<Http3Options, 'udp'>;

export interface ConstructibleTransport {
	/** module URL, already resolved */
	module: string;
	options?: unknown[];
	http3?: boolean | Http3DescriptorOptions;
	webTransport?: boolean | WispWebTransportOptions;
}

/** the descriptor with `http3.module` resolved against `base` too */
export function resolveHttp3<T extends ConstructibleTransport>(
	descriptor: T,
	base: string,
): T {
	const http3 = descriptor.http3;
	if (!http3 || http3 === true || !http3.module) return descriptor;
	return {
		...descriptor,
		http3: { ...http3, module: new URL(http3.module, base).href },
	};
}

/** directories a package keeps its build in, which name no transport */
const BUILD_DIRECTORIES = new Set([
	'dist',
	'lib',
	'build',
	'esm',
	'cjs',
	'out',
]);

/**
 * A transport module as the host's console names it: its file, or for an
 * index its package's directory, without `-transport`
 * (`/epoxy/index.mjs` and `@mercuryworkshop/epoxy-transport/dist/index.mjs`
 * are `epoxy`)
 */
export function transportName(module: string): string {
	let parts: string[];
	try {
		parts = new URL(module).pathname.split('/').filter(Boolean);
	} catch {
		parts = module.split('/').filter(Boolean);
	}
	let name = (parts.pop() ?? '').replace(/\.[cm]?js$/, '');
	while ((name === 'index' || BUILD_DIRECTORIES.has(name)) && parts.length)
		name = parts.pop()!;
	return name.replace(/-transport$/, '') || 'transport';
}

/**
 * `h3Worker`: the transport worker's script, which stomp-h3 runs in a
 * worker of its own from (http3/h3Thread.ts); without it stomp-h3 runs in
 * this realm.
 */
export async function constructTransport(
	{ module, options, http3, webTransport }: ConstructibleTransport,
	h3Worker?: string,
): Promise<ProxyTransport> {
	const importing = (
		import(/* @vite-ignore */ module) as Promise<{
			default: new (...args: unknown[]) => ProxyTransport;
		}>
	).then(({ default: Transport }) => {
		if (typeof Transport !== 'function')
			throw new TypeError(`${module} has no default export to construct`);
		return Transport;
	});
	const args = options || [];
	// Wisp over the relay's WebTransport session when it has one (epoxy's
	// function transport: a `wisp` URL to start from), its WebSocket
	// otherwise (src/transport/wispWebTransport.ts). Without `webTransport`
	// a transport given a wisp URL rides its WebSocket, and says so as the
	// carrier, as the host's console and `carrier` tell it
	const carried =
		typeof (args[0] as { wisp?: unknown } | undefined)?.wisp === 'string';
	const label = { transport: transportName(module), http3: !!http3 };
	const carrierOptions = !webTransport
		? null
		: webTransport === true
			? {}
			: webTransport;
	// with `webTransport`, the first transport's carrier is chosen while the
	// module loads: the session's handshake does not wait for its fetch
	let early =
		carried && carrierOptions
			? new CarrierTransport(importing, args, carrierOptions, label)
			: null;
	const Transport = await importing;
	await early?.loaded;
	const transport = new RevivingTransport(() => {
		const first = early;
		early = null;
		if (first) return first;
		return carried
			? new CarrierTransport(Transport, args, carrierOptions, label)
			: new Transport(...args);
	});
	// stomp-h3 ships in epoxy-transport's dist/h3/ (deploy/epoxy/h3); a
	// page's WebTransport sessions use it whether or not HTTP/3 is on
	// (src/transport/webTransportHost.ts)
	const h3 = http3 && http3 !== true ? http3 : {};
	useWebTransportModule(
		transport,
		h3.module ?? new URL('h3/stomp_h3.js', module).href,
		h3.pem,
	);
	if (!http3) return transport;
	return new Http3Transport(
		transport,
		h3,
		new URL('h3/stomp_h3.js', module).href,
		h3Worker,
	);
}
