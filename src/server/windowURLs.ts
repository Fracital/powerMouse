/**
 * The real URL of the document a window of this worker shows, read off the
 * window's own URL when it is a route of one of this worker's controllers
 * (each server adds its routes' reader, by its directory). The jar's and
 * the stores' change notes go to the windows whose documents they are for,
 * and to any window whose document no route names (about:srcdoc, blob:, a
 * host's own page): an ad-heavy page keeps a hundred frames of the ad
 * networks' cookie syncs, and a note to every window for each change was a
 * task in every one of them (apnews.com: 2,620 changes of the jar made
 * 290,000 messages in 36 s).
 */
const readers = new Map<string, (url: string) => string | null | undefined>();

/**
 * `read`: the real URL a route of this directory stands for, null for one
 * of its routes it cannot read, undefined for a URL that is not its
 */
export function addWindowRoutes(
	directory: string,
	read: (url: string) => string | null | undefined,
) {
	readers.set(directory, read);
	seen.clear();
}

/** a window's URL -> its document's real URL, null when no route names it */
const seen = new Map<string, URL | null>();
const SEEN_LIMIT = 2048;

export function windowURL(url: string): URL | null {
	const known = seen.get(url);
	if (known !== undefined) return known;
	let real: URL | null = null;
	for (const read of readers.values()) {
		const found = read(url);
		if (found === undefined) continue;
		try {
			real = found === null ? null : new URL(found);
		} catch (error) {
			real = null;
		}
		break;
	}
	if (seen.size >= SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
	seen.set(url, real);
	return real;
}
