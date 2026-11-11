// Stepping a proxied frame's history from outside, as a browser tab's Back
// and Forward do.
//
// A frame is not a tab. Every frame of the host page shares one joint
// session history with the page and with the other frames (the other tabs
// of a host like the demo), so history.back() from a frame can walk the host
// or a sibling, and a frame's own Navigation API (window.navigation) sees
// neither the entries its nested frames add (a tab's Back steps those
// first) nor anything past its own navigable. Worse, once another frame has
// made entries after this frame's, this frame cannot be traversed to an
// entry older than those without the other frame changing too: Chrome
// refuses that for a sandboxed frame (the traversal's promises reject with a
// SecurityError) and does it for any other, and a new entry in any frame
// prunes the forward entries of all of them.
//
// So each frame keeps a history of its own here, the way a tab has one: the
// steps the frame and its nested frames took, in order. A step is taken with
// the browser's own traversal of the navigable it belongs to whenever the
// browser will do it without touching anything outside the frame (bfcache,
// scroll, form state and same-document popstate are kept); otherwise the
// navigable is sent to the step's URL with location.replace, which leaves
// the joint history as it is.
//
// Everything is read through this realm's (the host page's, or the
// controller frame's) own Navigation API functions: the proxied page's are
// narrowed to its own origin's entries (src/inject/dom/modules/History.ts),
// and a page can replace them.

/** how long to wait for a traversal to commit before reporting it anyway */
const COMMIT_TIMEOUT = 10000;
/**
 * how long a traversal may take to commit before it counts as one the
 * browser dropped (a refusal it does not report), and the step is taken
 * with location.replace instead
 */
const DROPPED_TIMEOUT = 3000;
/** how deep nested frames are followed */
const MAX_DEPTH = 8;

export type Direction = 'back' | 'forward';

type Native = (this: unknown, ...args: unknown[]) => unknown;

const getter = (object: object | undefined, name: string): Native | null =>
	(object && (Reflect.getOwnPropertyDescriptor(object, name)?.get as Native)) ||
	null;
const method = (object: object | undefined, name: string): Native | null =>
	(object &&
		(Reflect.getOwnPropertyDescriptor(object, name)?.value as Native)) ||
	null;

const realm = globalThis as unknown as Record<string, { prototype?: object }>;
const navigationProto = realm.Navigation?.prototype;
const entryProto = realm.NavigationHistoryEntry?.prototype;
const NATIVE = {
	navigation: getter(globalThis, 'navigation'),
	length: getter(globalThis, 'length'),
	entries: method(navigationProto, 'entries'),
	currentEntry: getter(navigationProto, 'currentEntry'),
	traverseTo: method(navigationProto, 'traverseTo'),
	key: getter(entryProto, 'key'),
	id: getter(entryProto, 'id'),
	url: getter(entryProto, 'url'),
};
const supported = Object.values(NATIVE).every((fn) => fn !== null);

const call = (fn: Native | null, that: unknown, ...args: unknown[]) =>
	Reflect.apply(fn!, that, args);

interface Entry {
	key: string;
	url: string;
}

/** a navigable of the frame (the frame itself or a frame nested in it) */
interface Live {
	win: Window;
	nav: object;
	key: string;
	id: string;
	url: string;
}

/** one step of the frame's history: a navigable went from one entry to another */
interface Step {
	from: Entry;
	to: Entry;
	/** when it was recorded, on the clock all frames share */
	at: number;
}

/**
 * The frames of this realm in one joint session history, and a clock their
 * changes to it are counted on: a frame whose step another frame has
 * changed the joint history since (a new entry, or a traversal) cannot
 * count on the browser's traversal leaving the other frame alone
 */
let clock = 0;
const frames = new Set<FrameHistory>();

function entryOf(entry: object): Entry {
	return {
		key: call(NATIVE.key, entry) as string,
		url: (call(NATIVE.url, entry) as string | null) ?? '',
	};
}

/** the frame and the same-origin frames in it, parents first */
function walk(top: Window): Live[] {
	const out: Live[] = [];
	const visit = (win: Window, depth: number) => {
		let nav: object | null;
		let current: object | null;
		try {
			nav = call(NATIVE.navigation, win) as object | null;
			current = nav && (call(NATIVE.currentEntry, nav) as object | null);
		} catch (error) {
			return; // another origin (an opaque document, say): not ours to read
		}
		if (!nav || !current) return;
		out.push({
			win,
			nav,
			...entryOf(current),
			id: call(NATIVE.id, current) as string,
		});
		if (depth >= MAX_DEPTH) return;
		const count = call(NATIVE.length, win) as number;
		for (let i = 0; i < count; i++) {
			const child = (win as unknown as Record<number, Window | undefined>)[i];
			if (child) visit(child, depth + 1);
		}
	};
	visit(top, 0);
	return out;
}

