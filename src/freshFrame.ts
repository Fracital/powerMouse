/**
 * A frame's navigation that a site redirects to another origin
 * (src/inject/dom/freshContext.ts, gate 3). The redirect would commit the
 * other origin's document in the frame's browsing context, where a window
 * the frame's parent reached while it showed the first origin still reads
 * it (every proxied site is the proxy's one origin). The worker answers the
 * redirect with this document instead: it asks the frame's parent, by an
 * event on the frame element, to give the frame a fresh browsing context
 * that requests `to`. Nothing of the other origin has arrived yet. A page
 * may send the same event: the parent goes only to a route of the proxy's
 * scope, which a page may navigate a frame to anyway. A parent that does not
 * take it (none of STomp's) gets the redirect followed in place.
 */
export const FRESH_FRAME_EVENT = '$stomp$freshframe';

export function freshFrameDocument(to: string): string {
	const json = (value: string) =>
		JSON.stringify(value).replace(/</g, '\\u003c');
	return `<!doctype html><script>(() => {
	let taken = false;
	try {
		const element = frameElement;
		taken = !!element && !element.dispatchEvent(new CustomEvent(${json(
			FRESH_FRAME_EVENT,
		)}, { detail: ${json(to)}, cancelable: true }));
	} catch (error) {}
	if (!taken) location.replace(${json(to)});
})()</script>`;
}
