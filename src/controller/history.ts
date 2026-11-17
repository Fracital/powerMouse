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
/** how long a document's activation report may lag the next document */
const ACTIVATION_GRACE = 400;
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
	closed: getter(globalThis, 'closed'),
	frameElement: getter(globalThis, 'frameElement'),
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
const weakDeref = WeakRef.prototype.deref;

interface Entry {
	key: string;
	url: string;
}

/**
 * a navigable of the frame (the frame itself or a frame nested in it);
 * `nav` is null for a nested frame whose document is of another origin than
 * this realm (the site pool: of another slot), known by its own report
 */
interface Live {
	win: Window;
	nav: object | null;
	key: string;
	id: string;
	url: string;
}

/** what a nested document of another origin than this realm reported of its entry */
export interface ReportedEntry {
	key: string;
	id: string;
	/** the document's address as the browser has it (a route of its slot) */
	url: string;
}
const reported = new WeakMap<Window, ReportedEntry>();

/** one step of the frame's history: a navigable went from one entry to another */
interface Step {
	from: Entry;
	to: Entry;
	/** when it was recorded, on the clock all frames share */
	at: number;
	/** the frame's own navigable took it (not a frame in its page) */
	top: boolean;
	/** the state it reaches: Back and Forward pass over it (see `mark`) */
	skip: boolean;
	/** the state it reaches: which of the frame's documents it shows */
	doc: number;
	/**
	 * it is an entry of the joint session history (a step of a frame's
	 * first document in a fresh browsing context is not)
	 */
	native: boolean;
}

/**
 * What the controller can tell of a proxied document, from its client: its
 * real origin, whether the browser had already given it a user activation
 * when it started (one carried over from the document that navigated to it)
 * and whether it has one of its own
 */
export interface DocumentView {
	origin: string;
	activatedAtStart: boolean;
	activated: boolean;
	/** names the document in its activation report */
	token: string;
}

/** a document the frame has shown, for Chrome's history intervention */
interface DocumentState {
	id: number;
	origin: string | null;
	/** the browser's view: activated when it started (null until its client is read) */
	start: boolean | null;
	/** a user activation of its own, as far as last seen */
	own: boolean;
	token: string | null;
	/** a history activation carried over from the document before it */
	carried: boolean;
}
let documentIds = 0;

/**
 * The frames of this realm in one joint session history, and a clock their
 * changes to it are counted on: a frame whose step another frame has
 * changed the joint history since (a new entry, or a traversal) cannot
 * count on the browser's traversal leaving the other frame alone
 */
