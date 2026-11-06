// CSS that never passes through a <link>: rules inserted with insertRule,
// constructable sheets (replace / replaceSync), FontFace sources, and the
// text of a <style> element, which must be rewritten before the browser
// parses it (an @import must never be fetched from the proxy origin).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/css.html`);

let css = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		css = (await frame.evaluate(() => window.__css)) || {};
	} catch (error) {
		css = {};
	}
	if (css.done) break;
}
const routed = (value) =>
	typeof value === 'string' && value.includes('/stomp/binary/');
ok(
	'insertRule url() is routed',
	routed(css.insertRule),
	JSON.stringify(css.insertRule),
);
ok(
	'replaceSync url() is routed',
	routed(css.replaceSync),
	JSON.stringify(css.replaceSync),
);
ok(
	'replace() url() is routed',
	routed(css.replace),
	JSON.stringify(css.replace),
);
ok(
	'<style> text url() is routed',
	routed(css.styleText),
	JSON.stringify(css.styleText),
);
const requests = css.requests || [];
const proxyOrigin = new URL(PROXY).origin;
const raw = requests.filter((name) => name.startsWith(`${proxyOrigin}/pages/`));
ok(
	'nothing was fetched from the proxy origin unrouted',
	raw.length === 0,
	raw.join(' '),
);
ok(
	'@import in <style> went through the proxy',
	requests.some((name) => name.includes('/stomp/css/')),
	requests.filter((n) => n.includes('/stomp/')).join(' '),
);
const fontRequests = requests.filter(
	(name) =>
		name.includes('/stomp/binary/') &&
		decodeURIComponent(name).includes('font.woff2'),
);
ok(
	'FontFace source went through the proxy',
	fontRequests.length > 0,
	requests.filter((n) => /font/.test(decodeURIComponent(n))).join(' '),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
