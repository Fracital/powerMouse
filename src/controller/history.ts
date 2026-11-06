// Stepping a frame's history from outside. history.back() is the wrong tool
// for that: history.length counts the joint session history of the whole
// page, and history.back() from a frame's first entry traverses that joint
// history, which navigates the host page (or a sibling frame) out from under
// the application. The Navigation API (window.navigation) is scoped to the
// frame's own entries. TypeScript's DOM lib does not declare it yet.

export interface NavigationLike {
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly currentEntry: { readonly index: number } | null;
	back(): { committed: Promise<unknown>; finished: Promise<unknown> };
	forward(): { committed: Promise<unknown>; finished: Promise<unknown> };
}

/** how long to wait for a traversal to commit before reporting it anyway */
const COMMIT_TIMEOUT = 10000;

export type Direction = 'back' | 'forward';

function navigationOf(win: Window | null | undefined): NavigationLike | null {
	return (
		(win as (Window & { navigation?: NavigationLike }) | null | undefined)
			?.navigation ?? null
	);
}

/** whether the frame's own history has an entry in `direction`; null when the browser cannot tell */
export function canTraverse(
	win: Window | null | undefined,
	direction: Direction,
): boolean | null {
	const nav = navigationOf(win);
	if (!nav) return null;
	return direction === 'back' ? nav.canGoBack : nav.canGoForward;
}

/**
 * Step the frame's own history. Resolves false when there is nothing to go
 * to, true once the traversal has committed (so a second call computes its
 * target from the entry the first one reached). Without the Navigation API
 * the step is issued blind through history.back(), which the caller should
 * only do when it knows the frame has somewhere to go.
 */
export async function traverse(
	win: Window,
	direction: Direction,
): Promise<boolean> {
	const nav = navigationOf(win);
	if (!nav) {
		if (direction === 'back') win.history.back();
		else win.history.forward();
		return true;
	}
	if (!(direction === 'back' ? nav.canGoBack : nav.canGoForward)) return false;
	const before = nav.currentEntry?.index;
	const { committed, finished } =
		direction === 'back' ? nav.back() : nav.forward();
	// those promises belong to the document being left, and for a
	// cross-document traversal that document goes away before they settle;
	// the entry index on the (new) window is what tells us the step landed
	committed.catch(() => {});
	finished.catch(() => {});
	const deadline = Date.now() + COMMIT_TIMEOUT;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		try {
			if (navigationOf(win)?.currentEntry?.index !== before) break;
		} catch {
			break; // the frame left our origin; nothing more to wait for
		}
	}
	return true;
}
