/**
 * The field the service worker adds to each request it sends the transport,
 * naming the request's network partition (its top-level site, and whether
 * the context is cross-site to it). A transport that keeps a connection
 * pool per partition says it reads this field (`fieldSupport.partition`,
 * our epoxy build: a pool of its own per partition over the one wisp
 * connection) and takes it off; serveTransport takes it off for any other
 * transport, so it never goes out. Http3Transport keys its alt-svc
 * knowledge and QUIC connections by it. A file of its own: no inject
 * bundle carries it.
 */
export const NETWORK_PARTITION = '$stomp$network';

/**
 * A network partition's name, as the field carries it: the top-level site
 * (`top`, or the context's own site `frame` when it has none) and whether
 * the context is cross-site to it (another site, or a context in a
 * partition: `partitioned`); 'opaque' for a context with neither. The
 * service worker's HSTS store is kept under the same names
 * (src/server/hsts.ts).
 */
export function networkPartitionName(
	top: string | null,
	frame: string | null,
	partitioned: boolean,
): string {
	const networkTop = top ?? frame;
	if (networkTop === null) return 'opaque';
	return `${networkTop} ${
		networkTop !== frame || partitioned ? 'cross-site' : 'same-site'
	}`;
}
