// What a host does with a profile as a whole (src/profile.ts): register
// its service worker, and forget it. Forgetting deletes every store of the
// profile on this origin and ends its service worker, so the next
// controller of the profile starts with none (docs/tor.md "Profiles": the
// demo's Tor mode forgets its profile when the last Tor tab is gone).
import { assetName, type Assets } from '../config';
import {
	checkProfile,
	profileOfName,
	profileOfScript,
	profileScriptURL,
	profileStoreName,
} from '../profile';

/** where this origin keeps the name of a profile's service worker (profileWorker) */
const WORKER_KEY = 'stomp-profile-worker';

/**
 * The query of `profile`'s service worker script: its profile and, for a
 * profile other than the default, a name its forgetting changes. Chrome
 * gives a scope registered again soon after it was unregistered the same
 * registration back, and with it the same running worker, whose memory
 * (the codec key, what it holds of the profile's stores) outlived the
 * forgotten stores. A script of another URL is a worker of its own: the
 * name is kept in the profile's localStorage keys, which forgetProfile
 * deletes, so the profile's next registration installs a new worker.
 */
export function profileWorker(profile: string): string {
	profile = checkProfile(profile);
	if (!profile) return '';
	let name = '';
	try {
		name = localStorage.getItem(profileStoreName(WORKER_KEY, profile)) ?? '';
		if (!/^[a-z0-9]{8,32}$/.test(name)) {
			name = randomName();
			localStorage.setItem(profileStoreName(WORKER_KEY, profile), name);
		}
	} catch {
		// no storage: a worker of its own for every registration
		name ||= randomName();
	}
	return `?${new URLSearchParams({ profile, worker: name })}`;
}

const randomName = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
		(byte % 36).toString(36),
	).join('');

/** the service worker script of `profile` in `scope` */
export function serviceWorkerScript(
	scope: URL | string,
	assets: Assets | undefined,
	profile: string,
): URL {
	const url = profileScriptURL(
		new URL(assetName(assets, 'serviceWorker'), scope),
		'',
	);
	const query = new URLSearchParams(profileWorker(profile));
	for (const [name, value] of query) url.searchParams.set(name, value);
	return url;
}

/** what forgetProfile found and what it could not delete */
export interface ForgottenProfile {
	/** the service worker registrations unregistered */
	registrations: number;
	databases: number;
	caches: number;
	/** keys of this origin's localStorage and this tab's sessionStorage */
	keys: number;
	/** directories of the origin private file system and the legacy one */
	directories: number;
	/** the names of the stores that are still there (a database still open elsewhere) */
	left: string[];
}

/** how long a deletion waits for a connection elsewhere to let go */
const DELETE_WAIT_MS = 15000;

function deleteDatabase(name: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.deleteDatabase(name);
		} catch (error) {
			return resolve(false);
		}
		// a connection that does not close on the deletion's versionchange
		// (a realm of another build) holds it: it completes once that realm
		// goes, which is not waited for past DELETE_WAIT_MS
		const timer = setTimeout(() => resolve(false), DELETE_WAIT_MS);
		request.onsuccess = () => {
			clearTimeout(timer);
			resolve(true);
		};
		request.onerror = () => {
			clearTimeout(timer);
			resolve(false);
		};
	});
}

/** the legacy file system's root of `type` (0 TEMPORARY, 1 PERSISTENT), or null */
function legacyRoot(type: number): Promise<FileSystemDirectoryEntry | null> {
	const request = (
		globalThis as {
			webkitRequestFileSystem?: (
				type: number,
				size: number,
				ok: (system: FileSystem) => void,
				error: () => void,
			) => void;
		}
	).webkitRequestFileSystem;
	if (typeof request !== 'function') return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			request(
				type,
				0,
				(system) => resolve(system.root),
				() => resolve(null),
			);
		} catch (error) {
			resolve(null);
		}
	});
}

