// Every way a click or a script on a proxied page could navigate the host
// window, in either mode: same-origin (host and proxy on 127.0.0.1, where only
// the frame sandbox and the rewriter stand in the way) or isolated (host on
// localhost). A vector "escapes" when the host page's URL changes. One suite
// file per mode under suites/, so the two run at once.
import { done, FIXTURE, HOST, launch, ok, PROXY, sleep } from './lib.mjs';

let browser;

// id -> what a contained page shows afterwards (the frame title)
const VECTORS = {
	// a real top-level page navigates itself for these: _top / _parent map
	// to _self and window.open(url, '_top') becomes a navigation of the frame
	top: 'LANDED', // <a target=_top>
	parent: 'LANDED', // <a target=_parent>
	fbtn: 'LANDED', // <form target=_top>
	open: 'LANDED', // window.open(url, '_top')
	plain: 'LANDED', // ordinary link: the frame navigates through the proxy
	toploc: 'LANDED', // top.location = url: rewritten to the frame's own location
	bracket: 'LANDED', // window['to'+'p'].location.href = url
	docloc: 'LANDED', // document.location = url: routed like window.location
	// a new tab is the host's to open (demo: onOpen -> a new switcher tab),
	// never a bare proxied popup; the page's window.open gets null
	blank: 'FIXTURE', // <a target=_blank>
	openblank: 'FIXTURE', // window.open(url)
};
const NEW_TAB = ['blank', 'openblank'];

export async function runMode(mode) {
	const base = mode === 'isolated' ? HOST : PROXY;
	browser = await launch();
	for (const [id, expected] of Object.entries(VECTORS)) {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(base);
		await page.waitForFunction(
			() => window.controller && window.controller.isReady,
			null,
			{ timeout: 45000 },
		);
		// a frame of our own above the landing overlay, so clicks reach it
		await page.evaluate(async (fixture) => {
			const element = document.createElement('iframe');
			element.style.cssText =
				'position:fixed;inset:0;width:800px;height:600px;z-index:999999';
			document.getElementById('landing').classList.add('hidden');
			document.body.append(element);
			const frame = window.controller.createFrame(element);
			// listen before go(): it resolves when the document reported, which
			// can be after the frame's load event
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(fixture);
			await loaded;
		}, FIXTURE);
		await sleep(800);
		const frame = page
			.frames()
			.find(
				(f) =>
					f.parentFrame() === page.mainFrame() &&
					/\/stomp\/[\w-]+\/html\//.test(f.url()),
			);
		const tabs = () =>
			page.evaluate(() => document.querySelectorAll('.frame').length);
		const tabsBefore = await tabs();
		const popup = context
			.waitForEvent('page', { timeout: 2500 })
			.catch(() => null);
		await frame.click(`#${id}`);
		const opened = await popup;
		await sleep(1500);
		const newTabs = (await tabs()) - tabsBefore;
		const blocked =
			id === 'openblank'
				? await frame.evaluate(() => window.__opened === null)
				: true;
		let title;
		try {
			const after = page
				.frames()
				.find(
					(f) =>
						f.parentFrame() === page.mainFrame() &&
						/\/stomp\/[\w-]+\/html\//.test(f.url()),
				);
			title = after ? await after.title() : 'gone';
		} catch (error) {
			title = `error ${error.message.slice(0, 40)}`;
		}
		const wantTabs = NEW_TAB.includes(id) ? 1 : 0;
		ok(
			`${mode}: ${id} ${wantTabs ? 'opens a host tab' : 'stays in the frame'}`,
			// the demo mirrors the active tab in the hash; the host document
			// itself must never change
			page.url().split('#')[0] === base &&
				title === expected &&
				!opened &&
				newTabs === wantTabs &&
				blocked,
			`host ${page.url()} frame ${title} new tabs ${newTabs}${opened ? ` popup ${opened.url()}` : ''}${blocked ? '' : ' window.open returned a window'}`,
		);
		await context.close();
	}
	await done(browser);
}
