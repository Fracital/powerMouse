// The database under the cookie jar (src/server/Cookies.ts). The jar asks
// six things of it, each one request of its own, and keeps nothing between
// them, so the database may as well be somewhere else: with the site pool
// (src/controller/sitePool.ts) every slot's service worker is of another
// origin, and cookies are not a site's own (a page of one site sends
// another's with its requests), so every slot's jar is the host origin's
// one database, asked over a MessagePort. The host's transport worker
// answers (src/transport/jarServer.ts): a thread of the host's origin that
// lives as long as the host's page and is never the thread a proxied page
// spins.

/** what the jar asks of its database; idb's IDBPDatabase answers the same */
export interface JarDB {
	getAllFromIndex(
		store: string,
		index: string,
		key: string,
	): Promise<unknown[]>;
	getAll(store: string): Promise<unknown[]>;
	get(store: string, key: string): Promise<unknown>;
	put(store: string, value: unknown, key?: string): Promise<unknown>;
	delete(store: string, key: string): Promise<void>;
	clear(store: string): Promise<void>;
}

/** the jar's database and its one object store, in the host's origin */
export const JAR_DATABASE = 'stompCookies';
export const JAR_STORE = 'cookies';
/**
 * The sites' permission states (src/server/permissions.ts), asked the same
 * way: a frame's permission is its top's, and the frame may be shown from
 * another slot than its top, so every slot's worker keeps them in the host
 * origin's one database too (keyed out of line: `put` takes the key)
 */
export const PERMISSIONS_DATABASE = 'stompPermissions';
export const PERMISSIONS_STORE = 'states';

export type JarOp = keyof JarDB;
/** slot worker -> host: one request of the jar */
export interface JarCall {
	jar: number;
	op: JarOp;
	args: unknown[];
}
/** host -> slot worker: its answer */
export interface JarReply {
	jar: number;
	result?: unknown;
	error?: string;
}
/**
 * either way: the jar changed for `domain` ('' for every host). A slot's
 * worker says so after its own write; the host tells every other slot's
 * worker, whose documents drop what they kept of document.cookie.
 */
export interface JarChanged {
	jarChanged: string;
}

interface Pending {
	call: JarCall;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** a handshake's port to the host's jar, and whether the page that gave it is still open */
export interface JarPort {
	port: MessagePort;
	/**
	 * whether the document that shook hands is still open (a slot's agent,
	 * in its host's tab): Chrome tells a port nothing when that tab closes
	 */
	alive(): Promise<boolean>;
}

/** how long a request of the jar may go unanswered before the pages behind the ports are looked at */
export const JAR_CHECK_MS = 500;
/** the most handshakes' ports kept: one for each host page open at once, and some */
const JAR_PORTS_KEPT = 16;

/**
 * The host's jar as a slot's worker asks it. A slot's worker serves every
 * page of the host open at once (two tabs of the demo: each has its own
 * agent in the slot, each agent shook hands with its own port), and any
 * one of them reaches the one database. The newest handshake's port is
 * asked: the host's page may reload while this worker lives on, and the
 * port it gave before is then dead with whatever was asked on it, so every
 * request without an answer is asked again on a new port (each is safe to
 * repeat: a read, or a write of a whole record). A newer page may also
 * close before an older one (the second tab of the host, closed): a
 * request that goes unanswered JAR_CHECK_MS is asked again on the newest
 * port whose page is still open, as no new handshake will come.
 */
export class RemoteJar implements JarDB {
	/** the handshakes' ports, oldest first */
	#ports: JarPort[] = [];
	/** the port asked */
	#current: JarPort | null = null;
	#next = 0;
	#pending = new Map<number, Pending>();
	#checking: ReturnType<typeof setTimeout> | undefined;
	/** the jar changed in another slot's worker */
	onChanged?: (domain: string) => void;
	bind(given: JarPort) {
		const { port } = given;
		this.#ports.push(given);
		if (this.#ports.length > JAR_PORTS_KEPT) this.#ports.shift()!.port.close();
		this.#current = given;
		port.addEventListener('message', (event) => {
			const data = event.data as JarReply | JarChanged | null;
			if (typeof data !== 'object' || data === null) return;
			if ('jarChanged' in data) {
				this.onChanged?.(String(data.jarChanged));
				return;
			}
			const pending = this.#pending.get(data.jar);
			if (!pending) return;
			this.#pending.delete(data.jar);
			if (data.error === undefined) pending.resolve(data.result);
			else pending.reject(new Error(data.error));
		});
		port.start();
		for (const { call } of this.#pending.values()) port.postMessage(call);
	}
	/** tell the other slots' workers the jar changed for `domain` */
	changed(domain: string) {
		this.#current?.port.postMessage({
			jarChanged: domain,
		} satisfies JarChanged);
	}
	#ask(op: JarOp, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const call: JarCall = { jar: this.#next++, op, args };
			this.#pending.set(call.jar, { call, resolve, reject });
			this.#current?.port.postMessage(call);
			this.#watch();
		});
	}
	/** look at the pages behind the ports once a request has waited JAR_CHECK_MS */
	#watch() {
		if (this.#checking !== undefined) return;
		const asked = this.#next;
		this.#checking = setTimeout(() => {
			this.#checking = undefined;
			void this.#check(asked);
		}, JAR_CHECK_MS);
	}
	/**
	 * Requests asked before `asked` still have no answer: when the page of
	 * the port asked has gone, the newest port whose page is open is asked
	 * from now on, and every request without an answer again on it (none
	 * open: the port asked stays, for a page in the back/forward cache may
	 * come back, and a new handshake asks again anyway)
	 */
	async #check(asked: number) {
		const late = [...this.#pending.keys()].some((jar) => jar < asked);
		if (late && this.#current) {
			const asking = this.#current;
			if (!(await asking.alive().catch(() => true))) {
				let open: JarPort | null = null;
				for (const other of [...this.#ports].reverse()) {
					if (other === asking) continue;
					if (await other.alive().catch(() => false)) {
						open = other;
						break;
					}
				}
				if (open && this.#current === asking) {
					this.#current = open;
					for (const { call } of this.#pending.values())
						open.port.postMessage(call);
				}
			}
		}
		if (this.#pending.size) this.#watch();
	}
	getAllFromIndex(store: string, index: string, key: string) {
		return this.#ask('getAllFromIndex', [store, index, key]) as Promise<
			unknown[]
		>;
	}
	getAll(store: string) {
		return this.#ask('getAll', [store]) as Promise<unknown[]>;
	}
	get(store: string, key: string) {
		return this.#ask('get', [store, key]);
	}
	put(store: string, value: unknown, key?: string) {
		return this.#ask(
			'put',
			key === undefined ? [store, value] : [store, value, key],
		);
	}
	delete(store: string, key: string) {
		return this.#ask('delete', [store, key]) as Promise<void>;
	}
	clear(store: string) {
		return this.#ask('clear', [store]) as Promise<void>;
	}
}
