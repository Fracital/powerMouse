// A site keeps what it stored however many other sites the site pool shows
// (docs/site-pool.md, "A site keeps its slot"). Natively a passkey outlives
// anything short of the user deleting it, and a site's storage outlives the
// visits to other sites. With the pool, a site's storage is its slot
// origin's, so a site that lost its slot would find nothing of it in the
// next: every assignment is kept (the host origin's IndexedDB, by slot
// origin), and the passkeys are the hub origin's (src/server/jarDB.ts), so
// a site shown from another slot still signs in.
//
// Natively, then through the demo with a pool of five in both modes, each
// in a browser profile of its own:
// - a site stores, and a new tab of the host shows it again; then the
//   operator changes the slot list four times (another order, slots taken
//   out, a list of two, each a new tab), and goes back to the first after a
//   new site took its first free slot: every visit shows the site from the
//   slot it had and it reads what it stored;
// - the host origin's localStorage is full (its own data, or the 200,000
//   sites the old kept text had room for) when a site is first seen: its
//   next visit, in a new tab after a new site, finds it where it was;
// - a site of the relying party (test/passkeys-rp.mjs) registers a passkey
//   (verified by the relying party) and stores in localStorage, IndexedDB,
//   Cache Storage and a cookie; more than 4096 sites are seen after it
//   (written into the host's kept assignments, as that many visits would
//   have left them, all on the site's own slot, then a new page load of the
//   host and one real visit to another site); the site's next page signs in
//   with the passkey and reads what it stored, from the slot it had. Then
//   its assignment is moved to another slot, as a lost one would be, and
//   after another page load it still signs in from there.
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

