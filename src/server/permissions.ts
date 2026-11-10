import { openDB, type IDBPDatabase } from 'idb';
import type {
	PermissionDecision,
	PermissionState,
	PermissionStates,
} from '../transport/messages';
import type { HintsDocument } from './clientHints';

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

let store: Promise<IDBPDatabase | null> | null = null;
const states = new Map<string, PermissionState>();
let loaded: Promise<void> | null = null;

function openStore(): Promise<IDBPDatabase | null> {
	store ??= openDB('stompPermissions', 1, {
		upgrade: (db) => {
			db.createObjectStore('states');
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
			keys.forEach((key, i) => {
				if (!states.has(key)) states.set(key, values[i]);
			});
		} catch (error) {
			// no store: this worker's answers only
		}
	})();
	return loaded;
}

async function stateOf(site: string, name: string): Promise<PermissionState> {
	await load();
	return states.get(keyOf(site, name)) ?? 'prompt';
}

async function setState(site: string, name: string, state: PermissionState) {
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
		features: doc ? Object.fromEntries(doc.features) : null,
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
