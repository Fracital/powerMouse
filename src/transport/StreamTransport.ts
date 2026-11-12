import { closePort, privateChannel } from './ports';
import RemoteTransport from './RemoteTransport';

/**
 * The document's transport with raw wisp streams, for the WebRTC worker
 * (docs/webrtc-over-wisp.md): a subclass of its own, so that what every
 * document's inject carries (RemoteTransport) has none of it.
 */
export default class StreamTransport extends RemoteTransport {
	/**
	 * A wisp UDP stream to `host:port`, or a TCP (TLS when `tls`) one, as a
	 * port carrying StreamMessages; rejects when the transport cannot open
	 * it.
	 */
	async stream(
		kind: 'udp' | 'tcp',
		host: string,
		port: number,
		tls = false,
	): Promise<MessagePort> {
		const [kept, handed] = privateChannel();
		const result =
			kind === 'udp'
				? await this.rpc.call('udp', { host, port, stream: handed }, [handed])
				: await this.rpc.call('tcp', { host, port, tls, stream: handed }, [
						handed,
					]);
		if (result.result === 'failure') {
			closePort(kept);
			throw new Error(result.error);
		}
		return kept;
	}
}
