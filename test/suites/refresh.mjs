// A document that asks to refresh: by a Refresh response header (the shell
// re-opens the document to write the page, which drops a refresh the header
// scheduled, so the worker carries it into the markup) and by a meta refresh
// in the page. Both land on the target, routed, and the page stays in
// standards mode. Same-origin mode.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
// the frame's title is read in the frame itself (a Playwright Frame): with
// the site pool the proxied document is of a slot's origin, which the host
// page's realm cannot read
const load = async (path, id) => {
	const url = await page.evaluate(
		async ([fixture, path, id]) => {
			const element = document.createElement('iframe');
			element.id = id;
			document.body.append(element);
			const frame = window.controller.createFrame(element);
			window[id] = frame;
			await frame.go(`${fixture}pages/${path}`);
			return frame.url;
		},
		[FIXTURE, path, id],
	);
	let title = 'unreadable';
	for (let i = 0; i < 30; i++) {
		await sleep(200);
		const frame = await (await page.$(`#${id}`))?.contentFrame();
		title = (await frame?.title().catch(() => null)) ?? 'unreadable';
		if (/^HIST/.test(title)) break;
	}
	return {
		title,
		url: (await page.evaluate((id) => window[id].url, id)) ?? url,
	};
};
// the meta page first: a frame left on a page whose refresh was lost
// can disturb the next load
const meta = await load('refresh-meta.html', 'meta');
const header = await load('refresh-header.html', 'header');
const result = { header, meta };
ok(
	'a Refresh response header navigates the frame to its target through the proxy',
	result.header.title === 'HIST 1' &&
		result.header.url === `${FIXTURE}pages/hist-1.html`,
	JSON.stringify(result.header),
);
ok(
	'a meta refresh navigates the frame to its target through the proxy',
	result.meta.title === 'HIST 2' &&
		result.meta.url === `${FIXTURE}pages/hist-2.html`,
	JSON.stringify(result.meta),
);
await done(browser, page.errors);
