// A site keeps what it stored however many other sites the site pool shows
// (docs/site-pool.md, "A site keeps its slot"). Natively a passkey outlives
// anything short of the user deleting it, and a site's storage outlives the
// visits to other sites. With the pool, a site's storage is its slot
// origin's, so a site that lost its slot would find nothing of it in the
// next: every assignment is kept, and the passkeys are the hub origin's
// (src/server/jarDB.ts), so a site shown from another slot still signs in.
//
// Natively, then through the demo with a pool of five in both modes: a site
// of the relying party (test/passkeys-rp.mjs) registers a passkey (verified
// by the relying party) and stores in localStorage, IndexedDB, Cache Storage
// and a cookie; more than 4096 sites are seen after it (written into the
// host's kept assignments, as that many visits would have left them, all on
// the site's own slot, then one real visit to another site); the site's next
// page signs in with the passkey and reads what it stored, from the slot it
// had. Then its assignment is moved to another slot, as a lost one would
// be, and it still signs in.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startPasskeysRP } from '../passkeys-rp.mjs';

const rp = await startPasskeysRP();
const HOSTS = rp.hosts;
const errors = [];
const show = (value) => (JSON.stringify(value) ?? 'undefined').slice(0, 1500);
/** the sites the kept assignments are given, after the site under test */
const SEEN_AFTER = 4100;

const AUTHENTICATOR = {
	protocol: 'ctap2',
	ctap2Version: 'ctap2_1',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true,
};

const run = (frame, name, ...args) =>
	frame.evaluate(([n, a]) => window.__pk[n](...a), [name, args]);

/** what the site stores, in the page's own stores */
const store = (frame) =>
	frame.evaluate(async () => {
		localStorage.setItem('kept', 'local');
		document.cookie = 'kept=cookie; max-age=3600; path=/';
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('kept', 1);
			open.onupgradeneeded = () => open.result.createObjectStore('items');
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const tx = open.result.transaction('items', 'readwrite');
				tx.objectStore('items').put('database', 'kept');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
		await (await caches.open('kept')).put('/kept', new Response('cache'));
		return true;
	});
/** what the site reads of it */
const stored = (frame) =>
	frame.evaluate(async () => {
		const names = (await indexedDB.databases()).map((info) => info.name);
		const database = names.includes('kept')
			? await new Promise((resolve) => {
					const open = indexedDB.open('kept', 1);
					open.onerror = () => resolve(`error ${open.error}`);
					open.onsuccess = () => {
						const get = open.result
							.transaction('items')
							.objectStore('items')
							.get('kept');
						get.onsuccess = () => {
							open.result.close();
							resolve(get.result ?? null);
						};
						get.onerror = () => resolve(`error ${get.error}`);
					};
				})
			: null;
		const cached = await (await caches.open('kept')).match('/kept');
		return {
			localStorage: localStorage.getItem('kept'),
			cookie: /(?:^|; )kept=cookie(?:;|$)/.test(document.cookie),
			indexedDB: database,
			caches: cached ? await cached.text() : null,
		};
	});

/**
 * One visit after another: `open(host)` gives the top frame of the relying
 * party's page on `host`, `between()` is what happens after the first
 * (the sites seen), `moved()` moves the site to another slot (null: none)
 */
async function scenario(open, between, moved) {
	const out = {};
	const first = await open(HOSTS.a);
	out.register = (
		await run(first, 'register', { server: { user: 'kept' } })
	)?.verdict?.ok;
	out.stored = await store(first);
	await between();
	await open(HOSTS.b);
	const again = await open(HOSTS.a);
	out.login = (
		await run(again, 'login', { server: { user: 'kept' } })
	)?.verdict?.ok;
	out.read = await stored(again);
	if (moved) {
		out.moved = await moved();
		const elsewhere = await open(HOSTS.a);
		out.movedLogin = (
			await run(elsewhere, 'login', { server: { user: 'kept' } })
		)?.verdict?.ok;
	}
	return out;
}

// --- natively ---

