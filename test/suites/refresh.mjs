// A document that asks to refresh: by a Refresh response header (the shell
// re-opens the document to write the page, which drops a refresh the header
// scheduled, so the worker carries it into the markup) and by a meta refresh
// in the page. Both land on the target, routed, and the page stays in
// standards mode. Same-origin mode.
import { done, FIXTURE, launch, ok, openDemo, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
const result = await page.evaluate(async (fixture) => {
	const load = async (path) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		await frame.go(`${fixture}pages/${path}`);
		for (let i = 0; i < 30; i++) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			if (/^HIST/.test(element.contentDocument?.title ?? '')) break;
		}
		return {
			title: element.contentDocument?.title ?? 'unreadable',
			url: frame.url,
		};
	};
	// the meta page first: a frame left on a page whose refresh was lost
	// can disturb the next load
	const meta = await load('refresh-meta.html');
	const header = await load('refresh-header.html');
	return { header, meta };
}, FIXTURE);
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
