// The site pool in isolation mode: a RemoteFrame's history as runs, the way
// Frame keeps it in the same origin mode (src/controller/index.ts, Frame
// #runs). A run is a stretch of the frame's history shown from one slot (or
// from the proxy origin, for a site shown without the pool). The browser
// lists a document the entries of its own origin only, so a run's states
// (every step of the frame and of the frames in its page, and which of them
// Chrome's Back passes over) are kept by the agent of its slot
// (src/controller/history.ts answerRun), told of every report of the
// frame's documents through the controller frame; the host page composes
// them. A step within a run is the agent's; a step to another run is the
// browser's own traversal of the joint session history, by the number of
// steps between, from the frame's document, else a navigation that replaces.
import type { NavigateInfo } from '../transport/messages';
import type {
	Direction,
	ReportedEntry,
	RunState,
	SiteHistoryAnswer,
	SiteHistoryOp,
} from './history';
import { entriesAcross, prunedRun, runsExpectation } from './index';

/** what a frame's runs need of the frame that keeps them */
export interface SiteRunsHost {
	/** ask the agent of `origin` (the controller frame, for its own origin; every one, unanswered, for '*') about run `run` of the frame */
	ask(
		origin: string,
		run: number,
		op: SiteHistoryOp,
	): Promise<SiteHistoryAnswer | null>;
	/** the origin of a site shown without the pool (a slot left out), the controller frame's */
	home: string;
	/** the other frames' runs, which share the joint session history */
	others(): SiteRuns[];
	/** the buttons may have changed with no report of the frame's */
	changed(): void;
	/** the frame's window, null once it is gone */
	window(): Window | null;
	/** the URL a run's last document is routed to again, on the slot that shows its site now */
	address(url: string, origin: string): Promise<string>;
	/** resolves on the frame's next report (or its timeout) */
	nextReport(): Promise<void>;
}

interface SiteRun {
	/** names it to the agent of its origin, which keeps its states */
	id: number;
	origin: string;
	/** the last URL the frame reported from it */
	url: string;
	state: RunState;
	/** its agent answered for it */
	known: boolean;
	/** runClock when it began */
	at: number;
	/** the frame's entries in it, as its documents reported them (HISTORY_RUN) */
	count: number;
	/** where in them the frame was last */
	index: number;
}
/** a run's state before its agent answered: one state, not passed over */
const FRESH: RunState = {
	index: 0,
	skips: [false],
	exact: true,
	touched: 0,
	undecided: false,
};
let runIds = 0;
/** the clock of changes to the joint session history, across the host's frames */
let runClock = 0;
/** how long a report waits for the agent of its slot before it is told anyway */
const SITE_ANSWER_MS = 300;
/** when an undecided activation is asked about again (history.ts ACTIVATION_GRACE, and a little) */
const SITE_RECHECK_MS = 450;

