/**
 * The field the service worker adds to each request it sends the transport,
 * saying where the request waits for a connection (src/transport/socketPool.ts):
 * its urgency, as Chrome's socket pool orders the requests waiting for a
 * socket, and whether it carries credentials (Chrome keeps requests without
 * them on connections of their own). serveTransport takes it off, so it
 * never goes out. A file of its own: no inject bundle carries it.
 */
export const REQUEST_QUEUE = '$stomp$queue';

/** the field's value */
export const queueValue = (urgency: number, credentialed: boolean) =>
	`${urgency} ${credentialed ? 'credentialed' : 'anonymous'}`;
