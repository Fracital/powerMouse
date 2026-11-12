// The scripted interactions of a site-support load, the same for every row:
// scroll with the mouse wheel, then either search (type into the site's
// search box and press Enter) or follow the first visible link. Input goes
// through real mouse and keyboard events at page coordinates; the proxied
// frame covers the whole viewport, so its coordinates are the page's.
import { sleep } from './net.mjs';

const SCROLLED = `(() => {
	let top = window.scrollY || 0;
	for (const el of document.querySelectorAll('*'))
		if (el.scrollTop > top) top = el.scrollTop;
	return top;
})()`;

const FIRST_LINK = `(() => {
	scrollTo(0, 0);
	for (const a of document.querySelectorAll('a[href]')) {
		const href = a.getAttribute('href') || '';
		if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
		if (a.target && a.target !== '_self' && a.target !== '_top') continue;
		const r = a.getBoundingClientRect();
		if (r.width < 12 || r.height < 8 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
		const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		if (!hit || !(hit === a || a.contains(hit))) continue;
		if (!(a.innerText || '').trim()) continue;
		return { x, y, text: a.innerText.trim().slice(0, 60) };
	}
	return null;
})()`;

const FIND = (selector) => `(() => {
	for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
		return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
	}
	return null;
})()`;

async function scroll(tab) {
	const before = await tab.probe.evalIn(tab.frameId, SCROLLED);
	if (before === null) return null;
	await tab.page.mouse.move(640, 400);
	for (let i = 0; i < 3; i++) {
		await tab.page.mouse.wheel(0, 600);
		await sleep(250);
	}
	await sleep(600);
	const after = await tab.probe.evalIn(tab.frameId, SCROLLED);
	return after !== null && after > before;
}

/** waits for the frame to show a new document or URL and finish loading it */
async function navigated(tab, before, timeoutMs = 15000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		await sleep(250);
		const ctx = tab.probe.contextOf(tab.frameId);
		const snap =
			ctx === null
				? null
				: await tab.probe
						.snapshot(tab.frameId, { text: false })
						.catch(() => null);
		if (!snap) continue;
		const changed = ctx !== before.ctx || snap.href !== before.href;
		if (changed && snap.readyState !== 'loading') {
			await sleep(1000);
			const done = await tab.probe.snapshot(tab.frameId).catch(() => null);
			return !!done && done.textLength > 0 && !done.challenge;
		}
	}
	return false;
}

/** { scroll, search, link, linkText } with null for what was not tried */
export async function interact(tab, site) {
	const out = { scroll: null, search: null, link: null };
	if (tab.bootError || tab.frameId === null) return out;
	try {
		out.scroll = await scroll(tab);
		const here = await tab.probe.snapshot(tab.frameId, { text: false });
		const before = { ctx: tab.probe.contextOf(tab.frameId), href: here?.href };
		if (site.search) {
			await tab.probe.evalIn(tab.frameId, 'scrollTo(0, 0)');
			await sleep(300);
			const at = await tab.probe.evalIn(
				tab.frameId,
				FIND(site.search.selector),
			);
			if (!at) out.search = false;
			else {
				await tab.page.mouse.click(at.x, at.y);
				await sleep(300);
				await tab.page.keyboard.type(site.search.text, { delay: 40 });
				await tab.page.keyboard.press('Enter');
				out.search = await navigated(tab, before);
			}
		} else {
			const link = await tab.probe.evalIn(tab.frameId, FIRST_LINK);
			if (!link) out.link = false;
			else {
				out.linkText = link.text;
				await tab.page.mouse.click(link.x, link.y);
				out.link = await navigated(tab, before);
			}
		}
	} catch (error) {
		out.error = error.message.split('\n')[0];
	}
	return out;
}
