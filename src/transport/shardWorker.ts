// A shard of the transport (ShardedTransport.ts): a worker the transport
// worker starts from its own script, which imports the transport module and
// runs an instance of it for each transport the transport worker makes. Its
// TLS, HTTP and Wisp work for the origins given to it runs on this thread;
// its Wisp connection is a lane of the transport worker's one
// (wispSplit.ts), or a rider of the carrier host's relay that the transport
// worker asked the host for (carrierHost.ts), its packets to and from the
// host directly. Nothing here queues, decorates or rewrites a request: the
// transport worker did that before the request came (serveTransport.ts),
// as for its own transport.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { sendBody } from './bodyPort';
import { withEchCache } from './echCache';
import { base64url, httpsQuery } from './http3/dnsHttps';
import { postToPort, transferablesOf } from './messages';
import { promptSink } from './promptSink';
import { RpcHelper } from './rpc';
import {
	errorText,
	Saturation,
	serveRaw,
	SHARD_RPC,
	type RawKind,
	type RawStream,
	type ShardBound,
	type ShardSocketMessage,
	type ShardToHost,
} from './shards';
import { lanePipe } from './wispSplit';

type RawClient = {
	[kind in `connect_${RawKind}`]?: (url: string) => Promise<RawStream>;
} & { replace_stream_provider?: () => Promise<unknown> };

interface Made {
	transport: ProxyTransport;
	/** whether its epoxy has asked for its wisp connection */
	opened: boolean;
	/** its wisp connections not ended, to end them (ShardBound.cut) */
	lanes: Set<() => void>;
	/** epoxy's DNS-over-HTTPS endpoint for ECH, warmed with the connection */
	resolver?: string;
}

const KINDS: RawKind[] = ['udp', 'tcp', 'tls'];

const clientOf = (transport: ProxyTransport) =>
	(transport as { client?: RawClient | null }).client ?? null;

/** a request body as the transport takes it (what crossed: a stream, bytes, text, a Blob) */
const bodyOf = (body: unknown) => (body ?? null) as BodyInit | null;

