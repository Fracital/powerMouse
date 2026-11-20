// Where a document's client keeps the site pool's state of it
// (DocumentClient pool). A module of types and a const enum only: nothing
// of it is left in the bundle but the indexes.
import type { parseNestedMark } from '../../partition';
import type { SlotShare } from '../../slotShare';
import type { AcrossNavigation } from './Client';
import type { StandInEntry } from './modules/Context';

/**
 * Where a document's client keeps what the site pool (and the frames it
 * reaches) set of it (DocumentClient pool): one array, which every frame
 * gets for the lot instead of a field each, each of which cost a frame a
 * shape and a descriptor of its own (measure-frame-memory). Each slot is
 * set as the client is made, so no read reaches the array's prototype.
 */
export const enum Pool {
	/**
	 * the entries of the frame's history in the stretches of other slots
	 * than this document's, which the browser lists it none of and the hub
	 * counts (HISTORY_RUN); the agent of this document's slot sets it (the
	 * Navigate module). `history.length` adds it to the stretch the browser
	 * lists
	 */
	HistoryAcross,
	/** what this document's slot's agent shares, once looked up (null: nothing; DocumentClient #slotShare) */
	SlotShared,
	/** the flags this document's frame gives it (#sandbox), which a navigation of the frame's own keeps */
	FrameFlags,
	/** the document slotMark was read for */
	MarkDocument,
	/** what slotMark read for it */
	Mark,
	/**
	 * This realm's own requestAnimationFrame, taken before the page ran
	 * (AnimationFrames.ts), to call on this window: a hidden frame of this
	 * document's origin that the browser holds runs its callbacks by it
	 */
	AnimationRequest,
	/** this realm's time origin, as AnimationRequest's times count from it */
	TimeOrigin,
	/** carry out a navigateAcross request a frame under this window sent (the Sandbox module sets it) */
	AcceptAcross,
	/**
	 * the stand-ins the documents of this one's origin under it get for
	 * windows of another slot, by their key (the Context module's
	 * `originKey` or domain), kept by the outermost of them (ContextModule
	 * restrictAcross), made with the first of them
	 */
	AcrossStandIns,
}

/** DocumentClient pool, by Pool */
export type PoolState = [
	historyAcross: number,
	slotShared: SlotShare | null | undefined,
	frameFlags: Set<string> | null,
	markDocument: Document | null,
	mark: ReturnType<typeof parseNestedMark>,
	animationRequest: typeof requestAnimationFrame | null,
	timeOrigin: number,
	acceptAcross: ((request: AcrossNavigation) => void) | null,
	acrossStandIns: Map<string, WeakMap<object, StandInEntry>> | null,
];
