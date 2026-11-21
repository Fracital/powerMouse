import type { IDBPDatabase } from 'idb';
import { openStoreDB } from '../storeDB';
import type {
	DeviceGrant,
	DeviceKind,
	PermissionDecision,
	PermissionOp,
	PermissionState,
	PermissionStates,
} from '../transport/messages';
import { PERMISSION_ROUTE } from '../transport/messages';
import type { HintsDocument } from './clientHints';
import {
	DEVICE_GRANTS_DATABASE,
	DEVICE_GRANTS_STORE,
	PERMISSIONS_DATABASE,
	PERMISSIONS_STORE,
	type JarDB,
} from './jarDB';
import type Router from './Router';
import { json } from './Router';

/**
 * Permissions per proxied site (docs/permissions.md). The browser keeps
 * one permission per origin, and every proxied site is the proxy origin:
 * once the user lets one site use the camera, the browser lets all of them.
 * So the worker keeps each site's own answer (the proxied top's real
 * origin, as Chrome delegates a frame's permission to its top), shows the
 * page that state, and lets a request reach the browser's API only when
 * this site was granted it, or when nothing was decided yet and the
 * browser's own prompt will ask the user (the proxy origin has not decided
 * either). When the proxy origin already holds the permission another
 * site was given, the host asks the user for this site
 * (onPermissionRequest); without a host prompt the request is dismissed.
 * A site's permission is never taken from another's.
 */

/** the permissions a site is asked about, default `prompt`; `push` is notifications' */
export const SIMULATED_PERMISSIONS = [
	'geolocation',
	'camera',
	'microphone',
	'notifications',
	'clipboard-read',
	'midi',
	'persistent-storage',
	'local-fonts',
	'idle-detection',
	'window-management',
	'display-capture',
	'captured-surface-control',
	'local-network-access',
];

/** the policy-controlled features of a WebAuthn request: creating a credential, asking for an assertion */
export const PASSKEY_FEATURES = [
	'publickey-credentials-create',
	'publickey-credentials-get',
];

let store: Promise<IDBPDatabase | null> | null = null;
const states = new Map<string, PermissionState>();
let loaded: Promise<void> | null = null;
/**
 * the site pool: a slot's worker keeps the states and the device grants in
 * the host origin's databases, which every slot's worker asks
 * (src/server/jarDB.ts), and reads each one anew: another slot's worker
 * may have changed it
 */
let remote: JarDB | null = null;

/** the site pool: ask the host's databases for the states and the devices, over the jar's port */
export function usePermissionsRemote(db: JarDB) {
	remote = db;
}

function openStore(): Promise<IDBPDatabase | null> {
	store ??= openStoreDB(PERMISSIONS_DATABASE, 1, {
		upgrade: (db) => {
			db.createObjectStore(PERMISSIONS_STORE);
		},
	}).catch(() => null);
	return store;
}

const keyOf = (site: string, name: string) => `${site} ${name}`;

function load(): Promise<void> {
	loaded ??= (async () => {
		const db = await openStore();
		if (!db) return;
		try {
			const tx = db.transaction('states', 'readonly');
			const keys = (await tx.store.getAllKeys()) as string[];
			const values = (await tx.store.getAll()) as PermissionState[];
			await tx.done;
			// (a value that is no state is FedCM's: keptValue)
			keys.forEach((key, i) => {
				if (!states.has(key) && typeof values[i] === 'string')
					states.set(key, values[i]);
			});
		} catch (error) {
			// no store: this worker's answers only
		}
	})();
	return loaded;
}

async function stateOf(site: string, name: string): Promise<PermissionState> {
	if (remote) {
		try {
			const kept = await remote.get(PERMISSIONS_STORE, keyOf(site, name));
			return kept === 'granted' || kept === 'denied' ? kept : 'prompt';
		} catch (error) {
			// the host's page is gone: what this worker last heard
			return states.get(keyOf(site, name)) ?? 'prompt';
		}
	}
	await load();
	return states.get(keyOf(site, name)) ?? 'prompt';
}

async function setState(site: string, name: string, state: PermissionState) {
	if (remote) {
		const key = keyOf(site, name);
		if (state === 'prompt') states.delete(key);
		else states.set(key, state);
		try {
			if (state === 'prompt') await remote.delete(PERMISSIONS_STORE, key);
			else await remote.put(PERMISSIONS_STORE, state, key);
		} catch (error) {
			// kept for this worker's life only
		}
		return;
	}
	await load();
	const key = keyOf(site, name);
	if (state === 'prompt') states.delete(key);
	else states.set(key, state);
	const db = await openStore();
	try {
		if (state === 'prompt') await db?.delete('states', key);
		else await db?.put('states', state, key);
	} catch (error) {
		// kept for this worker's life only
	}
}