let clock = 0;
// held weakly: a frame's history is its window's (`histories`), and a tab
// the host closed took its window with it. Held here, every tab ever
// closed kept its window, and the window its last document's whole realm
// (the page and the inject), for the host page's life
const frames = new Set<WeakRef<FrameHistory>>();

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
			// another origin (an opaque document, say): not ours to read, but
			// for what a nested one reported of itself (the site pool: a frame
			// of the page that shows another slot's document)
			const entry = depth > 0 ? reported.get(win) : undefined;
			if (entry) out.push({ win, nav: null, ...entry });
			return;
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
	/** `run`: which of the frame's runs on this realm's origin it is (the site pool's agent keeps one each) */
	constructor(
		public win: Window,
		public run = 0,
	) {}
	/** reads a document's client (set by the controller) */
	reader: ((win: Window) => DocumentView | null) | null = null;
	/**
	 * the windows a nested frame showed before the fresh browsing contexts
	 * its page gave it, latest first (set by the controller): one that loads
	 * another origin's document gets a new navigable (src/inject/dom/
	 * freshContext.ts), whose first document makes no entry of its own
	 */
	earlier: ((win: Window) => Window[]) | null = null;
	/** the next document of the frame comes from the host (a typed URL, Reload) */
	browserNavigation = false;
	documents = new WeakMap<Document, DocumentState>();
	/** the frame's document at the last look */
	document: DocumentState | null = null;
	/** the documents that reported a user activation, by token */
	activations = new Set<string>();
	/** a navigation of the page's own whose activation is not read yet */
	undecided: {
		previous: DocumentState;
		current: DocumentState;
		left: number;
		/** not decided before this time (see sync) */
		after?: number;
	} | null = null;
	/** the state before the first step: skippable, its document */
	startSkip = false;
	startDoc = 0;
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
	/** the last entry of each navigable gone since (a frame given a fresh context) */
	gone = new WeakMap<Window, Entry>();
	/** a step that has not committed yet: its navigable and the entry id it left */
	pending: { win: Window; id: string; until: number } | null = null;
	/**
	 * the site pool: the frame was sent back to this run in place of another
	 * origin's entry (a location.replace, when the browser's traversal would
	 * have moved another frame): the next document stands for this state
	 */
	arrival: { state: number; from: DocumentState | null } | null = null;

	logical(key: string) {
		return this.alias.get(key) ?? key;
	}

	/** the entry of the frame's own navigable in a state */
	topEntryAt(state: number): Entry | null {
		for (let i = state - 1; i >= 0; i--)
			if (this.steps[i]?.top) return this.steps[i].to;
		for (let i = state; i < this.steps.length; i++)
			if (this.steps[i].top) return this.steps[i].from;
		return this.known.get(this.win) ?? this.gone.get(this.win) ?? null;
	}

	skipAt(state: number) {
		return state === 0 ? this.startSkip : !!this.steps[state - 1]?.skip;
	}
	docAt(state: number) {
		return state === 0 ? this.startDoc : (this.steps[state - 1]?.doc ?? 0);
	}
	setState(state: number, skip: boolean, doc: number) {
		if (state === 0) {
			this.startSkip = skip;
			this.startDoc = doc;
		} else if (this.steps[state - 1]) {
			this.steps[state - 1].skip = skip;
			this.steps[state - 1].doc = doc;
		}
	}

	/** the frame's document now, with what is known of it */
	readDocument(top: Window): DocumentState | null {
		let doc: Document;
		try {
			doc = top.document;
		} catch (error) {
			return null; // another origin: its initial document, in isolation
		}
		let state = this.documents.get(doc);
		let view: DocumentView | null = null;
		try {
			view = this.reader?.(top) ?? null;
		} catch (error) {
			// not a client yet
		}
		if (!state) {
			// its client may not be there yet: what it says comes at a later look
			state = {
				id: ++documentIds,
				origin: null,
				start: null,
				own: false,
				carried: false,
				token: null,
			};
			this.documents.set(doc, state);
		}
		if (view && state.start === null) {
			state.origin = view.origin;
			state.start = view.activatedAtStart;
			state.token = view.token;
		}
		if (view?.activated || (state.token && this.activations.has(state.token)))
			state.own = true;
		return state;
	}

	/**
	 * Chrome's history manipulation intervention (measured in 152 and 156):
	 * a document that sends the tab to a new document by script with no
	 * history activation (no user activation of its own, none carried over
	 * from a same-origin document that navigated to it) leaves every entry
	 * it showed skippable, and Back and Forward pass over those. Only the
	 * tab's own document does it; a frame in its page and a same-document
	 * entry (pushState, a fragment) do not.
	 */
	mark(left: DocumentState, from: number) {
		for (let state = from; state >= 0; state--) {
			if (this.docAt(state) !== left.id) break;
			this.setState(state, true, left.id);
		}
	}

	/**
	 * Whether `before` had a history activation when it navigated to `after`:
	 * the browser carries a user activation over to the next document of its
	 * origin, which in proxy URL space is every one, so `after` started
	 * without one only if `before` had none; with one, `before` had its own
	 * (when the browser had given it none at its start) or one it carried
	 */
	activated(before: DocumentState, after: DocumentState): boolean {
		if (before.token && this.activations.has(before.token)) before.own = true;
		if (!after.start) return false;
		return !before.start || before.own || before.carried;
	}

	/** read where the frame is, and record the steps it took by itself */
	sync(top: Window) {
		const live = walk(top);
		if (!live.length) return;
		// the frame's document, and whether the host or a step of ours brought
		// it (a typed URL, Reload, Back or Forward): the browser starts a
		// document it navigated to itself without a carried activation
		const previous = this.document;
		const current = this.readDocument(top);
		const arrival =
			current && current !== this.arrival?.from ? this.arrival : null;
		const ours =
			this.browserNavigation || this.pending?.win === top || !!arrival;
		const newDocument = !!current && current !== previous;
		if (newDocument) {
			this.document = current;
			this.browserNavigation = false;
		}
		if (arrival) {
			// the replaced entry, whatever its key, is the state's entry
			this.arrival = null;
			const want = this.topEntryAt(arrival.state);
			if (want && live[0].key !== want.key)
				this.alias.set(live[0].key, want.key);
		}
		/** the state the frame's own navigable left for a new entry */
		let left = -1;
		const seen = new Map<Window, Entry>();
		for (const node of live) {
			const entry = { key: this.logical(node.key), url: node.url };
			// a nested frame whose document went to another origin and has
			// reported from there since: the entry it left
			const before =
				this.known.get(node.win) ??
				(node.nav ? undefined : this.gone.get(node.win));
			if (this.pending?.win === node.win) {
				if (node.id === this.pending.id && Date.now() < this.pending.until) {
					// still on the entry it is leaving: keep what the step expects
					seen.set(node.win, before ?? entry);
					continue;
				}
				this.pending = null;
			}
			// a nested frame's fresh browsing context: the navigable it was
			// before, which a tab's Back steps back to
			if (!before && node.win !== top && this.earlier) {
				const last = (win: Window) => this.known.get(win) ?? this.gone.get(win);
				const prev = this.earlier(node.win).find((win) => !!last(win));
				const was = prev && last(prev);
				if (prev && was) {
					if (this.pending?.win === prev) {
						// a step of ours, taken there, committed in the new one:
						// its entry stands for the step's
						this.pending = null;
						this.alias.set(node.key, was.key);
						seen.set(node.win, { key: was.key, url: node.url });
						continue;
					}
					seen.set(node.win, entry);
					this.steps.length = this.index;
					this.steps.push(this.make(was, entry, false, false));
					this.index = this.steps.length;
					this.touched = clock;
					continue;
				}
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
			const index = this.index;
			if (this.moved(node, before, entry, node.win === top) && node.win === top)
				left = index;
		}
		for (const [win, entry] of this.known)
			if (!seen.has(win)) this.gone.set(win, entry);
		this.known = seen;
		if (arrival && arrival.state <= this.steps.length)
			this.index = arrival.state;
		if (!current) return;
		if (newDocument) {
			// a decision still waiting is taken now, before the next one
			if (this.undecided) this.decide(top, true);
			this.undecided =
				previous && !ours
					? // the page navigated itself: to a new entry, or in place (it
						// replaced or reloaded itself); decided once both clients
						// are read
						{ previous, current, left }
					: null;
		}
		this.decide(top, false);
		// the state the frame is in shows this document
		this.setState(this.index, this.skipAt(this.index), current.id);
	}

	/**
	 * Whether the document a navigation of the page's own left had a history
	 * activation, once both documents' clients are read: when it had none,
	 * its states are passed over (`mark`), else the next document carries it
	 * on. `now`: decide at once (a step is about to be taken)
	 */
	decide(top: Window, now: boolean) {
		const undecided = this.undecided;
		if (
			!undecided ||
			undecided.current.start === null ||
			undecided.previous.start === null
		)
			return;
		const activated = this.activated(undecided.previous, undecided.current);
		// that the document had no activation of its own rests on its report
		// not having come; the one a click that navigated it posted can be
		// overtaken by the loading of the next document: give it a moment
		if (!activated && undecided.previous.start && !now) {
			const time = Date.now();
			undecided.after ??= time + ACTIVATION_GRACE;
			if (time < undecided.after) {
				setTimeout(() => {
					try {
						this.sync(top);
					} catch (error) {
						// the frame is between documents or left our origin
					}
				}, ACTIVATION_GRACE);
				return;
			}
		}
		this.undecided = null;
		if (undecided.left !== -1 && !activated)
			this.mark(undecided.previous, undecided.left);
		undecided.current.carried =
			activated &&
			undecided.previous.origin !== null &&
			undecided.previous.origin === undecided.current.origin;
	}

	make(from: Entry, to: Entry, top: boolean, native = true): Step {
		return {
			from,
			to,
			at: ++clock,
			top,
			skip: false,
			doc: this.document?.id ?? 0,
			native,
		};
	}

	/** a frame first seen with entries already: they are its steps */
	seed(node: Live) {
		const entries = node.nav ? entriesOf(node.nav) : [];
		const at = entries.findIndex((entry) => entry.key === node.key);
		for (let i = 1; i < entries.length; i++)
			this.steps.push(this.make(entries[i - 1], entries[i], true));
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
	/** whether it was a new entry */
	moved(node: Live, before: Entry, now: Entry, top: boolean): boolean {
		// a traversal the page made itself (history.back(), go(-2), forward())
		for (let i = this.index - 1; i >= 0; i--) {
			const step = this.steps[i];
			if (step.from.key === now.key) {
				this.index = i;
				this.renamed(now);
				return false;
			}
			if (step.to.key === now.key) {
				this.index = i + 1;
				this.renamed(now);
				return false;
			}
		}
		for (let i = this.index; i < this.steps.length; i++) {
			const step = this.steps[i];
			if (step.to.key === now.key) {
				this.index = i + 1;
				this.renamed(now);
				return false;
			}
		}
		// a frame of another origin's document lists nothing to this realm:
		// a new key is a new entry
		const entries = (node.nav ? entriesOf(node.nav) : [before, now]).map(
			(entry) => ({
				key: this.logical(entry.key),
				url: entry.url,
			}),
		);
		// the entry it was on is gone: it was replaced under another key (a
		// frame's first document after its initial about:blank), no new entry
		if (!entries.some((entry) => entry.key === before.key)) {
			for (const step of this.steps) {
				if (step.from.key === before.key) step.from = now;
				if (step.to.key === before.key) step.to = now;
			}
			return false;
		}
		// a new entry: every native entry between the two is a step (two
		// pushState calls before anyone looked are two steps)
		this.steps.length = this.index;
		const end = entries.findIndex((entry) => entry.key === now.key);
		const start = entries.findIndex((entry) => entry.key === before.key);
		if (start !== -1 && end > start) {
			entries[start] = before;
			for (let i = start + 1; i <= end; i++)
				this.steps.push(this.make(entries[i - 1], entries[i], top));
		} else this.steps.push(this.make(before, now, top));
		this.index = this.steps.length;
		this.touched = clock;
		return true;
	}

	/**
	 * the state Back or Forward goes to: the nearest one Chrome's history
	 * intervention does not pass over; -1 when there is none (the button is
	 * off then, as Chrome's is)
	 */
	target(direction: Direction) {
		const delta = direction === 'back' ? -1 : 1;
		for (
			let state = this.index + delta;
			state >= 0 && state <= this.steps.length;
			state += delta
		)
			if (!this.skipAt(state)) return state;
		return -1;
	}

	/** go back or forward; false when there is nowhere to go */
	async step(top: Window, direction: Direction): Promise<boolean> {
		this.sync(top);
		this.decide(top, true);
		const to = this.target(direction);
		if (to === -1) return false;
		const back = direction === 'back';
		// the steps between, undone or redone: one traversal of the frame's
		// navigable when they are all its own, else one at a time
		const between = back
			? this.steps.slice(to, this.index)
			: this.steps.slice(this.index, to);
		if (between.length > 1 && !between.every((step) => step.top)) {
			while (this.index !== to) {
				const index = this.index;
				await this.take(
					top,
					back ? [this.steps[index - 1]] : [this.steps[index]],
					back ? -1 : 1,
				);
				if (this.index === index) return true;
			}
			return true;
		}
		await this.take(top, between, to - this.index);
		return true;
	}

	/** undo (delta < 0) or redo the consecutive `steps` of one navigable */
	async take(top: Window, steps: Step[], delta: number) {
		const back = delta < 0;
		const holder = back ? steps[steps.length - 1].to : steps[0].from;
		const target = back ? steps[0].from : steps[steps.length - 1].to;
		const at = Math.min(...steps.map((step) => step.at));
		const node = walk(top).find(
			(candidate) => this.logical(candidate.key) === holder.key,
		);
		if (!node) {
			// its navigable is gone (the frame that took it was removed, or
			// came back as a new one when its page was gone back to): the
			// press uses the step up and nothing moves, as natively
			this.index += delta;
			return;
		}
		this.go(node, target, holder, delta, at);
		this.index += delta;
		await this.committed(top, node);
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
		const native =
			node.nav &&
			entriesOf(node.nav).find(
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
		for (const ref of frames) {
			const other = ref.deref();
			// (another run of this frame: its entries are this navigable's)
			if (other === this || other?.win === this.win) continue;
			if (!other || other.win.closed) frames.delete(ref);
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
				// its frame got a fresh browsing context (the page's own
				// `closed` of it may answer for the new one)
				if (call(NATIVE.closed, node.win)) break;
			} catch (error) {
				break; // the frame left our origin; nothing more to wait for
			}
		}
		this.sync(top);
	}

	can(direction: Direction) {
		return this.target(direction) !== -1;
	}

	/** what a site pool's hub composes the frame's history from (RunState) */
	state(): RunState {
		const skips: boolean[] = [];
		for (let state = 0; state <= this.steps.length; state++)
			skips.push(this.skipAt(state));
		return {
			index: this.index,
			skips,
			exact:
				this.alias.size === 0 &&
				this.pending === null &&
				this.steps.every((step) => step.native),
			touched: this.touched,
			undecided: this.undecided !== null,
		};
	}

	/**
	 * The frame's document left for another origin's (the site pool: a
	 * document of another slot), a new entry, which prunes the entries after
	 * this one. `decide`: it was the page's own navigation (not the host's),
	 * so the document's states are passed over unless it had a history
	 * activation of its own or carried (no activation crosses origins);
	 * its report of one may lag the next document's, as in `decide`.
	 * `replaced`: the new document took the entry of this one's (a
	 * location.replace), so every state on that entry of the frame's own
	 * navigable is gone too; false when that leaves the run no state
	 */
	async leave(top: Window, decide: boolean, replaced = false) {
		this.sync(top);
		this.steps.length = this.index;
		this.undecided = null;
		this.browserNavigation = false;
		if (replaced) {
			let last = this.index - 1;
			while (last >= 0 && !this.steps[last].top) last--;
			if (last < 0) {
				this.steps.length = 0;
				this.index = 0;
				return false;
			}
			this.steps.length = last;
			this.index = last;
			return true;
		}
		const left = this.document;
		const index = this.index;
		if (!decide || !left) return true;
		const activated = () =>
			left.own ||
			left.carried ||
			(left.token !== null && this.activations.has(left.token));
		if (!activated()) await sleep(ACTIVATION_GRACE);
		if (!activated() && this.index === index && this.document === left)
			this.mark(left, index);
		return true;
	}
}

/**
 * One run of a frame's history as the site pool's hub composes it: the
 * states of the run (each step of the frame or a frame in it between them),
 * which of them Back and Forward pass over, where the frame is in it
 */
export interface RunState {
	index: number;
	skips: boolean[];
	/**
	 * each step between two states is one of the joint session history and
	 * the frame is on the native entry of its state: a traversal by a
	 * number of steps (`traverseBy`) lands where the states say
	 */
	exact: boolean;
	/** the run's clock of changes to the joint history (counts up) */
	touched: number;
	/** a document's activation is still awaited: ask again after ACTIVATION_GRACE */
	undecided: boolean;
}

const histories = new WeakMap<Window, Map<number, FrameHistory>>();

function historyOf(win: Window, run = 0) {
	let runs = histories.get(win);
	if (!runs) histories.set(win, (runs = new Map()));
	let history = runs.get(run);
	if (!history) {
		runs.set(run, (history = new FrameHistory(win, run)));
		frames.add(new WeakRef(history));
	}
	return history;
}

/**
 * Record what the frame did since the last look (call it whenever the frame
 * or a frame in it reports; the other functions call it too). `run`, here
 * and below: the site pool's agent keeps a history for each run of the
 * frame on its origin (RunState); everything else has the one
 */
export function syncHistory(win: Window | null | undefined, run = 0) {
	if (!win || !supported) return;
	try {
		historyOf(win, run).sync(win);
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

/** the run of the frame's history, after a look (RunState); null when the browser cannot tell */
export function runState(win: Window, run: number): RunState | null {
	if (!supported) return null;
	syncHistory(win, run);
	return historyOf(win, run).state();
}

/** the frame's document left the run for another origin's (FrameHistory.leave); whether the run has a state left */
export async function leaveRun(
	win: Window,
	run: number,
	decide: boolean,
	replaced = false,
): Promise<boolean> {
	if (!supported) return true;
	try {
		return await historyOf(win, run).leave(win, decide, replaced);
	} catch (error) {
		return true; // the frame is between documents
	}
}

/**
 * A nested frame of another origin's document than this realm's reported
 * its entry (the site pool: a frame of the page shows another slot's), so
 * its steps are the frame's too
 */
export function noteEntry(win: Window, entry: ReportedEntry) {
	reported.set(win, entry);
}

const nativeGo = method(realm.History?.prototype, 'go');

/**
 * Traverse the joint session history by `delta` steps from the frame's
 * document, the browser's own traversal across origins (the site pool: to
 * a run of another slot), with this realm's History method: the page's is
 * narrowed to its own origin's entries (src/inject/dom/modules/History.ts)
 */
export function traverseBy(win: Window, delta: number): boolean {
	if (!nativeGo || !Number.isInteger(delta) || delta === 0) return false;
	call(nativeGo, win.history, delta);
	return true;
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
	run = 0,
): Promise<boolean> {
	if (!supported) {
		if (direction === 'back') win.history.back();
		else win.history.forward();
		return true;
	}
	try {
		return await historyOf(win, run).step(win, direction);
	} catch (error) {
		return false; // the frame is between documents or left our origin
	}
}

/**
 * Tell the frame's history how to read its documents' clients (their real
 * origin and user activation), for Chrome's history intervention
 */
export function bindHistory(
	win: Window | null | undefined,
	reader: (win: Window) => DocumentView | null,
	earlier?: (win: Window) => Window[],
	run = 0,
) {
	if (!win || !supported) return;
	const history = historyOf(win, run);
	history.reader = reader;
	if (earlier) history.earlier = earlier;
}

/**
 * The windows a nested frame of `top` showed before its page gave it fresh
 * browsing contexts (src/inject/dom/freshContext.ts), latest first, as the
 * page's client (the window's `name` global) keeps them
 */
export function earlierWindows(
	top: Window,
	name: string,
): (win: Window) => Window[] {
	return (win) => {
		try {
			const element = elementOf(win);
			const client = (top as unknown as Record<string, unknown>)[name] as
				| {
						groupClient?: {
							freshRegistry?: {
								frames: WeakMap<Element, { windows: WeakRef<Window>[] }>;
							};
						};
				  }
				| undefined;
			const record =
				element && client?.groupClient?.freshRegistry?.frames.get(element);
			if (!record) return [];
			// held weakly: the ones nothing holds any more are gone
			const live: Window[] = [];
			for (const ref of record.windows) {
				const held = Reflect.apply(weakDeref, ref, []) as Window | undefined;
				if (held) live.push(held);
			}
			return live.reverse();
		} catch (error) {
			return []; // another origin's, or a window being torn down
		}
	};
}

const NATIVE_PARENT = getter(globalThis, 'parent');
const NATIVE_CONTENT_WINDOW = getter(
	realm.HTMLIFrameElement?.prototype,
	'contentWindow',
);

/**
 * The frame element of a window; for one whose document is of another
 * origin than this realm, which has no `frameElement` to read here (the
 * site pool: a nested frame showing another slot's document), from its
 * parent's document when that is of this origin
 */
function elementOf(win: Window): Element | null {
	try {
		return call(NATIVE.frameElement, win) as Element | null;
	} catch (error) {
		// another origin's: from its parent
	}
	try {
		const parent = call(NATIVE_PARENT!, win) as Window;
		for (const element of parent.document.querySelectorAll('iframe'))
			if (call(NATIVE_CONTENT_WINDOW!, element) === win) return element;
	} catch (error) {
		// another origin's parent
	}
	return null;
}

/**
 * The frame's next document comes from the host, not the page (a typed URL,
 * Reload): it starts with no activation carried over, and the document it
 * replaces is not taken to have navigated by script
 */
export function noteBrowserNavigation(win: Window | null | undefined, run = 0) {
	if (!win || !supported) return;
	historyOf(win, run).browserNavigation = true;
}

/** what a document's client (the window's `name` global) says for its frame's history */
export function clientView(win: Window, name: string): DocumentView | null {
	const client = (win as unknown as Record<string, unknown>)[name] as
		| {
				url?: { url?: URL };
				historyActivation?: {
					start: boolean;
					activated: () => boolean;
					token: string;
				};
		  }
		| undefined;
	const activation = client?.historyActivation;
	const origin = client?.url?.url?.origin;
	if (!activation || typeof origin !== 'string') return null;
	return {
		origin,
		activatedAtStart: activation.start,
		activated: activation.activated(),
		token: activation.token,
	};
}

/**
 * The site pool: the frame's entries in other slots' stretches of its
 * history, which its document (of this realm's origin) counts in
 * `history.length` (the client's historyAcross)
 */
export function tellAcross(win: Window, name: string, across: number) {
	try {
		const client = (win as unknown as Record<string, unknown>)[name] as
			{ historyAcross?: unknown } | undefined;
		if (client && typeof client.historyAcross === 'number')
			client.historyAcross = Math.max(0, Math.trunc(across)) || 0;
	} catch (error) {
		// the frame is between documents or left this origin
	}
}

/**
 * A document of the frame reported its first user activation (its token);
 * `nested`: a document of a frame in its page, whose activation is the
 * page's too (an activation reaches every ancestor of its frame)
 */
export function noteActivation(
	win: Window | null | undefined,
	token: string,
	nested = false,
	run = 0,
) {
	if (!win || !supported) return;
	const history = historyOf(win, run);
	history.activations.add(token);
	syncHistory(win, run);
	if (nested && history.document) history.document.own = true;
}

/**
 * What the site pool's hub asks of a run of a frame's history
 * (src/controller/sites.ts): take a report of the frame's document (`sync`),
 * of a frame in its page (`nested`, its path of indices from the frame and
 * the entry it reported) or of a user activation, note that the next
 * document comes from the host (`typed`), reload, step within the run, step
 * the joint history by `delta` (to another run), take the next document for
 * a state of the run (`arrive`: the hub sends the frame there in place of
 * another run's entry), or close the run for a document of another origin
 * (`leave`)
 */
export type SiteHistoryOp =
	| { kind: 'sync'; across?: number }
	| { kind: 'nested'; path: number[]; entry: ReportedEntry | null }
	| { kind: 'activated'; token: string; nested: boolean }
	| { kind: 'typed' }
	| { kind: 'reload' }
	| { kind: 'back' }
	| { kind: 'forward' }
	| { kind: 'go'; delta: number }
	| { kind: 'arrive'; state: number }
	| { kind: 'leave'; decide: boolean; replaced?: boolean };

/** whether the op was done (a step there was to take), and the run's state after it */
export interface SiteHistoryAnswer {
	done: boolean;
	state: RunState | null;
	/** `arrive`: the address of the state's document as the browser had it */
	url?: string;
}

/**
 * Answer `op` for run `run` of the frame `win` (of this realm's origin, or
 * gone to another's for `leave`), its documents' clients under `name`
 */
export async function answerRun(
	win: Window,
	run: number,
	op: SiteHistoryOp,
	name: string,
): Promise<SiteHistoryAnswer> {
	let readable = false;
	try {
		readable = name in win;
	} catch (error) {
		// another origin's document (another slot's, or still the host's
		// initial one)
	}
	if (readable)
		bindHistory(
			win,
			(target) => clientView(target, name),
			earlierWindows(win, name),
			run,
		);
	let done = true;
	switch (op.kind) {
		case 'sync':
			if (readable && op.across !== undefined) tellAcross(win, name, op.across);
			break;
		case 'nested': {
			let nested: Window | undefined = win;
			for (const index of op.path)
				nested = (nested as unknown as Record<number, Window | undefined>)?.[
					index
				];
			if (nested && op.entry) noteEntry(nested, op.entry);
			break;
		}
		case 'activated':
			noteActivation(win, op.token, op.nested, run);
			break;
		case 'typed':
			noteBrowserNavigation(win, run);
			break;
		case 'reload':
			if (!readable) {
				done = false;
				break;
			}
			noteBrowserNavigation(win, run);
			win.location.reload();
			break;
		case 'back':
		case 'forward':
			done = readable && (await traverse(win, op.kind, run));
			break;
		case 'go':
			done = readable && traverseBy(win, op.delta);
			break;
		case 'arrive': {
			if (!supported) break;
			const history = historyOf(win, run);
			history.arrival = { state: op.state, from: history.document };
			const url = history.topEntryAt(op.state)?.url;
			return { done, state: history.state(), ...(url ? { url } : {}) };
		}
		case 'leave':
			// (done: the run still has a state; one replaced has none left when
			// its first entry was the one replaced)
			done = await leaveRun(win, run, op.decide, op.replaced === true);
			return { done, state: supported ? historyOf(win, run).state() : null };
	}
	return { done, state: readable ? runState(win, run) : null };
}

/**
 * The indices from `top` down to `win`, a window in a frame of its page
 * (what `answerRun` takes for a nested report), or null when it is not one
 */
export function framePath(top: Window, win: Window): number[] | null {
	const path: number[] = [];
	let child = win;
	for (let depth = 0; child !== top; depth++) {
		if (depth > MAX_DEPTH) return null;
		let parent: Window;
		try {
			parent = call(NATIVE_PARENT!, child) as Window;
		} catch (error) {
			return null;
		}
		if (!parent || parent === child) return null;
		const count = parent.length;
		let index = -1;
		for (let i = 0; i < count; i++)
			if ((parent as unknown as Record<number, Window>)[i] === child) {
				index = i;
				break;
			}
		if (index === -1) return null;
		path.unshift(index);
		child = parent;
	}
	return path;
}
