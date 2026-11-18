/**
 * The field the service worker adds to each request it sends the transport,
 * saying where the request waits for a connection (src/transport/socketPool.ts):
 * its urgency, as Chrome's socket pool orders the requests waiting for a
 * socket, whether it carries credentials (Chrome keeps requests without
 * them on connections of their own), and the worker's name for it, under
 * which a page's abort cancels it and an image the page laid out in its
 * viewport is raised (RemoteTransport requeue), when the browser asked the
 * worker for it (ms since the epoch: of one urgency, the first asked goes
 * first), and, for an image, a fifth word: the transport tells the worker
 * when such a request has to wait (HostToTransport waiting). serveTransport takes it off, so it never goes
 * out. A file of its own: no inject bundle carries it.
 */
export const REQUEST_QUEUE = '$stomp$queue';

/** the field's value */
export const queueValue = (
	urgency: number,
	credentialed: boolean,
	id: string,
	asked: number,
	image: boolean,
) =>
	`${urgency} ${credentialed ? 'credentialed' : 'anonymous'} ${id} ${asked}${image ? ' image' : ''}`;

/** the urgency Chrome raises an image in the viewport to once laid out (a fetch's) */
export const SEEN_URGENCY = 1;

/**
 * Chrome's urgency for a document's first images, before it has laid any
 * out (a script's): see rewrites.ts boostedImage
 */
export const FIRST_IMAGES_URGENCY = 2;
