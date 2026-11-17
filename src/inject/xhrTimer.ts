// An asynchronous XMLHttpRequest's timeout, for the document's stand-in and
// the worker's. Chrome keeps the timeout in its network service, off the
// page's thread, so a long task on that thread never makes an answer that
// came in time lose to the timer. The timer here is the thread's own and
// waits behind the same long task, ahead of the answer's own tasks: one
// that fires late leaves the verdict to the service worker, which keeps the
// same timeout on its clock (TIMEOUT_HEADER) and answers the timeout itself,
// and an answer already waiting is read first. The request expires on this
// side only if neither has come within a grace.

import { TIMEOUT_HEADER } from '../transport/messages';

// taken when the bundle loads, before any page code
const dateNow = Date.now;
/** how late a timer may fire and still be on time (the thread was not held up) */
const LATE_MS = 20;
/** how long a late timer waits for the worker's verdict */
const GRACE_MS = 100;

/**
 * Arms the timeout of a request sent now: `set` keeps the current timer's
 * id (the caller clears it), `expire` ends the request with a timeout.
 */
export function armTimeout(
	ms: number,
	set: (timer: ReturnType<typeof setTimeout>) => void,
	expire: () => void,
) {
	const due = dateNow() + ms;
	set(
		setTimeout(() => {
			if (dateNow() - due <= LATE_MS) expire();
			else set(setTimeout(expire, GRACE_MS));
		}, ms),
	);
}

/**
 * whether the worker answered that the request is past its timeout: the
 * header names the request's abort id, which no site ever sees
 */
export const timedOut = (response: Response, id: string) =>
	response.headers.get(TIMEOUT_HEADER) === id;
