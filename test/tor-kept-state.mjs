// The Tor client's kept state as a later visit reads it back
// (demo/public/tor-client/keptState.mjs, docs/tor-over-wisp.md "Bootstrap
// from the kept state"): a kept consensus is handed to arti only until its
// valid-until, an expired one is deleted, one whose times do not read is
// not used, and the rest of the state (guards, certificates,
// microdescriptors) passes as it is. `node --test test/tor-kept-state.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	consensusTimes,
	liveDirectory,
	rangedStorage,
} from '../demo/public/tor-client/keptState.mjs';

/** a store as tor-js's TorStorage, in memory */
function memory(entries = []) {
	const data = new Map(entries);
	const calls = [];
	return {
		data,
		calls,
		get: async (key) => data.get(key) ?? null,
		set: async (key, value) => void data.set(key, value),
		delete: async (key) => {
			calls.push(['delete', key]);
			data.delete(key);
		},
		keys: async (prefix) =>
			[...data.keys()].filter((key) => key.startsWith(prefix)).sort(),
		getAll: async (prefix) =>
			[...data].filter(([key]) => key.startsWith(prefix)),
		tryLock: async () => true,
		unlock: async () => {},
	};
}

const HOUR = 3600;
/** a consensus record as tor-js writes it, valid from `after` (seconds) for three hours */
const record = (after, content = 'network-status-version 3 microdesc') =>
	JSON.stringify({
		valid_after_secs: after,
		fresh_until_secs: after + HOUR,
		valid_until_secs: after + 3 * HOUR,
		sha3_of_signed_hex: '00',
		sha3_of_whole_hex: '00',
		pending: false,
		content,
	});

const T0 = 1795575600;
const at = (seconds) => () => seconds * 1000;

test('a consensus record reads its times', () => {
	assert.deepEqual(consensusTimes(record(T0)), {
		validAfter: T0 * 1000,
		freshUntil: (T0 + HOUR) * 1000,
		validUntil: (T0 + 3 * HOUR) * 1000,
	});
	assert.equal(consensusTimes('network-status-version 3 microdesc'), null);
	assert.equal(consensusTimes(null), null);
});

test('a live consensus is handed over, before and after fresh-until', async () => {
	for (const now of [T0 + 60, T0 + HOUR + 60, T0 + 3 * HOUR - 1]) {
		const store = memory([
			['dir:consensus:microdesc:aa', record(T0)],
			['dir:microdesc:01', '{"content":"onion-key"}'],
		]);
		const heard = [];
		const live = liveDirectory(store, {
			now: at(now),
			consensus: (value, times, kept) => heard.push([times.validAfter, kept]),
		});
		const all = await live.getAll('dir:');
		assert.deepEqual(
			all.map(([key]) => key),
			['dir:consensus:microdesc:aa', 'dir:microdesc:01'],
			`at ${now}`,
		);
		assert.equal(await live.get('dir:consensus:microdesc:aa'), record(T0));
		assert.deepEqual(heard[0], [T0 * 1000, undefined]);
		assert.deepEqual(store.calls, []);
	}
});

test('an expired consensus is not handed over and is deleted; the rest of the state is', async () => {
	const guards = '{"default":{"guards":[],"confirmed":[]}}';
	const store = memory([
		['dir:consensus:microdesc:old', record(T0)],
		['dir:consensus:microdesc:new', record(T0 + 4 * HOUR)],
		['dir:authcert:aa:bb', '{"id_fingerprint_hex":"aa"}'],
		['dir:microdesc:01', '{"content":"onion-key"}'],
		['state:guards', guards],
	]);
	const heard = [];
	const live = liveDirectory(store, {
		now: at(T0 + 3 * HOUR + 1),
		consensus: (value) => heard.push(value),
	});
	const all = await live.getAll('dir:');
	assert.deepEqual(
		all.map(([key]) => key),
		['dir:consensus:microdesc:new', 'dir:authcert:aa:bb', 'dir:microdesc:01'],
	);
	assert.deepEqual(heard, [record(T0 + 4 * HOUR)]);
	assert.equal(await live.get('dir:consensus:microdesc:old'), null);
	assert.deepEqual(await live.keys('dir:consensus:'), [
		'dir:consensus:microdesc:new',
	]);
	assert.equal(await live.get('state:guards'), guards);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(store.calls, [['delete', 'dir:consensus:microdesc:old']]);
	assert.equal(store.data.has('dir:consensus:microdesc:old'), false);
});

test('a consensus whose times do not read is not used, and not deleted', async () => {
	const store = memory([['dir:consensus:x', 'network-status-version 3']]);
	const heard = [];
	const live = liveDirectory(store, {
		now: at(T0),
		consensus: (value) => heard.push(value),
	});
	assert.deepEqual(await live.getAll('dir:consensus:'), []);
	assert.equal(await live.get('dir:consensus:x'), null);
	assert.deepEqual(heard, []);
	assert.deepEqual(store.calls, []);
});

test('a consensus arti keeps is heard as its newest, and kept', async () => {
	const store = memory();
	const heard = [];
	const live = liveDirectory(store, {
		now: at(T0 + 60),
		consensus: (value, times, kept) => heard.push([times?.validAfter, kept]),
	});
	await live.set('dir:consensus:microdesc:aa', record(T0));
	await live.set('dir:consensus:stand-in', 'no times');
	assert.deepEqual(heard, [
		[T0 * 1000, true],
		[undefined, true],
	]);
	assert.equal(store.data.get('dir:consensus:microdesc:aa'), record(T0));
});

test('a storage that is not tor-js IndexedDB one is used as it is', () => {
	const store = memory();
	assert.equal(rangedStorage(store), store);
});
