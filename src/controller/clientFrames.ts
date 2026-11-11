/** how many new clients are taken in before the service worker is asked which are gone */
const ASK_EVERY = 16;
/** how many clients are kept whatever the service worker says (it may not answer): the oldest go first */
const LIMIT = 1024;

/**
 * @internal Which of a controller's frames a service worker client's
 * requests belong to (the request log, permission requests), as the pages
 * said it, and the clients nobody spoke for. A client id is never used
 * twice and every document and worker is a new client, so both would grow
 * with every navigation; an entry goes
 * - when its frame went away: the host took it out of `frames`, or its
 *   element out of the document (looked at whenever a client is added, and
 *   when the entry is read);
 * - when its client is gone: the service worker is asked about the ids kept
 *   every `ASK_EVERY` new ones (it lists the clients that exist);
 * - when there are more than `LIMIT`, the oldest first.
 */
export class ClientFrames<F extends { element: HTMLIFrameElement }> {
	#clients = new Map<string, F>();
	/**
	 * clients a request report waited for in vain: nobody says which frame a
	 * page's emulated service worker is in (it is its site's; a document
	 * tells the host its own client id, and the service worker names the
	 * document that made a worker), so its later reports go out as they
	 * come. One that tells after all (a page slower than the wait) is a
	 * frame's from then on.
	 */
	#silent = new Set<string>();
	#frames: () => readonly F[];
	#gone: (clients: string[]) => Promise<string[]>;
	#added = 0;
	#asking = false;

	/**
	 * @param frames the controller's frames, now
	 * @param gone asks the service worker which of these clients no longer exist
	 */
	constructor(
		frames: () => readonly F[],
		gone: (clients: string[]) => Promise<string[]>,
	) {
		this.#frames = frames;
		this.#gone = gone;
	}

	#shown(frame: F) {
		return frame.element.isConnected && this.#frames().includes(frame);
	}

	/** the frame the requests of `client` belong to: its own, or that of the document that made it (`owner`, for a worker) */
	frame(client?: string, owner?: string): F | null {
		for (const id of [client, owner]) {
			const frame = id ? this.#clients.get(id) : undefined;
			if (!frame) continue;
			if (this.#shown(frame)) return frame;
			this.#clients.delete(id!);
		}
		return null;
	}

	/** a page said which client it is: its requests are `frame`'s */
	attribute(client: string, frame: F) {
		this.#silent.delete(client);
		// a page says it again with every report of where it is
		if (this.#clients.get(client) === frame) return;
		this.#clients.delete(client);
		this.#clients.set(client, frame);
		this.#prune();
	}

	/** nobody spoke for `client` in time: its reports are not held back again */
	silence(client: string) {
		if (this.#silent.has(client)) return;
		this.#silent.add(client);
		this.#prune();
	}

	silent(client: string) {
		return this.#silent.has(client);
	}

	/** how many clients have a frame, and how many are known to have none */
	get sizes(): { clients: number; silent: number } {
		return { clients: this.#clients.size, silent: this.#silent.size };
	}

	#prune() {
		for (const [client, frame] of this.#clients)
			if (!this.#shown(frame)) this.#clients.delete(client);
		for (const kept of [this.#clients, this.#silent])
			for (const client of kept.keys()) {
				if (kept.size <= LIMIT) break;
				kept.delete(client);
			}
		if (++this.#added < ASK_EVERY || this.#asking) return;
		this.#added = 0;
		this.#asking = true;
		// only about what is kept now: a client told of while the question is
		// on its way exists
		this.#gone([...this.#clients.keys(), ...this.#silent])
			.then((gone) => {
				for (const client of gone) {
					this.#clients.delete(client);
					this.#silent.delete(client);
				}
			})
			// no service worker to ask right now: the next one is asked
			.catch(() => {})
			.finally(() => {
				this.#asking = false;
			});
	}
}