export class SiteRuns {
	#runs: SiteRun[] = [];
	#at = -1;
	/** the step across runs under way: the run the next report from its origin is from */
	#stepping: number | null = null;
	/** the frame's next document is the host's (go): the run it leaves is not the page's navigation */
	#hostNavigation = false;
	/** runClock when this frame last changed the joint session history */
	#touched = 0;
	/** reports and what they tell the agents, in order */
	#queue: Promise<unknown> = Promise.resolve();
	/** a run closed for the next one, until its agent decided on its last document */
	#leaving: Promise<unknown> = Promise.resolve();
	/** an undecided activation is asked about again (RunState.undecided) */
	#recheck = false;
	/** what the page said of its own slot's run of the history (while its agent does not answer) */
	#own = { back: false, forward: false };
	constructor(public host: SiteRunsHost) {}
	/** the origin the frame's document last reported from */
	get origin(): string | undefined {
		return this.#runs[this.#at]?.origin;
	}
	/**
	 * A top document of the frame reported, from `origin`, navigated to as
	 * `type` says (NAVIGATION_TYPE), where its slot's stretch of the history
	 * has it (`entries`, HISTORY_RUN); `deliver` reports it once the agent of
	 * that origin took it
	 */
	report(
		origin: string,
		info: NavigateInfo,
		type: string | null,
		deliver: () => void,
		entries: [number, number] | null = null,
	) {
		this.#own = {
			back: info.canGoBack === true,
			forward: info.canGoForward === true,
		};
		this.#enqueue(async () => {
			const { run, previous } = this.#place(origin, info, type);
			if (entries) [run.index, run.count] = entries;
			if (previous) prunedRun(previous, type === 'replace');
			if (previous) {
				// the run the frame left for a new one: the entries after its
				// state are gone, and a document that sent the frame on by
				// itself is passed over without a history activation; one that
				// replaced itself took its entry with it (and the run, when that
				// was the run's first)
				const replaced = type === 'replace';
				const decide = !this.#hostNavigation && !replaced;
				this.#leaving = this.#ask(previous, {
					kind: 'leave',
					decide,
					replaced,
				}).then((answer) => {
					const index = this.#runs.indexOf(previous);
					if (replaced && answer && !answer.done && index !== -1) {
						this.#runs.splice(index, 1);
						if (this.#at > index) this.#at--;
						// the runs either side of it are of one origin now, one
						// stretch of entries to the browser: the later one's agent
						// took the earlier one's entries as its first document's
						const before = this.#runs[index - 1];
						if (before && before.origin === this.#runs[index]?.origin) {
							this.#runs.splice(index - 1, 1);
							if (this.#at >= index) this.#at--;
						}
					}
					this.#expect();
					this.host.changed();
				});
			}
			if (previous || run.state === FRESH) this.#hostNavigation = false;
			this.#expect();
			try {
				// (and how many of the frame's entries are in other runs: its
				// document's history.length counts them)
				await this.#ask(run, {
					kind: 'sync',
					across: entriesAcross(this.#runs, this.#runs.indexOf(run)),
				});
			} finally {
				deliver();
			}
		});
	}
	/** what every agent was last told of the frame's runs (#expect) */
	#expected = '';
	/** tell every agent where the frame is in its runs (see Frame #expect): `ask` of origin '*' */
	#expect() {
		const op = runsExpectation(this.#runs, this.#at);
		const key = JSON.stringify(op);
		if (!op || key === this.#expected) return;
		this.#expected = key;
		this.host.ask('*', 0, op).catch(() => {});
	}
	/** which run a report from `origin` is of (see Frame #place) */
	#place(
		origin: string,
		info: NavigateInfo,
		type: string | null,
	): { run: SiteRun; previous: SiteRun | null } {
		const runs = this.#runs;
		const current = runs[this.#at];
		const step = this.#stepping;
		const home = this.host.home;
		// a run whose slot is left out since is shown from the home origin: a
		// report from there of a step to it is that run's
		const of = (run: SiteRun | undefined): run is SiteRun => {
			if (!run) return false;
			if (run.origin === origin) return true;
			if (origin !== home) return false;
			run.origin = origin;
			run.state = FRESH;
			run.known = false;
			return true;
		};
		if (step !== null && of(runs[step])) {
			this.#stepping = null;
			this.#at = step;
			runs[step].url = info.url;
			return { run: runs[step], previous: null };
		}
		if (current?.origin === origin) {
			current.url = info.url;
			return { run: current, previous: null };
		}
		this.#stepping = null;
		for (const offset of [-1, 1]) {
			const run = runs[this.#at + offset];
			if (
				(run?.origin === origin ||
					(origin === home && run?.url === info.url)) &&
				(run.url === info.url || type === 'traverse') &&
				of(run)
			) {
				this.#at += offset;
				run.url = info.url;
				return { run, previous: null };
			}
		}
		runs.splice(this.#at + 1);
		const run: SiteRun = {
			id: ++runIds,
			origin,
			url: info.url,
			state: FRESH,
			known: false,
			at: ++runClock,
			count: 1,
			index: 0,
		};
		this.#touched = run.at;
		runs.push(run);
		this.#at = runs.length - 1;
		return { run, previous: current ?? null };
	}
	#enqueue(task: () => Promise<unknown>) {
		this.#queue = this.#queue.then(task).catch(() => {});
	}
	/** ask the agent of the run's origin; `wait`: give up after SITE_ANSWER_MS (a step waits for its commit) */
	async #ask(
		run: SiteRun,
		op: SiteHistoryOp,
		wait = true,
	): Promise<SiteHistoryAnswer | null> {
		const asked = Promise.resolve()
			.then(() => this.host.ask(run.origin, run.id, op))
			.catch(() => null)
			.then((answer) => {
				if (answer?.state) this.#update(run, answer.state);
				return answer;
			});
		if (!wait) return asked;
		let late = false;
		const answer = await Promise.race([
			asked,
			new Promise<null>((resolve) =>
				setTimeout(() => {
					late = true;
					resolve(null);
				}, SITE_ANSWER_MS),
			),
		]);
		if (late) asked.then(() => this.host.changed());
		return answer;
	}
	#update(run: SiteRun, state: RunState) {
		if (run.known && state.touched !== run.state.touched)
			this.#touched = ++runClock;
		run.state = state;
		run.known = true;
		if (state.undecided && !this.#recheck) {
			this.#recheck = true;
			setTimeout(() => {
				this.#recheck = false;
				this.#enqueue(async () => {
					const current = this.#runs[this.#at];
					if (!current) return;
					await this.#ask(current, { kind: 'sync' });
					this.host.changed();
				});
			}, SITE_RECHECK_MS);
		}
	}
	/** a document in a frame of the page (at `path` below the frame) reported that its history moved */
	nested(path: number[], entry: ReportedEntry | null) {
		this.#enqueue(async () => {
			const run = this.#runs[this.#at];
			if (!run) return;
			await this.#ask(run, { kind: 'nested', path, entry });
			this.host.changed();
		});
	}
	/** a document of the frame (or of a frame in its page, `nested`) reported its first user activation */
	activated(token: string, nested: boolean) {
		this.#enqueue(async () => {
			const run = this.#runs[this.#at];
			if (run) await this.#ask(run, { kind: 'activated', token, nested });
		});
	}
	/**
	 * The host navigates the frame to a document of `origin`: the run that
	 * shows it takes the next document for the host's, else the next run
	 * starts with it
	 */
	async typed(origin: string) {
		const run = this.#runs[this.#at];
		if (run && run.origin === origin) await this.#ask(run, { kind: 'typed' });
		else this.#hostNavigation = true;
	}
	/** how many times the frame was stopped (stop): a step not taken before is not taken */
	#stops = 0;
	/** the address a step last sent the frame to (a stop of an answered one drops nothing) */
	#sent: string | null = null;
	/**
	 * The host's Stop (RemoteFrame.stop): the agent of the frame's run stops
	 * its document, and the worker of the slot the frame was sent to
	 * (`routed`, go()'s, else a step's) drops that navigation while it
	 * waits for its answer, through the slot's agent
	 */
	async stop(routed: string | null): Promise<void> {
		this.#stops++;
		const sent = routed ?? this.#sent;
		this.#sent = null;
		const run = this.#runs[this.#at];
		const to = sent ? new URL(sent).origin : null;
		const asked: Promise<unknown>[] = [];
		if (run)
			asked.push(
				this.#ask(
					run,
					{ kind: 'stop', ...(sent && to === run.origin && { routed: sent }) },
					false,
				),
			);
		if (sent && to !== run?.origin)
			asked.push(
				this.host.ask(to!, 0, { kind: 'stop', routed: sent }).catch(() => null),
			);
		await Promise.all(asked);
	}
	/** whether a step sent the frame to `routed`, which the worker answered with no document (RemoteFrame.stayedAt) */
	stayedAt(routed: string): boolean {
		if (this.#sent?.split('#')[0] !== routed.split('#')[0]) return false;
		this.#sent = null;
		return true;
	}
	/** the host reloads the frame (past the caches when `hard`): whether the agent of its run did (null: no agent answered) */
	async reload(hard = false): Promise<boolean | null> {
		const run = this.#runs[this.#at];
		if (!run) return null;
		const answer = await this.#ask(run, { kind: 'reload', hard }, false);
		return answer ? answer.done : null;
	}
	/** whether the frame's history has a state Back or Forward goes to */
	can(direction: Direction): boolean {
		return (
			this.#target(direction) !== null ||
			(!this.#runs[this.#at]?.known &&
				(direction === 'back' ? this.#own.back : this.#own.forward))
		);
	}
	/** the state Back or Forward goes to (the nearest one Chrome's would not pass over), null when there is none */
	#target(direction: Direction): { run: number; state: number } | null {
		const runs = this.#runs;
		const delta = direction === 'back' ? -1 : 1;
		let run = this.#at;
		let state = (runs[run]?.state.index ?? 0) + delta;
		while (run >= 0 && run < runs.length) {
			const skips = runs[run].state.skips;
			for (; state >= 0 && state < skips.length; state += delta)
				if (!skips[state]) return { run, state };
			run += delta;
			state = delta < 0 ? (runs[run]?.state.skips.length ?? 0) - 1 : 0;
		}
		return null;
	}
	/** how many steps of the joint session history the state is from the frame's first */
	#position(run: number, state: number): number {
		let position = state;
		for (let i = 0; i < run; i++) position += this.#runs[i].state.skips.length;
		return position;
	}
	/** whether another frame of the host changed the joint session history since `at` */
	#crossed(at: number): boolean {
		return this.host.others().some((other) => other.#touched > at);
	}
	/** step the frame's history, within its run through the agent of its slot, else to another run */
	async step(direction: Direction): Promise<boolean> {
		const stops = this.#stops;
		await this.#queue;
		await this.#leaving;
		if (this.#stops !== stops) return false;
		const current = this.#runs[this.#at];
		if (!current) return false;
		let target = this.#target(direction);
		if (!target || target.run === this.#at) {
			if (target === null && current.known) return false;
			if ((await this.#ask(current, { kind: direction }, false))?.done)
				return true;
			target = this.#target(direction);
			if (!target || target.run === this.#at) return false;
		}
		const to = this.#runs[target.run];
		const from = Math.min(target.run, this.#at);
		const between = this.#runs.slice(from, Math.max(target.run, this.#at) + 1);
		const reported = this.host.nextReport();
		this.#stepping = target.run;
		// the browser's own traversal, from the frame's document, when every
		// step between is one of the joint history's and no other frame
		// changed it since
		if (
			between.every((run) => run.known && run.state.exact) &&
			!this.#crossed(this.#runs[from].at)
		) {
			const delta =
				this.#position(target.run, target.state) -
				this.#position(this.#at, current.state.index);
			const answer = await this.#ask(current, { kind: 'go', delta }, false);
			if (answer?.done) {
				this.#touched = ++runClock;
				await reported;
				return true;
			}
		}
		// else a navigation that replaces: the frame's history keeps its
		// length, as a traversal would
		const win = this.host.window();
		if (!win) {
			this.#stepping = null;
			return false;
		}
		const arrive = await this.#ask(to, { kind: 'arrive', state: target.state });
		let url = arrive?.url;
		if (!url?.startsWith(`${to.origin}/`))
			url = await this.host.address(to.url, to.origin);
		// stopped meanwhile: the step is not taken
		if (this.#stops !== stops) {
			this.#stepping = null;
			return false;
		}
		this.#touched = ++runClock;
		this.#sent = url;
		win.location.replace(url);
		await reported;
		return true;
	}
}
