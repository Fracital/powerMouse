// What the browser makes of cross-origin isolation where engines differ
// (src/isolation.ts IsolationEngine), asked of the browser itself: a worker
// and frames of the controller's document load what the service worker
// answers with the headers in question (src/server/rewrites.ts,
// ISOLATION_PROBE), and what each became says what the browser did with
// them. Measured in Chrome 157, Firefox 157 and WebKitGTK 2.52.4, in a page
// that sends COOP same-origin and COEP require-corp, with the service
// worker's own responses (WebKit checks no embedder policy of a frame's
// document a service worker answered, so no frame can ask about one):
// - a dedicated worker with COEP `credentialless` is isolated where the
//   browser has that policy, and is not where it reads it as none (WebKit);
// - a frame with COEP `require-corp` whose `allow` gives up the
//   `cross-origin-isolated` permission is not isolated where the browser
//   has the permission (Chrome), and is isolated where it isolates every
//   frame of an isolated page (Firefox, WebKit);
// - a frame with a Document-Isolation-Policy is in an agent cluster of its
//   own where the browser has the policy (Chrome: its document is out of
//   reach, and it says it is isolated in a message), and an ordinary frame
//   elsewhere.
// The first two say something only in a page that is isolated; the service
// worker asks them only of one (Rewriter.isolationEngine).
import { ISOLATION_PROBE, type IsolationEngine } from '../isolation';

/** how long one frame may take to say anything; then the browser could not be asked */
const PROBE_MS = 5000;

/**
 * What a probe frame became: whether its document is isolated, `refused`
 * when the browser loaded something else in its place, or null when it did
 * not load in time. `apart`: its document is out of this one's reach and
 * said so in a message.
 */
type Probed = { isolated: boolean; apart: boolean } | 'refused' | null;

/** whether the probe worker (`c`) is isolated; null when it did not say in time */
function probeWorker(directory: string): Promise<boolean | null> {
	return new Promise((resolve) => {
		let worker: Worker | undefined;
		const done = (isolated: boolean | null) => {
			clearTimeout(timer);
			worker?.terminate();
			resolve(isolated);
		};
		const timer = setTimeout(() => done(null), PROBE_MS);
		try {
			worker = new Worker(`${directory}${ISOLATION_PROBE}/c`);
		} catch (error) {
			done(null);
			return;
		}
		worker.onmessage = (event) => done(event.data === true);
		worker.onerror = () => done(null);
	});
}

function probeFrame(directory: string, kind: 'p' | 'd'): Promise<Probed> {
	return new Promise((resolve) => {
		const frame = document.createElement('iframe');
		frame.allow = "cross-origin-isolated 'none'";
		frame.hidden = true;
		frame.style.display = 'none';
		const done = (probed: Probed) => {
			clearTimeout(timer);
			removeEventListener('message', heard);
			frame.remove();
			resolve(probed);
		};
		const heard = (event: MessageEvent) => {
			if (
				event.source !== frame.contentWindow ||
				typeof event.data !== 'string' ||
				!event.data.startsWith(ISOLATION_PROBE)
			)
				return;
			let own: Document | null = null;
			try {
				own = frame.contentDocument;
			} catch (error) {
				// out of reach
			}
			// a document of this one's agent cluster is read at its load
			if (own) return;
			done({
				isolated: event.data === `${ISOLATION_PROBE}true`,
				apart: true,
			});
		};
		const timer = setTimeout(() => done(null), PROBE_MS);
		addEventListener('message', heard);
		frame.addEventListener('load', () => {
			let own: Document | null = null;
			try {
				own = frame.contentDocument;
			} catch (error) {
				// out of reach: its message says what it is
			}
			if (own?.title === ISOLATION_PROBE)
				done({
					isolated: frame.contentWindow?.crossOriginIsolated === true,
					apart: false,
				});
			// an error page in its place; a document apart says so in its
			// message, which may come after its load
			else if (own || kind === 'p') done('refused');
		});
		frame.src = `${directory}${ISOLATION_PROBE}/${kind}`;
		(document.body ?? document.documentElement).append(frame);
	});
}

/**
 * What this browser makes of cross-origin isolation, by frames of this
 * document under `directory` (the controller's address); null when it could
 * not tell. In a document that is not isolated only the
 * Document-Isolation-Policy is asked about (the rest is Chrome's, and moot
 * there).
 */
export async function probeIsolation(
	directory: string,
): Promise<IsolationEngine | null> {
	const isolated = globalThis.crossOriginIsolated === true;
	const skip = Promise.resolve('skip' as const);
	const [credentialless, permission, dip] = await Promise.all([
		isolated ? probeWorker(directory) : skip,
		isolated ? probeFrame(directory, 'p') : skip,
		probeFrame(directory, 'd'),
	]);
	if (
		credentialless === null ||
		permission === null ||
		permission === 'refused' ||
		dip === null ||
		dip === 'refused'
	)
		return null;
	return {
		credentialless: credentialless !== false,
		permission: permission === 'skip' || !permission.isolated,
		dip: dip.apart && dip.isolated,
	};
}
