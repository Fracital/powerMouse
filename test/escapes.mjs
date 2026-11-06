// Every way a click or a script on a proxied page could navigate the host
// window, in either mode: same-origin (host and proxy on 127.0.0.1, where only
// the frame sandbox and the rewriter stand in the way) or isolated (host on
// localhost). A vector "escapes" when the host page's URL changes. One suite
// file per mode under suites/, so the two run at once.
import { done, FIXTURE, HOST, launch, ok, PROXY, sleep } from '../lib.mjs';

let browser;

// id -> what a contained page shows afterwards (the frame title)
const VECTORS = {
	top: 'FIXTURE', // <a target=_top>: refused by the sandbox, nothing moves
	parent: 'FIXTURE', // <a target=_parent>
	fbtn: 'FIXTURE', // <form target=_top>
	open: 'FIXTURE', // window.open(url, '_top')
	plain: 'LANDED', // ordinary link: the frame navigates through the proxy
	toploc: 'LANDED', // top.location = url: rewritten to the frame's own location
	bracket: 'LANDED', // window['to'+'p'].location.href = url
};

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
			await frame.go(fixture);
			await new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
		}, FIXTURE);
		await sleep(800);
		const frame = page
			.frames()
			.find(
				(f) =>
					f.parentFrame() === page.mainFrame() &&
					f.url().includes('/stomp/html/'),
			);
		const popup = context
			.waitForEvent('page', { timeout: 2500 })
			.catch(() => null);
		await frame.click(`#${id}`);
		const opened = await popup;
		await sleep(1500);
		let title;
		try {
			const after = page
				.frames()
				.find(
					(f) =>
						f.parentFrame() === page.mainFrame() &&
						f.url().includes('/stomp/html/'),
				);
			title = after ? await after.title() : 'gone';
		} catch (error) {
			title = `error ${error.message.slice(0, 40)}`;
		}
		ok(
			`${mode}: ${id} stays in the frame`,
			page.url() === base && title === expected && !opened,
			`host ${page.url()} frame ${title}${opened ? ` popup ${opened.url()}` : ''}`,
		);
		await context.close();
	}
	await done(browser);
}
