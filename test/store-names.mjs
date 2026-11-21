// Every store STomp opens is named in its profile (src/profile.ts), so a
// store added later cannot be shared between Tor mode and the normal mode
// (docs/tor.md "Profiles"). This reads the source: each call that opens or
// names a store (an IndexedDB database, a Cache Storage cache, a key of
// localStorage or sessionStorage, a BroadcastChannel, a SharedWorker) must
// take its name from storeName (or an alias of it) or be one of the
// reviewed exceptions below; the proxied contexts' native names must be
// made from the profile's key (Client.nativeKey), never the bare storage
// key. `node --test test/store-names.mjs`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
	nativeStoreKey,
	profileOfName,
	profileStoreName,
} from '../src/profile.ts';

const root = new URL('..', import.meta.url).pathname;

function files(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...files(path));
		else if (/\.ts$/.test(name)) out.push(path);
	}
	return out;
}

/** a call that opens or names a store, and what its name must come from */
const OPENS =
	/\bopenDB\(|indexedDB\.open\(|caches\.(?:open|delete)\(|new BroadcastChannel\(|new SharedWorker\(|(?:local|session)Storage\.(?:getItem|setItem|removeItem)\(/g;
const NAMED =
	/^\s*(?:storeName|profileName|profileStoreName|scriptCache|fileCache)\(/;

// reviewed: what each names and why it is the profile's, or no store
const EXCEPTIONS = [
	// the one idb open, which names it with storeName
	['src/storeDB.ts', 'openDB<T>('],
	// a profile's wipe deletes what profileOfName says is the profile's
	['src/controller/profiles.ts', 'caches.delete(name)'],
	// Clear-Site-Data and the forget-site shield delete names matched in the
	// worker's profile (profileOfName, nativeStoreKey)
	['src/server/Storage.ts', 'caches.delete(key)'],
	['src/server/Storage.ts', 'caches.delete(name)'],
	// the extensions' channels are named by the scope or the address, whose
	// worker is one profile's (createServer refuses another)
	['src/controller/extensions.ts', 'new BroadcastChannel('],
	['src/server/extensions/registry.ts', 'new BroadcastChannel('],
	['src/server/extensions/fetchEvents.ts', 'new BroadcastChannel(name)'],
	['src/server/extensions/webRequest.ts', 'new BroadcastChannel(name)'],
	['src/server/serviceWorker.ts', 'new BroadcastChannel('],
	// the carrier host is a SharedWorker of the transport worker's script,
	// whose URL names the profile (profileScriptURL)
	['src/transport/carrierClient.ts', 'new SharedWorker(script'],
	// a called frame's history, keyed by storeName in its constructor
	['src/controller/justCallStomp.ts', 'Storage.getItem(this.#key)'],
	['src/controller/justCallStomp.ts', 'Storage.setItem('],
];

test('every store STomp opens is named in its profile', () => {
	const unnamed = [];
	for (const path of files(join(root, 'src'))) {
		const file = relative(root, path);
		// the proxied contexts' hooks pass the page's own names, suffixed
		// with the profile's key (checked below)
		if (file.startsWith('src/inject/')) continue;
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(OPENS)) {
			const after = text.slice(
				match.index + match[0].length,
				match.index + 200,
			);
			if (NAMED.test(after)) continue;
			const line = text.slice(
				text.lastIndexOf('\n', match.index) + 1,
				text.indexOf('\n', match.index),
			);
			const context = `${line}\n${match[0]}${after}`;
			if (
				EXCEPTIONS.some(
					([where, what]) => where === file && context.includes(what),
				)
			)
				continue;
			unnamed.push(`${file}: ${line.trim()}`);
		}
	}
	assert.deepEqual(unnamed, [], 'a store opened by a name of no profile');
});

test('the store helpers name their stores in the profile', () => {
	const store = readFileSync(
		join(root, 'src/server/extensions/store.ts'),
		'utf8',
	);
	assert.match(store, /const fileCache = \(id: string\) => storeName\(/);
	assert.match(
		store,
		/export const scriptCache = \(id: string\) =>\s*storeName\(/,
	);
});

test('the proxied contexts name native stores by the profile key', () => {
	const bare = [];
	for (const path of files(join(root, 'src/inject'))) {
		const text = readFileSync(path, 'utf8');
		for (const pattern of [
			/@\$\{(?:client|moduleClient|this\.client)\.storageKey\}/g,
			/redirected\(\w+, client\.storageKey\)/g,
			/\$stomp\$[a-z]+:\$\{[^}]*storageKey\}/gi,
		])
			for (const match of text.matchAll(pattern))
				bare.push(`${relative(root, path)}: ${match[0]}`);
	}
	assert.deepEqual(bare, []);
});

test('a name tells its profile, and the default profile keeps its names', () => {
	assert.equal(profileStoreName('stompCookies', ''), 'stompCookies');
	assert.equal(profileStoreName('stompCookies', 'tor'), 'stompCookies|tor');
	assert.equal(profileOfName('stompCookies|tor'), 'tor');
	assert.equal(profileOfName('stompCookies'), '');
	// a site's database: its own name, then `@` and its key in the profile
	const key = nativeStoreKey('https://a.example^https://b.example', 'tor');
	assert.equal(profileOfName(`db@${key}`), 'tor');
	assert.equal(profileOfName('db|tor@https://a.example'), '');
	// a page cannot name its store into another profile: its part comes
	// before `@<origin>`, and an origin has no `|`
	assert.equal(profileOfName('x|tor@https://evil.example'), '');
	// an extension's channel has a long id after its `|`: no profile
	assert.equal(profileOfName(`bus|${'a'.repeat(32)}`), '');
});