/** remove the directories of `root` whose name ends with the profile's `-<id>` (src/inject/legacyFileSystem.ts) */
async function forgetLegacyDirectories(
	root: FileSystemDirectoryEntry,
	id: string,
): Promise<number> {
	const entries = await new Promise<FileSystemEntry[]>((resolve) => {
		const all: FileSystemEntry[] = [];
		const reader = root.createReader();
		const next = () =>
			reader.readEntries(
				(batch) => {
					if (!batch.length) return resolve(all);
					all.push(...batch);
					next();
				},
				() => resolve(all),
			);
		next();
	});
	let removed = 0;
	for (const entry of entries)
		if (
			entry.isDirectory &&
			entry.name.startsWith('site-') &&
			entry.name.endsWith(`-${id}`)
		)
			removed += await new Promise<number>((resolve) =>
				(
					entry as FileSystemDirectoryEntry & {
						removeRecursively(done: () => void, failed: () => void): void;
					}
				).removeRecursively(
					() => resolve(1),
					() => resolve(0),
				),
			);
	return removed;
}

/**
 * Delete every store of profile `profile` on this origin (src/profile.ts):
 * its service worker registrations (unregistered first, so no worker of it
 * keeps a cookie or a page in memory for the next controller), its
 * IndexedDB databases and Cache Storage caches (STomp's and those the
 * proxied sites made), its keys of this origin's localStorage and of this
 * tab's sessionStorage, and its directories of the origin private file
 * system and the legacy one. The default profile cannot be forgotten this
 * way, and a profile whose controller is open should not be: its pages'
 * stores go under them. Run it on the origin whose stores they are: the
 * host's page in the same-origin mode, the controller frame's
 * (`RemoteController.forgetProfile`) in the isolated one.
 */
export async function forgetProfile(
	profile: string,
): Promise<ForgottenProfile> {
	const id = checkProfile(profile);
	if (!id) throw new TypeError('The default profile cannot be forgotten');
	const ours = (name: string) => profileOfName(name) === id;
	const result: ForgottenProfile = {
		registrations: 0,
		databases: 0,
		caches: 0,
		keys: 0,
		directories: 0,
		left: [],
	};
	try {
		for (const registration of (await navigator.serviceWorker?.getRegistrations()) ??
			[]) {
			const worker =
				registration.active ?? registration.waiting ?? registration.installing;
			let of = '';
			try {
				of = worker ? profileOfScript(new URL(worker.scriptURL).search) : '';
			} catch (error) {
				// a worker that names no valid profile is no profile's
			}
			if (of === id && (await registration.unregister().catch(() => false)))
				result.registrations++;
		}
	} catch (error) {
		// no service workers here
	}
	try {
		const names = ((await indexedDB.databases?.()) ?? [])
			.map((info) => info.name ?? '')
			.filter(ours);
		for (const name of names)
			if (await deleteDatabase(name)) result.databases++;
			else result.left.push(name);
	} catch (error) {
		// indexedDB.databases() is not available, or storage is blocked
	}
	try {
		for (const name of (await caches.keys()).filter(ours))
			if (await caches.delete(name)) result.caches++;
			else result.left.push(name);
	} catch (error) {
		// Cache Storage is not available, or storage is blocked
	}
	for (const area of ['localStorage', 'sessionStorage'] as const)
		try {
			const storage = globalThis[area];
			const keys: string[] = [];
			for (let i = 0; i < storage.length; i++) {
				const key = storage.key(i);
				if (key !== null && ours(key)) keys.push(key);
			}
			for (const key of keys) storage.removeItem(key);
			result.keys += keys.length;
		} catch (error) {
			// storage is blocked here
		}
	try {
		const root =
			(await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
				keys(): AsyncIterable<string>;
			};
		const names: string[] = [];
		for await (const name of root.keys()) {
			let decoded = name;
			try {
				decoded = decodeURIComponent(name);
			} catch (error) {
				// not one of the Partition module's names
			}
			if (ours(decoded)) names.push(name);
		}
		for (const name of names)
			try {
				await root.removeEntry(name, { recursive: true });
				result.directories++;
			} catch (error) {
				result.left.push(name);
			}
	} catch (error) {
		// no origin private file system here
	}
	for (const type of [0, 1]) {
		const root = await legacyRoot(type);
		if (root) result.directories += await forgetLegacyDirectories(root, id);
	}
	return result;
}
