import type { MediaVerdict } from '../transport/messages';

/** how long Chrome may take over a request the frame's policy refuses */
const VERDICT_MS = 4000;

/** the verdict before, settled: they are made one at a time */
let last: Promise<void> = Promise.resolve();

/**
 * What Chrome answers `getUserMedia(constraints)` before it looks at the
 * permissions policy or the permission (docs/permissions.md). Chrome
 * settles a request in that order: malformed constraints (TypeError), the
 * devices and the constraints against them (NotFoundError,
 * OverconstrainedError), the policy, the permission. A proxied page's
 * policy and permission are STomp's to answer, and its refusal must come
 * after the same checks, which only the browser can make; calling the
 * page's own `getUserMedia` to learn them could prompt the user or open the
 * device.
 *
 * So the request is made in a frame of this document (the proxy origin, as
 * the page is: device ids are an origin's) whose `allow` turns the camera
 * and the microphone off. Chrome gets as far as the policy there and no
 * further: NotAllowedError says everything before it passed, anything else
 * is the answer the page would get first. It cannot prompt, and no device
 * opens. Null: no verdict (no frame, no answer in time).
 *
 * One request at a time: the frame is in the host's document for as long
 * as Chrome takes (it never answers a frame that left its document), and a
 * page that asks a thousand times at once must not put a thousand there.
 */
export function mediaVerdict(
	constraints: unknown,
): Promise<MediaVerdict | null> {
	const verdict = last.then(() => verdictOf(constraints));
	last = verdict.then(
		() => {},
		() => {},
	);
	return verdict;
}

async function verdictOf(constraints: unknown): Promise<MediaVerdict | null> {
	const frame = document.createElement('iframe');
	frame.setAttribute('allow', "camera 'none'; microphone 'none'");
	frame.hidden = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		document.documentElement.appendChild(frame);
		const media = frame.contentWindow?.navigator.mediaDevices;
		if (!media) return null;
		const stream = await Promise.race([
			media.getUserMedia(constraints as MediaStreamConstraints),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), VERDICT_MS);
			}),
		]);
		// the frame's policy refuses both: a stream is not an answer
		for (const track of stream?.getTracks() ?? []) track.stop();
		return null;
	} catch (error) {
		const { name, message, constraint } = error as {
			name?: unknown;
			message?: unknown;
			constraint?: unknown;
		};
		if (typeof name !== 'string') return null;
		return {
			name,
			message: typeof message === 'string' ? message : '',
			...(typeof constraint === 'string' ? { constraint } : {}),
		};
	} finally {
		clearTimeout(timer);
		frame.remove();
	}
}
