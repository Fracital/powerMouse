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
import type {
	RtcWorkerConnection,
	RtcWorkerInit,
	WorkerEvent,
} from './protocol';

declare const self: DedicatedWorkerGlobalScope;

// --- the worker ---

let stack: Promise<Stack> | null = null;
let transport: StreamTransport | null = null;
let certificate: Promise<Certificate> | null = null;

self.onmessage = async ({
	data,
}: MessageEvent<RtcWorkerInit | RtcWorkerConnection>) => {
	if (data?.kind === 'init') {
		transport = new StreamTransport(data.transport);
		transport.init().catch(() => {});
		certificate = generateCertificate();
		stack = loadStack(data.module, self.location.href).catch((error) => {
			console.error('STomp: the WebRTC stack could not load', error);
			throw error;
		});
	} else if (data?.kind === 'connection') {
		const { port, config } = data;
		try {
			const [loaded, cert] = await Promise.all([stack!, certificate!]);
			new Connection(loaded, port, transport!, config, cert);
		} catch (error) {
			port.postMessage({
				ev: 'error',
				message: String((error as Error)?.message || error),
			} satisfies WorkerEvent);
		}
	}
};