const originOf = (url) => new URL(url).origin;
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
	out.slots = { first: originOf(first.url()) };
	await between();
	await open(HOSTS.b);
	const again = await open(HOSTS.a);
	out.slots.again = originOf(again.url());
	out.login = (
		await run(again, 'login', { server: { user: 'kept' } })
	)?.verdict?.ok;
	out.read = await stored(again);
	if (moved) {
		out.moved = await moved();
		const elsewhere = await open(HOSTS.a);
		out.slots.elsewhere = originOf(elsewhere.url());
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

/**
 * A browser profile of its own whose host pages are served `order` of the
 * demo's slots (indexes into the list the server gives; null: as served),
 * as an operator's changed list would be: `tab()` opens a host page there,
 * `visit(page, host)` shows the relying party's page on `host` and gives its
 * frame and the slot it is shown from (an index into the served list)
 */
async function profile(base) {
	const context = await browser.newContext();
	let order = null;
	let served = null;
	await context.route('**/config.js', async (route) => {
		const response = await route.fetch();
		const text = await response.text();
		const config = JSON.parse(
			text.replace(/^window\.STOMP_CONFIG = /, '').replace(/;\s*$/, ''),
		);
		served = config.sitePool;
		if (order) config.sitePool = order.map((index) => served[index]);
		await route.fulfill({
			response,
			body: `window.STOMP_CONFIG = ${JSON.stringify(config)};\n`,
		});
	});
	let serial = 0;
	const tab = async () => {
		const page = await context.newPage();
		page.on('pageerror', (error) =>
			errors.push(`demo ${base} tab: ${error.message}`),
		);
		await page.goto(base);
		await page.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
		return page;
	};
	const visit = async (page, host) => {
		const id = `k${++serial}`;
		await submitLanding(page, `${rp.origin(host)}/pk/page?id=${id}`);
		for (let i = 0; i < 160; i++) {
			for (const frame of page.mainFrame().childFrames()) {
				const found = await frame
					.evaluate(() => window.__pk?.ready && window.__pk.id)
					.catch(() => null);
				if (found === id) {
					const port = Number(new URL(frame.url()).port);
					return { frame, slot: served.indexOf(port) };
				}
			}
			await sleep(250);
		}
		throw new Error(`no proxied page ${id}`);
	};
	/** fill the localStorage of the host origin's frames of `page` (the hub's) to the brim */
	const fill = async (page) => {
		const own = new URL(base === HOST ? PROXY : base).origin;
		const frames = page
			.frames()
			.filter((frame) => URL.parse(frame.url())?.origin === own);
		const filled = await frames[0].evaluate(() => {
			let size = 1 << 20;
			let i = 0;
			let chars = 0;
			while (size >= 16)
				try {
					localStorage.setItem(`fill-${i}`, 'x'.repeat(size));
					i++;
					chars += size;
				} catch (error) {
					size >>= 1;
				}
			return { keys: localStorage.length, chars };
		});
		return filled;
	};
	return {
		context,
		tab,
		visit,
		fill,
		set order(value) {
			order = value;
		},
		get served() {
			return served;
		},
	};
}

const browser = await launch();
for (const [mode, base, uv] of [
	['same-origin', PROXY, false],
	['isolated', HOST, true],
]) {
	// the operator changes the slot list: in another order, with slots
	// removed, and back to the first after more lists than the pool kept
	// assignments of, each a visit in a new tab of the host. Natively the
	// site reads what it stored on every revisit
	try {
		const kept = await profile(base);
		let page = await kept.tab();
		const first = await kept.visit(page, HOSTS.a);
		await store(first.frame);
		await page.close();
		page = await kept.tab();
		const revisit = await kept.visit(page, HOSTS.a);
		const revisitRead = await stored(revisit.frame);
		await page.close();
		ok(
			`${mode}: a revisit in a new tab of the host shows the site from its slot, with what it stored, as natively`,
			revisit.slot === first.slot && show(revisitRead) === show(native.read),
			show({ first: first.slot, again: revisit.slot, read: revisitRead }),
		);
		const own = first.slot;
		const others = kept.served
			.map((_, index) => index)
			.filter((index) => index !== own);
		const lists = [
			['in another order', [...others, own]],
			['with two slots removed', [others[3], own, others[1]]],
			[
				'with one removed and another order',
				[others[1], others[2], others[3], own],
			],
			['of two', [others[2], own]],
		];
		for (const [label, list] of lists) {
			kept.order = list;
			page = await kept.tab();
			const shown = await kept.visit(page, HOSTS.a);
			const read = await stored(shown.frame);
			await page.close();
			ok(
				`${mode}: the slot list changed (${label}), the site keeps its slot and reads what it stored, as natively`,
				shown.slot === own && show(read) === show(native.read),
				show({ list, first: own, now: shown.slot, read }),
			);
		}
		kept.order = null;
		page = await kept.tab();
		const another = await kept.visit(page, HOSTS.ga);
		const back = await kept.visit(page, HOSTS.a);
		const backRead = await stored(back.frame);
		await page.close();
		ok(
			`${mode}: back on the first list after ${lists.length} others, and after a new site, the site keeps its slot and reads what it stored, as natively`,
			back.slot === own &&
				another.slot !== own &&
				show(backRead) === show(native.read),
			show({
				first: own,
				now: back.slot,
				another: another.slot,
				read: backRead,
			}),
		);
		await kept.context.close();
	} catch (error) {
		ok(`${mode}: the changed slot lists ran`, false, error.stack);
	}
	// the host origin's localStorage is full (the host's own data, or some
	// 200,000 sites' assignments): a site first seen then keeps its slot on
	// its next visit, after a new site took the first free slot
	try {
		const full = await profile(base);
		let page = await full.tab();
		const filled = await full.fill(page);
		const first = await full.visit(page, HOSTS.a);
		await store(first.frame);
		await page.close();
		page = await full.tab();
		const another = await full.visit(page, HOSTS.ga);
		const again = await full.visit(page, HOSTS.a);
		const read = await stored(again.frame);
		await page.close();
		ok(
			`${mode}: with the host's localStorage full, a site seen then keeps its slot on its next visit and reads what it stored, as natively`,
			again.slot === first.slot &&
				another.slot !== first.slot &&
				show(read) === show(native.read),
			show({
				filled,
				first: first.slot,
				another: another.slot,
				again: again.slot,
				read,
			}),
		);
		await full.context.close();
	} catch (error) {
		ok(`${mode}: the full localStorage ran`, false, error.stack);
	}

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
	const ports = await page.evaluate(() => window.STOMP_CONFIG.sitePool);
	const slots = ports.map((port) => `http://127.0.0.1:${port}`);
	/** the frame of the host's origin that keeps the assignments (the hub's) */
	const hub = async () => {
		for (let i = 0; i < 80; i++) {
			for (const frame of [page.mainFrame(), ...page.frames()]) {
				const has = await frame
					.evaluate(async () =>
						(await indexedDB.databases()).some(
							(info) => info.name === 'kept-site-slots',
						),
					)
					.catch(() => false);
				if (has) return frame;
			}
			await sleep(250);
		}
		throw new Error('no kept assignments');
	};
	/**
	 * the site of `host` and its slot (an index into the pool's), from the
	 * host's kept assignments, edited by `edit`
	 */
	const assignment = async (host, edit = null, extra = 0) =>
		(await hub()).evaluate(
			async ([name, editing, count, slots]) => {
				const asked = (request) =>
					new Promise((resolve, reject) => {
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
				const db = await asked(indexedDB.open('kept-site-slots'));
				const keys = await asked(
					db.transaction('sites').objectStore('sites').getAllKeys(),
				);
				const site = keys.find((key) => {
					const hostname = new URL(key).hostname;
					return name === hostname || name.endsWith(`.${hostname}`);
				});
				const tx = db.transaction(['sites', 'slots'], 'readwrite');
				const sites = tx.objectStore('sites');
				const kept = site === undefined ? [] : await asked(sites.get(site));
				const origin = kept[0] ?? null;
				if (editing === 'seen') {
					// that many sites seen after it, all on its slot
					for (let i = 0; i < count; i++)
						sites.put([origin], `https://kept${i}.example`);
					const counts = tx.objectStore('slots');
					counts.put((await asked(counts.get(origin))) + count, origin);
				}
				if (editing === 'move')
					sites.put(
						[slots[(slots.indexOf(origin) + 1) % slots.length], ...kept],
						site,
					);
				await new Promise((resolve) => (tx.oncomplete = resolve));
				const total = await asked(
					db.transaction('sites').objectStore('sites').count(),
				);
				db.close();
				return { site, index: slots.indexOf(origin), sites: total };
			},
			[host, edit, extra, slots],
		);
	/** a new page load of the host: what it shows reads the kept assignments again */
	const reload = async () => {
		await page.reload();
		await page.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
	};
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
				await reload();
			},
			async () => {
				after = await assignment(HOSTS.a);
				moved = await assignment(HOSTS.a, 'move');
				await reload();
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
			after?.site === before?.site &&
				after?.index === before?.index &&
				proxied.slots.again === slots[before.index],
			show({ before, after, slots: proxied.slots }),
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
			proxied.moved !== before?.index &&
				proxied.slots.elsewhere === slots[proxied.moved] &&
				proxied.movedLogin === true,
			show({
				moved,
				now: proxied.moved,
				slots: proxied.slots,
				login: proxied.movedLogin,
			}),
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
