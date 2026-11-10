// Import a transport module and construct it, wrapped in Http3Transport when
// the descriptor asks for HTTP/3. The transport worker, the controller page
// (`host: 'page'` and the worker fallback) and the controller frame all
// construct descriptors through here, so the option means the same
// wherever the transport runs.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import Http3Transport, { type Http3Options } from './http3/Http3Transport';

/** `http3` in a descriptor: a function (`udp`) cannot be cloned into a worker */
export type Http3DescriptorOptions = Omit<Http3Options, 'udp'>;

export interface ConstructibleTransport {
	/** module URL, already resolved */
	module: string;
	options?: unknown[];
	http3?: boolean | Http3DescriptorOptions;
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

export async function constructTransport({
	module,
	options,
	http3,
}: ConstructibleTransport): Promise<ProxyTransport> {
	const { default: Transport } = (await import(/* @vite-ignore */ module)) as {
		default: new (...args: unknown[]) => ProxyTransport;
	};
	if (typeof Transport !== 'function')
		throw new TypeError(`${module} has no default export to construct`);
	const transport = new Transport(...(options || []));
	if (!http3) return transport;
	// stomp-h3 ships in epoxy-transport's dist/h3/ (deploy/epoxy/h3)
	return new Http3Transport(
		transport,
		http3 === true ? {} : http3,
		new URL('h3/stomp_h3.js', module).href,
	);
}