const entriesOf = (nav: object) =>
	(call(NATIVE.entries, nav) as object[]).map(entryOf);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FrameHistory {
	constructor(public win: Window) {}
	/** when this frame last changed the joint history */
	touched = 0;
	steps: Step[] = [];
	/** how many of the steps are taken: the frame is after steps[index - 1] */
	index = 0;
	/**
	 * the entry a navigable's native entry stands for, by native key, where
	 * a step was taken with location.replace (the replaced entry keeps its key
	 * and shows the step's page)
	 */
	alias = new Map<string, string>();
	/** each live navigable's entry at the last look, by window */
	known = new Map<Window, Entry>();
	/** a step that has not committed yet: its navigable and the entry id it left */
	pending: { win: Window; id: string; until: number } | null = null;

	logical(key: string) {
		return this.alias.get(key) ?? key;
	}

	/** read where the frame is, and record the steps it took by itself */
	sync(top: Window) {
		const live = walk(top);
		if (!live.length) return;
		const seen = new Map<Window, Entry>();
		for (const node of live) {
			const entry = { key: this.logical(node.key), url: node.url };
			const before = this.known.get(node.win);
			if (this.pending?.win === node.win) {
				if (node.id === this.pending.id && Date.now() < this.pending.until) {
					// still on the entry it is leaving: keep what the step expects
					seen.set(node.win, before ?? entry);
					continue;
				}
				this.pending = null;
			}
			seen.set(node.win, entry);
			if (!before) {
				// the frame itself, the first time: what it did before is in its
				// own entries (a nested frame that appears takes no step)
				if (node.win === top && !this.steps.length) this.seed(node);
				continue;
			}
			if (before.key === entry.key) {
				// same entry, maybe another URL (location.replace, replaceState)
				if (before.url !== entry.url) this.renamed(entry);
				continue;
			}
			this.moved(node, before, entry);
		}
		this.known = seen;
	}

	/** a frame first seen with entries already: they are its steps */
	seed(node: Live) {
		const entries = entriesOf(node.nav);
		const at = entries.findIndex((entry) => entry.key === node.key);
		for (let i = 1; i < entries.length; i++)
			this.steps.push({ from: entries[i - 1], to: entries[i], at: ++clock });
		this.index = Math.max(at, 0);
		if (entries.length > 1) this.touched = clock;
	}

	/** an entry's URL changed in place: every step that names it follows */
	renamed(entry: Entry) {
		for (const step of this.steps) {
			if (step.from.key === entry.key) step.from = entry;
			if (step.to.key === entry.key) step.to = entry;
		}
	}

	/** a navigable went from `before` to `now` without us */
	moved(node: Live, before: Entry, now: Entry) {
		// a traversal the page made itself (history.back(), go(-2), forward())
		for (let i = this.index - 1; i >= 0; i--) {
			const step = this.steps[i];
			if (step.from.key === now.key) {
				this.index = i;
				return this.renamed(now);
			}
			if (step.to.key === now.key) {
				this.index = i + 1;
				return this.renamed(now);
			}
		}
		for (let i = this.index; i < this.steps.length; i++) {
			const step = this.steps[i];
			if (step.to.key === now.key) {
				this.index = i + 1;
				return this.renamed(now);
			}
		}
		const entries = entriesOf(node.nav).map((entry) => ({
			key: this.logical(entry.key),
			url: entry.url,
		}));
		// the entry it was on is gone: it was replaced under another key (a
		// frame's first document after its initial about:blank), no new entry
		if (!entries.some((entry) => entry.key === before.key)) {
			for (const step of this.steps) {
				if (step.from.key === before.key) step.from = now;
				if (step.to.key === before.key) step.to = now;
			}
			return;
		}
		// a new entry: every native entry between the two is a step (two
		// pushState calls before anyone looked are two steps)
		this.steps.length = this.index;
		const end = entries.findIndex((entry) => entry.key === now.key);
		const start = entries.findIndex((entry) => entry.key === before.key);
		if (start !== -1 && end > start) {
			entries[start] = before;
			for (let i = start + 1; i <= end; i++)
				this.steps.push({ from: entries[i - 1], to: entries[i], at: ++clock });
		} else this.steps.push({ from: before, to: now, at: ++clock });
		this.index = this.steps.length;
		this.touched = clock;
	}

	/** take one step back or forward; false when there is none */
	async step(top: Window, direction: Direction): Promise<boolean> {
		this.sync(top);
		const back = direction === 'back';
		const delta = back ? -1 : 1;
		const step = this.steps[back ? this.index - 1 : this.index];
		if (!step) return false;
		const holder = back ? step.to : step.from;
		const target = back ? step.from : step.to;
		const node = walk(top).find(
			(candidate) => this.logical(candidate.key) === holder.key,
		);
		if (!node) {
			// its navigable is gone (the frame that took it was removed, or
			// came back as a new one when its page was gone back to): the
			// press uses the step up and nothing moves, as natively
			this.index += delta;
			return true;
		}
		this.go(node, target, holder, delta, step.at);
		this.index += delta;
		await this.committed(top, node);
		return true;
	}

	/** send one navigable to an entry of its history */
	go(node: Live, target: Entry, holder: Entry, delta: number, at: number) {
		const pending = {
			win: node.win,
			id: node.id,
			until: Date.now() + COMMIT_TIMEOUT,
		};
		this.pending = pending;
		this.known.set(node.win, target);
		// replacing the entry leaves the joint history as it is: the entry
		// keeps its key and stands for the target from now on
		const replace = () => {
			if (node.key === target.key) this.alias.delete(node.key);
			else this.alias.set(node.key, target.key);
			node.win.location.replace(target.url);
		};
		// the browser's own traversal, to the native entry that shows the
		// target, unless another frame moved the joint history since the step
		const native = entriesOf(node.nav).find(
			(entry) => this.logical(entry.key) === target.key,
		);
		if (!native || this.crossed(at)) return replace();
		this.touched = ++clock;
		const traversal = call(NATIVE.traverseTo, node.nav, native.key) as {
			committed: Promise<unknown>;
			finished: Promise<unknown>;
		};
		traversal.finished.catch(() => {});
		// a traversal that would change a frame outside this one (another
		// tab's entries came after this one's) is refused at once; one that
		// starts settles when it commits, if its document lives that long
		traversal.committed.catch((error: { name?: string }) => {
			if (this.pending !== pending) return;
			if (
				error?.name === 'SecurityError' ||
				error?.name === 'InvalidStateError'
			)
				return replace();
			// cancelled by another navigation before it committed: the step was
			// not taken
			try {
				const current = call(
					NATIVE.currentEntry,
					call(NATIVE.navigation, node.win),
				) as object | null;
				if (!current || call(NATIVE.id, current) !== node.id) return;
			} catch (error) {
				return;
			}
			this.pending = null;
			this.known.set(node.win, holder);
			this.index -= delta;
		});
		// a traversal Chrome drops without a word never commits
		setTimeout(() => {
			if (this.pending !== pending) return;
			try {
				const current = call(
					NATIVE.currentEntry,
					call(NATIVE.navigation, node.win),
				) as object | null;
				if (current && call(NATIVE.id, current) === node.id) replace();
			} catch (error) {
				// the frame left our origin
			}
		}, DROPPED_TIMEOUT);
	}

	/** whether another live frame changed the joint history after `at` */
	crossed(at: number) {
		for (const other of frames) {
			if (other === this) continue;
			if (other.win.closed) frames.delete(other);
			else if (other.touched > at) return true;
		}
		return false;
	}

	/** resolves once the navigable left the entry it was on (or timed out) */
	async committed(top: Window, node: Live) {
		while (this.pending?.win === node.win && Date.now() < this.pending.until) {
			await sleep(50);
			try {
				const current = call(
					NATIVE.currentEntry,
					call(NATIVE.navigation, node.win),
				) as object | null;
				if (current && call(NATIVE.id, current) !== node.id) break;
			} catch (error) {
				break; // the frame left our origin; nothing more to wait for
			}
		}
		this.sync(top);
	}

	can(direction: Direction) {
		return direction === 'back'
			? this.index > 0
			: this.index < this.steps.length;
	}
}