const nativeBrowser = await launch(rp.nativeArgs);
let native;
{
	const context = await nativeBrowser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`native: ${error.message}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: AUTHENTICATOR,
	});
	let serial = 0;
	native = await scenario(
		async (host) => {
			await page.goto(`${rp.origin(host)}/pk/page?id=n${++serial}`);
			await page.waitForFunction(() => window.__pk?.ready === true, null, {
				timeout: 40000,
			});
			return page.mainFrame();
		},
		async () => {},
		null,
	);
	await context.close();
}
// (one browser at a time)
await nativeBrowser.close();
const expected = {
	localStorage: 'local',
	cookie: true,
	indexedDB: 'database',
	caches: 'cache',
};
ok(
	'natively: the site signs in with its passkey and reads what it stored',
	native.register === true &&
		native.login === true &&
		show(native.read) === show(expected),
	show(native),
);

// --- through the demo, with the pool ---

const browser = await launch();
for (const [mode, base, uv] of [
	['same-origin', PROXY, false],
	['isolated', HOST, true],
]) {
	const page = await openDemo(
		browser,
		`${base}?passkeys=test`,
		{},
		async (fresh) => {
			// a host that can verify the user has an authenticator of its own
			if (!uv) return;
			const cdp = await fresh.context().newCDPSession(fresh);
			await cdp.send('WebAuthn.enable');
			await cdp.send('WebAuthn.addVirtualAuthenticator', {
				options: AUTHENTICATOR,
			});
		},
	);
	let open = true;
	// every prompt accepted
	const clicker = (async () => {
		while (open) {
			try {
				const box = await page.$('#passkeyPrompt');
				const button = box
					? ((await box.$('.btn-blu')) ?? (await box.$('.close')))
					: null;
				if (button) await button.click();
			} catch (error) {
				// the prompt went as it was looked at
			}
			await sleep(50);
		}
	})();
	/** the frame of the host's origin that keeps the assignments (the hub's) */
	const hub = async () => {
		for (let i = 0; i < 80; i++) {
			for (const frame of [page.mainFrame(), ...page.frames()]) {
				const has = await frame
					.evaluate(() => localStorage.getItem('kept-site-slots') !== null)
					.catch(() => false);
				if (has) return frame;
			}
			await sleep(250);
		}
		throw new Error('no kept assignments');
	};
	/** the site of `host` and its slot's index in the pool's assignments, edited by `edit` */
	const assignment = async (host, edit = null, extra = 0) =>
		(await hub()).evaluate(
			([name, editing, count]) => {
				const pools = JSON.parse(localStorage.getItem('kept-site-slots'));
				const pool = pools.at(-1);
				const site = Object.keys(pool.sites).find((key) => {
					const hostname = new URL(key).hostname;
					return name === hostname || name.endsWith(`.${hostname}`);
				});
				const index = site === undefined ? null : pool.sites[site];
				if (editing === 'seen')
					// that many sites seen after it, all on its slot
					for (let i = 0; i < count; i++)
						pool.sites[`https://kept${i}.example`] = index;
				if (editing === 'move')
					pool.sites[site] = (index + 1) % pool.origins.length;
				if (editing)
					localStorage.setItem('kept-site-slots', JSON.stringify(pools));
				return { site, index, sites: Object.keys(pool.sites).length };
			},
			[host, edit, extra],
		);
	let serial = 0;
	let before = null;
	let after = null;
	let moved = null;
	try {
		const proxied = await scenario(
			async (host) => {
				const id = `p${++serial}`;
				await submitLanding(page, `${rp.origin(host)}/pk/page?id=${id}`);
				for (let i = 0; i < 160; i++) {
					for (const frame of page.mainFrame().childFrames()) {
						const found = await frame
							.evaluate(() => window.__pk?.ready && window.__pk.id)
							.catch(() => null);
						if (found === id) return frame;
					}
					await sleep(250);
				}
				throw new Error(`no proxied page ${id}`);
			},
			async () => {
				before = await assignment(HOSTS.a, 'seen', SEEN_AFTER);
			},
			async () => {
				after = await assignment(HOSTS.a);
				moved = await assignment(HOSTS.a, 'move');
				return (await assignment(HOSTS.a)).index;
			},
		);
		ok(
			`${mode}: the site registers its passkey and stores, from a slot`,
			proxied.register === true &&
				proxied.stored === true &&
				Number.isInteger(before?.index),
			show({ proxied, before }),
		);
		ok(
			`${mode}: after ${SEEN_AFTER} sites more and a visit to another, the site keeps its slot`,
			after?.site === before?.site && after?.index === before?.index,
			show({ before, after }),
		);
		ok(
			`${mode}: there the site signs in with its passkey, as natively`,
			proxied.login === native.login && proxied.login === true,
			show(proxied.login),
		);
		ok(
			`${mode}: and reads its localStorage, IndexedDB, Cache Storage and cookie, as natively`,
			show(proxied.read) === show(native.read),
			show(proxied.read),
		);
		ok(
			`${mode}: shown from another slot, the site still signs in with its passkey (the hub's store)`,
			proxied.moved !== before?.index && proxied.movedLogin === true,
			show({ moved, now: proxied.moved, login: proxied.movedLogin }),
		);
		const listed = await page.evaluate(() => window.controller.passkeys.list());
		ok(
			`${mode}: the host's passkeys list has the site's one credential`,
			listed.filter((key) => key.rpId === HOSTS.a).length === 1,
			show(listed),
		);
		await page.evaluate(() => window.controller.passkeys.clear());
	} catch (error) {
		ok(`${mode}: the scenario ran`, false, error.stack);
	}
	open = false;
	await clicker;
	errors.push(...page.errors.map((error) => `demo ${mode}: ${error}`));
	await page.close();
}

rp.close();
await done(browser, errors);
