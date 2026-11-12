// A document's WebRTC worker (dist/rtcWorker.js, docs/webrtc-over-wisp.md):
// the inject starts one the first time a document constructs an
// RTCPeerConnection and hands it a transport port and the stack's module.
// It instantiates the stack (rust/rtc, str0m in wasm, sans-IO), drives it
// (records in, records out, a timer), owns the wisp streams every packet
// travels on, and answers the page's RTCPeerConnection stand-in over a port
// per connection. Nothing here opens a socket: the only network is the
// transport port, which carries wisp streams.
import StreamTransport from '../transport/StreamTransport';
import { generateCertificate, type Certificate } from './certificate';
import { Connection, loadStack, type Stack } from './connection';
import { stackFormats, type Formats } from './formats';
import type {
	RtcWorkerConnection,
	RtcWorkerInit,
	RtcWorkerTemplate,
	WorkerEvent,
} from './protocol';
import { parseSdp, type ParsedSdp } from './sdp';

declare const self: DedicatedWorkerGlobalScope;

// --- the worker ---

let stack: Promise<Stack> | null = null;
let transport: StreamTransport | null = null;
let certificate: Promise<Certificate> | null = null;
/**
 * This browser's own offer: what the stack negotiates is read from it (its
 * formats; the stack's own when it was told none), and the media sections
 * the page reads are written in its shape
 */
let formats: Promise<{ formats: Formats; template: ParsedSdp } | null> =
	Promise.resolve(null);
let templated: ((sdp: string) => void) | null = null;

self.onmessage = async ({
	data,
}: MessageEvent<RtcWorkerInit | RtcWorkerTemplate | RtcWorkerConnection>) => {
	if (data?.kind === 'init') {
		if (data.template)
			formats = new Promise((resolve) => {
				templated = (sdp) => {
					const read = stackFormats(sdp);
					resolve(read && { formats: read, template: parseSdp(sdp) });
				};
			});
		transport = new StreamTransport(data.transport);
		transport.init().catch(() => {});
		certificate = generateCertificate();
		stack = loadStack(data.module, self.location.href).catch((error) => {
			console.error('STomp: the WebRTC stack could not load', error);
			throw error;
		});
	} else if (data?.kind === 'template') templated?.(data.sdp);
	else if (data?.kind === 'connection') {
		const { port, config } = data;
		try {
			const [loaded, cert, negotiable] = await Promise.all([
				stack!,
				certificate!,
				formats,
			]);
			new Connection(
				loaded,
				port,
				transport!,
				config,
				cert,
				negotiable?.formats,
				negotiable?.template,
			);
		} catch (error) {
			port.postMessage({
				ev: 'error',
				message: String((error as Error)?.message || error),
			} satisfies WorkerEvent);
		}
	}
};