const histories = new WeakMap<Window, FrameHistory>();

function historyOf(win: Window) {
	let history = histories.get(win);
	if (!history) {
		histories.set(win, (history = new FrameHistory(win)));
		frames.add(history);
	}
	return history;
}

/**
 * Record what the frame did since the last look (call it whenever the frame
 * or a frame in it reports; the other functions call it too).
 */
export function syncHistory(win: Window | null | undefined) {
	if (!win || !supported) return;
	try {
		historyOf(win).sync(win);
	} catch (error) {
		// the frame is between documents or left our origin
	}
}

/** whether the frame's history has an entry in `direction`; null when the browser cannot tell */
export function canTraverse(
	win: Window | null | undefined,
	direction: Direction,
): boolean | null {
	if (!supported) return null;
	if (!win) return false;
	syncHistory(win);
	return historyOf(win).can(direction);
}

/**
 * Step the frame's history. Resolves false when there is nothing to go to,
 * true once the step has committed (so a second call computes its target
 * from the entry the first one reached). Without the Navigation API the step
 * is issued blind through history.back(), which the caller should only do
 * when it knows the frame has somewhere to go.
 */
export async function traverse(
	win: Window,
	direction: Direction,
): Promise<boolean> {
	if (!supported) {
		if (direction === 'back') win.history.back();
		else win.history.forward();
		return true;
	}
	try {
		return await historyOf(win).step(win, direction);
	} catch (error) {
		return false; // the frame is between documents or left our origin
	}
}
