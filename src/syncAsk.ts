// A page's synchronous ask for the answer to a request of the synchronous
// bridge (src/inject/dom/syncAnswer.ts, a deferred part's own file, and
// src/server/Sync.ts answers): what the two sides say to each other.

/**
 * The header of the service worker's own reply to an ask, which no
 * server's reply has
 */
export const SYNC_ANSWER_HEADER = 'x-stomp-sync-answer';

/**
 * The header of a document's question whether its synchronous request
 * reaches the worker: a HEAD for the rewriter library's file, which the
 * worker answers itself (with SYNC_ANSWER_HEADER) and the host's server
 * answers as the file it serves. Only the inject sends it: no page's
 * request has that URL (a page's URLs are routes).
 */
export const SYNC_PROBE_HEADER = 'x-stomp-sync-probe';

/**
 * How long one ask waits for an answer not made yet, in ms: under the
 * bridge's SYNC_KICK_MS (src/transport/messages.ts), so the kick of a
 * worker that lost its controller goes out on time between two asks
 */
export const SYNC_ASK_MS = 250;