export function serveShard(scope: DedicatedWorkerGlobalScope) {
	const made = new Map<number, Made>();
	const get = (instance: number) => {
		const found = made.get(instance);
		if (!found) throw new Error('Stomp: the shard has no such transport');
		return found;
	};

	// the transport worker spreads origins by it (ShardedTransport.ts)
	const saturation = new Saturation((saturated) => {
		rpc.call('load', saturated).catch(() => {});
	});
	const rpc = new RpcHelper<ShardBound, ShardToHost>(
		{
			make: async ({ instance, module, options }) => {
				const { default: Transport } = (await import(
					/* @vite-ignore */ module
				)) as { default: new (...args: unknown[]) => ProxyTransport };
				const [first, ...rest] = options as [Record<string, unknown>];
				const entry = { opened: false, lanes: new Set() } as Made;
				// epoxy's function transport: a lane of the transport worker's
				// wisp connection each time it asks for one (or a rider of the
				// carrier host's, the transport worker's relay)
				const wisp = async (v2: boolean) => {
					entry.opened = true;
					const lane = await rpc.call('lane', { instance, v2 });
					const pipe = lanePipe(
						lane.port,
						() => saturation.busy(),
						lane.credit,
					);
					// one a carrier: the set holds the few a transport's life has
					entry.lanes.add(pipe.end);
					return { read: pipe.read, write: promptSink(pipe.write) };
				};
				// epoxy's ECH answers kept as the transport worker's are (echCache.ts)
				entry.transport = new Transport(
					...withEchCache([{ ...first, wisp }, ...rest]),
				);
				if (typeof first.ech_dns === 'string') entry.resolver = first.ech_dns;
				await entry.transport.init();
				made.set(instance, entry);
				const client = clientOf(entry.transport);
				return [
					{
						fieldSupport: (entry.transport as { fieldSupport?: unknown })
							.fieldSupport,
						raw: KINDS.filter(
							(kind) => typeof client?.[`connect_${kind}`] === 'function',
						),
					},
					[],
				];
			},
			drop: async (instance) => {
				made.delete(instance);
			},
			cut: async (instance) => {
				const entry = made.get(instance);
				if (!entry) return;
				for (const end of [...entry.lanes]) end();
				entry.lanes.clear();
			},
			warm: async (instance) => {
				const entry = get(instance);
				const client = clientOf(entry.transport);
				if (
					entry.opened ||
					typeof client?.replace_stream_provider !== 'function'
				)
					return;
				entry.opened = true;
				await client.replace_stream_provider();
				if (entry.resolver)
					void warmResolver(entry.transport, entry.resolver).catch(() => {});
			},
			request: async ({ instance, remote, method, body, headers }) => {
				const { transport } = get(instance);
				let response;
				try {
					response = await transport.request(
						new URL(remote),
						method,
						bodyOf(body),
						headers,
						undefined,
					);
				} catch (error) {
					// the text is what RevivingTransport reads
					throw new Error(errorText(error), { cause: error });
				}
				if (response.body instanceof ReadableStream) {
					const pushed = sendBody(
						response.body as ReadableStream<Uint8Array>,
						true,
					);
					return [{ ...response, body: pushed }, [pushed.$stompBodyPort]];
				}
				return [response, transferablesOf(response.body)];
			},
			connect: async ({ instance, url, protocols, requestHeaders, port }) => {
				const { transport } = get(instance);
				let settle!: (result: ShardBound['connect'][1]) => void;
				const result = new Promise<ShardBound['connect'][1]>(
					(resolve) => (settle = resolve),
				);
				let open = false;
				const tell = (message: ShardSocketMessage) =>
					postToPort(
						port,
						message,
						message.type === 'data' ? transferablesOf(message.data) : [],
					);
				const [send, close] = transport.connect(
					new URL(url),
					protocols,
					requestHeaders,
					(protocol, extensions) => {
						open = true;
						settle({ result: 'success', protocol, extensions });
					},
					(data) => tell({ type: 'data', data }),
					(code, reason) => tell({ type: 'close', code, reason }),
					(error) => {
						if (open) tell({ type: 'error', error: errorText(error) });
						else settle({ result: 'failure', error: errorText(error) });
					},
				);
				port.onmessage = ({ data }: MessageEvent<ShardSocketMessage>) => {
					if (data.type === 'data') send(data.data);
					else if (data.type === 'close') close(data.code, data.reason);
				};
				port.start();
				return [await result, []];
			},
			raw: async ({ instance, kind, url, port }) => {
				const client = clientOf(get(instance).transport);
				const connect = client?.[`connect_${kind}`];
				if (typeof connect !== 'function') {
					port.close();
					throw new Error(`no ${kind.toUpperCase()} on this transport`);
				}
				let raw: RawStream;
				try {
					raw = await Reflect.apply(connect, client, [url]);
				} catch (error) {
					port.close();
					throw new Error(errorText(error), { cause: error });
				}
				serveRaw(port, raw);
				return [
					{
						send: typeof raw.send === 'function',
						closeReason: typeof raw.closeReason === 'function',
					},
					[],
				];
			},
		},
		SHARD_RPC,
		(data, transfer) => scope.postMessage(data, transfer),
	);
	scope.addEventListener('message', (event) => rpc.receive(event.data));
}

/**
 * The shard's connection to epoxy's DNS-over-HTTPS server for ECH configs,
 * opened with its wisp connection, as serveTransport's warmResolver opens
 * the one of a transport that runs alone: each shard asks it of its own
 * client
 */
export async function warmResolver(
	transport: ProxyTransport,
	resolver: string,
) {
	const url = new URL(resolver);
	url.searchParams.set('dns', base64url(httpsQuery(url.hostname)));
	const response = await transport.request(
		url,
		'GET',
		null,
		[['accept', 'application/dns-message']],
		undefined,
	);
	await new Response(response.body as BodyInit).arrayBuffer();
}