/**
 * A value the store keeps under `key` beside the states: what the browser
 * keeps of a site's FedCM sign-ins (src/server/identityStates.ts), which
 * Chrome keeps as permissions too. Read anew each time: another slot's
 * worker, or another of this worker's documents, may have changed it
 */
export async function keptValue(key: string): Promise<unknown> {
	try {
		if (remote) return await remote.get(PERMISSIONS_STORE, key);
		return await (await openStore())?.get(PERMISSIONS_STORE, key);
	} catch (error) {
		return undefined;
	}
}
/** keep `value` under `key` (keptValue); undefined forgets it */
export async function keepValue(key: string, value: unknown): Promise<void> {
	try {
		if (remote)
			await (value === undefined
				? remote.delete(PERMISSIONS_STORE, key)
				: remote.put(PERMISSIONS_STORE, value, key));
		else {
			const db = await openStore();
			await (value === undefined
				? db?.delete(PERMISSIONS_STORE, key)
				: db?.put(PERMISSIONS_STORE, value, key));
		}
	} catch (error) {
		// not kept: the sign-in is remembered by nothing
	}
}

/** what a document reads: its site's states and its own policy */
export async function documentStates(
	site: string,
	doc: HintsDocument | null,
): Promise<PermissionStates> {
	const out: Record<string, PermissionState> = {};
	for (const name of SIMULATED_PERMISSIONS)
		out[name] = await stateOf(site, name);
	return {
		site,
		states: out,
		features: doc
			? {
					...Object.fromEntries(doc.features),
					// what WebAuthn asks of the policy (the Credentials inject module)
					...Object.fromEntries(
						PASSKEY_FEATURES.map((feature) => [
							feature,
							doc.allFeatures.get(feature) !== false,
						]),
					),
				}
			: null,
	};
}

// a prompt of the browser's the worker handed a document: the result it
// reports is taken only for that request
const pending = new Map<string, { site: string; name: string; at: number }>();
// a prompt left open longer is taken as dismissed
const PENDING_MS = 2 * 60 * 1000;

