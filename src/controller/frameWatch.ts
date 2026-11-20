// What a RemoteController's wait() says when its controller frame never
// answers. The browser shows a frame it blocked as an error page and fires
// its load event all the same, and the host page's ReportingObserver hears
// why: a csp-violation report for the proxy origin's frame-ancestors, a
// coep report for a response the host's embedder policy refuses (both
// measured in Chrome 157).
import { CONTROLLER_FRAME_ERROR } from './messages';

/**
 * how long a controller frame that loaded has to answer: its script posts
 * its first message when it runs, before the frame's load event
 */
export const FRAME_ANSWER_MS = 5000;
/** how long it has to load at all */
export const FRAME_LOAD_MS = 60000;

function frameError(message: string): Error {
	const error = new Error(message);
	error.name = CONTROLLER_FRAME_ERROR;
	return error;
}

const originOf = (url: unknown) => {
	try {
		return new URL(String(url));
	} catch (error) {
		return null;
	}
};

/** the cause a report of the host page's names for the frame at `src`, if it is about that frame */
function blockedBy(report: Report, src: URL): string | null {
	// (a coep report's body has no attributes in Chrome 157, only its JSON)
	const body = (report.body?.toJSON?.() ?? {}) as Record<string, unknown>;
	const blocked = originOf(body.blockedURL);
	if (!blocked || blocked.origin !== src.origin) return null;
	const at = `The controller frame at ${src.href} did not load:`;
	if (
		report.type === 'csp-violation' &&
		body.effectiveDirective === 'frame-ancestors'
	)
		return `${at} the proxy origin's Content-Security-Policy (${String(body.originalPolicy)}) has a frame-ancestors that does not list ${location.origin}. Add ${location.origin} to it.`;
	if (report.type === 'coep' && blocked.pathname === src.pathname)
		return body.type === 'navigation'
			? `${at} this page sends Cross-Origin-Embedder-Policy, so a frame of another origin needs one of its own, and the frame's response has none. Serve the proxy origin's files with Cross-Origin-Embedder-Policy: require-corp.`
			: `${at} this page sends Cross-Origin-Embedder-Policy, so the frame's response needs a Cross-Origin-Resource-Policy, and it has none. Serve the proxy origin's files with Cross-Origin-Resource-Policy: cross-origin.`;
	return null;
}

/**
 * Watch the controller frame `element` until the returned stop() is
 * called (its first message came): `fail` gets a ControllerFrameError when
 * the browser reports the frame blocked, when it loaded and did not answer
 * within FRAME_ANSWER_MS, or when it did not load within FRAME_LOAD_MS.
 */
export function watchFrame(
	element: HTMLIFrameElement,
	fail: (error: Error) => void,
): () => void {
	const src = new URL(element.src);
	let observer: ReportingObserver | undefined;
	let answer: ReturnType<typeof setTimeout> | undefined;
	const loaded = () => {
		clearTimeout(answer);
		answer = setTimeout(
			() =>
				failed(
					`The controller frame at ${src.href} loaded but did not answer within ${FRAME_ANSWER_MS / 1000} s. Check that the URL serves dist/controllerFrame.html and its script (not a 404 or another page: proxyOrigin, directory and assets.controllerFrame make it), and that no header of the proxy origin keeps it out of this page (X-Frame-Options, or a frame-ancestors without ${location.origin}).`,
				),
			FRAME_ANSWER_MS,
		);
	};
	const load = setTimeout(
		() =>
			failed(
				`The controller frame at ${src.href} did not load within ${FRAME_LOAD_MS / 1000} s.`,
			),
		FRAME_LOAD_MS,
	);
	const stop = () => {
		observer?.disconnect();
		clearTimeout(answer);
		clearTimeout(load);
		element.removeEventListener('load', loaded);
	};
	const failed = (message: string) => {
		stop();
		fail(frameError(message));
	};
	element.addEventListener('load', loaded);
	if (typeof ReportingObserver === 'function')
		try {
			observer = new ReportingObserver(
				(reports) => {
					for (const report of reports) {
						const cause = blockedBy(report, src);
						if (cause) return failed(cause);
					}
				},
				{ types: ['csp-violation', 'coep'] },
			);
			observer.observe();
		} catch (error) {
			// no reports: the load event's bound still applies
		}
	return stop;
}