function token(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** a site's request for `name`, the proxy origin's real state being `real` */
export async function decide(
	site: string,
	name: string,
	real: PermissionState,
	ask: () => Promise<boolean | null>,
): Promise<PermissionDecision> {
	const state = await stateOf(site, name);
	if (state === 'granted') return { decision: 'granted' };
	if (state === 'denied') return { decision: 'denied' };
	// the browser itself refuses the proxy origin: no prompt can change it
	if (real === 'denied') return { decision: 'blocked' };
	if (real === 'prompt') {
		const now = Date.now();
		for (const [key, entry] of pending)
			if (now - entry.at > PENDING_MS) pending.delete(key);
		// the browser shows one prompt for the proxy origin: two sites asking
		// at once would both get the one answer the user gave the first
		for (const entry of pending.values())
			if (entry.name === name && entry.site !== site)
				return { decision: 'dismissed' };
		const id = token();
		pending.set(id, { site, name, at: now });
		return { decision: 'browser', token: id };
	}
	// the proxy origin holds the permission, another site's answer: only
	// the user may say this site gets it too
	const answer = await ask().catch(() => null);
	if (answer === null) return { decision: 'dismissed' };
	await setState(site, name, answer ? 'granted' : 'denied');
	return { decision: answer ? 'granted' : 'denied' };
}

/** how the browser's prompt for a `browser` decision ended */
export async function settle(
	site: string,
	name: string,
	id: string,
	state: PermissionState,
) {
	const entry = pending.get(id);
	if (!entry || entry.site !== site || entry.name !== name) return;
	pending.delete(id);
	if (state !== 'prompt') await setState(site, name, state);
}

/**
 * The device ids a proxied origin reads are the browser's, hashed with the
 * origin's salt (the Permissions inject module): the same for the origin
 * in every document and under any top-level site, as Chrome's are, never
 * another origin's. The salt goes when the cookies of the origin's host
 * are cleared (cookies.clear), as Chrome's does with a site's cookies; an
 * opaque origin has a new one every time.
 */
let saltStore: Promise<IDBPDatabase | null> | null = null;
const salts = new Map<string, Promise<string>>();

function openSalts(): Promise<IDBPDatabase | null> {
	saltStore ??= openStoreDB('stompDeviceIds', 1, {
		upgrade: (db) => {
			db.createObjectStore('salts');
		},
	}).catch(() => null);
	return saltStore;
}

export function deviceSalt(origin: string): Promise<string> {
	if (origin === 'null') return Promise.resolve(token() + token());
	let salt = salts.get(origin);
	if (!salt) {
		salt = (async () => {
			const db = await openSalts();
			try {
				const kept: unknown = await db?.get('salts', origin);
				if (typeof kept === 'string') return kept;
			} catch (error) {
				// no store: this worker's salt only
			}
			const made = token() + token();
			try {
				await db?.put('salts', made, origin);
			} catch (error) {
				// kept for this worker's life only
			}
			return made;
		})();
		salts.set(origin, salt);
	}
	return salt;
}

/** forget the ids of every origin of `host` (of every origin without one): their next documents read new ones */
export async function forgetDeviceIds(host?: string) {
	const hosted = (origin: string) => {
		try {
			return host === undefined || new URL(origin).hostname === host;
		} catch (error) {
			return false;
		}
	};
	for (const origin of [...salts.keys()])
		if (hosted(origin)) salts.delete(origin);
	const db = await openSalts();
	try {
		for (const origin of ((await db?.getAllKeys('salts')) ?? []) as string[])
			if (hosted(origin)) await db?.delete('salts', origin);
	} catch (error) {
		// nothing was kept
	}
}

/**
 * The devices each site chose in the browser's chooser (WebUSB, WebHID,
 * Web Serial, Web Bluetooth). The browser keeps a device grant per origin,
 * and every proxied site is the proxy origin: what one site was granted,
 * every site's getDevices() listed, and a site's forget() revoked it for
 * all of them. So the worker keeps each site's own (by the proxied top's
 * real origin, as the permissions above), and a page lists only what its
 * site chose. A device is known by a key the inject makes of what the
 * browser shows of it (a Bluetooth device's id, the others' identifying
 * fields), and a Bluetooth device keeps the services the site named.
 * With the site pool they are the host origin's one store (asked over the
 * jar's port): Chrome keeps the browser's grant for the top-level origin,
 * the host's for every slot.
 */
export const DEVICE_KINDS: readonly DeviceKind[] = [
	'usb',
	'hid',
	'serial',
	'bluetooth',
];
let grantStore: Promise<IDBPDatabase | null> | null = null;
let grantsLoaded: Promise<void> | null = null;
const grants = new Map<string, string[]>();
const grantKey = (site: string, kind: DeviceKind, key: string) =>
	`${site} ${kind} ${key}`;

function openGrants(): Promise<IDBPDatabase | null> {
	grantStore ??= openStoreDB(DEVICE_GRANTS_DATABASE, 1, {
		upgrade: (db) => {
			db.createObjectStore(DEVICE_GRANTS_STORE);
		},
	}).catch(() => null);
	return grantStore;
}

function loadGrants(): Promise<void> {
	grantsLoaded ??= (async () => {
		const db = await openGrants();
		if (!db) return;
		try {
			const tx = db.transaction(DEVICE_GRANTS_STORE, 'readonly');
			const keys = (await tx.store.getAllKeys()) as string[];
			const values = (await tx.store.getAll()) as string[][];
			await tx.done;
			keys.forEach((key, i) => {
				if (!grants.has(key))
					grants.set(key, Array.isArray(values[i]) ? values[i] : []);
			});
		} catch (error) {
			// no store: this worker's grants only
		}
	})();
	return grantsLoaded;
}

/**
 * the site pool: the grants' keys in the host's store, null when its page
 * is gone (what this worker last heard then)
 */
async function remoteGrantKeys(db: JarDB): Promise<string[] | null> {
	try {
		const keys = await db.getAllKeys(DEVICE_GRANTS_STORE);
		return keys.filter((key): key is string => typeof key === 'string');
	} catch (error) {
		return null;
	}
}

/** the site pool: the services the host's store keeps for `id`, null when its page is gone */
async function remoteServices(db: JarDB, id: string): Promise<string[] | null> {
	try {
		const services = await db.get(DEVICE_GRANTS_STORE, id);
		return Array.isArray(services) ? services : [];
	} catch (error) {
		return null;
	}
}

/** the devices of `kind` `site` was granted */
export async function deviceGrants(
	site: string,
	kind: DeviceKind,
): Promise<DeviceGrant[]> {
	const prefix = grantKey(site, kind, '');
	const out: DeviceGrant[] = [];
	const keys = remote ? await remoteGrantKeys(remote) : null;
	if (remote && keys) {
		for (const key of keys)
			if (key.startsWith(prefix))
				out.push({
					key: key.slice(prefix.length),
					services:
						(await remoteServices(remote, key)) ?? grants.get(key) ?? [],
				});
		return out;
	}
	if (!remote) await loadGrants();
	for (const [key, services] of grants)
		if (key.startsWith(prefix))
			out.push({ key: key.slice(prefix.length), services });
	return out;
}

/** `site` chose `key`: kept, with the services it named added to the ones it had */
export async function grantDevice(
	site: string,
	kind: DeviceKind,
	key: string,
	services: string[] = [],
) {
	if (!key || key.length > 1024) return;
	const id = grantKey(site, kind, key);
	let had: string[] | undefined;
	if (remote) had = (await remoteServices(remote, id)) ?? grants.get(id);
	else {
		await loadGrants();
		had = grants.get(id);
	}
	const kept = new Set(had ?? []);
	for (const service of services.slice(0, 256))
		if (typeof service === 'string' && service.length <= 64) kept.add(service);
	const value = [...kept];
	grants.set(id, value);
	try {
		if (remote) await remote.put(DEVICE_GRANTS_STORE, value, id);
		else await (await openGrants())?.put(DEVICE_GRANTS_STORE, value, id);
	} catch (error) {
		// kept for this worker's life only
	}
}

/**
 * `site` forgets `key`; whether another site still holds it (with the site
 * pool, a site of any slot: the browser's grant is the host's for all)
 */
export async function forgetDevice(
	site: string,
	kind: DeviceKind,
	key: string,
): Promise<boolean> {
	if (!remote) await loadGrants();
	const id = grantKey(site, kind, key);
	grants.delete(id);
	try {
		if (remote) await remote.delete(DEVICE_GRANTS_STORE, id);
		else await (await openGrants())?.delete(DEVICE_GRANTS_STORE, id);
	} catch (error) {
		// gone for this worker's life only
	}
	const suffix = ` ${kind} ${key}`;
	const keys = remote ? await remoteGrantKeys(remote) : null;
	for (const other of keys ?? grants.keys())
		if (other.endsWith(suffix)) return true;
	return false;
}

/** a document's (or a worker's) device op for `site`; null for one that is not */
export function deviceOp(
	site: string,
	message: PermissionOp,
): Promise<DeviceGrant[] | boolean> | null {
	if (
		(message.op !== 'devices' &&
			message.op !== 'grant' &&
			message.op !== 'forget') ||
		!DEVICE_KINDS.includes(message.kind)
	)
		return null;
	if (message.op === 'devices') return deviceGrants(site, message.kind);
	const key = String(message.key);
	if (message.op === 'forget') return forgetDevice(site, message.kind, key);
	return grantDevice(
		site,
		message.kind,
		key,
		Array.isArray(message.services) ? message.services : [],
	).then(() => true);
}

/**
 * A worker's questions (messages.ts PERMISSION_ROUTE): only a worker
 * client of this origin asks, and only what it may read (its site's
 * states and devices) or forget of its own site. The site is the one its
 * route named its realm by, as its storage and cookies are: `siteOf`
 * reads it from the worker's routed URL, and a claim that is not that
 * site is refused (a blob: or data: worker's URL names none: its claim,
 * which its bootstrap was given, stands).
 */
export function registerPermissionRoute(
	router: Router,
	siteOf: (url: string) => string | null,
) {
	router.routes.set(
		new RegExp(`^/${PERMISSION_ROUTE}$`),
		async (request, _url, context) => {
			const refused = () => json(403, null);
			if (
				request.method !== 'POST' ||
				!context?.clientId ||
				typeof clients === 'undefined'
			)
				return refused();
			const found = await clients.get(context.clientId);
			if (!found || (found.type !== 'worker' && found.type !== 'sharedworker'))
				return refused();
			let body: PermissionOp & { site?: unknown };
			let site: string;
			try {
				const text = await request.text();
				if (text.length > 4096) return refused();
				body = JSON.parse(text);
				site = String(body.site);
				const url = new URL(site);
				if (!/^https?:$/.test(url.protocol) || url.origin !== site)
					return refused();
				const routed = siteOf(found.url);
				if (routed !== null && routed !== site) return refused();
			} catch (error) {
				return refused();
			}
			if (body.op === 'states')
				return json(200, await documentStates(site, null));
			if (body.op === 'devices' || body.op === 'forget')
				return json(200, await deviceOp(site, body));
			return refused();
		},
	);
}
