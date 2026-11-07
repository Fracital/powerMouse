// A fetch's credentials mode reaches the jar the way the browser applies its
// own: `omit` sends no cookies and stores none from the response, `same-origin`
// sends them only when the real origins agree, `include` and the default send
// them. And a route that decodes to the proxy's own origin is refused with a
// 403 instead of making the proxy fetch itself.
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
const proxy = new URL(PROXY).origin;
await submitLanding(
	page,
	`${FIXTURE}pages/credentials.html?proxy=${encodeURIComponent(proxy)}`,
);
let cred = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		cred = (await frame.evaluate(() => window.__cred)) || {};
	} catch (error) {
		cred = {};
	}
	if (cred.done) break;
}
const has = (value, name) =>
	typeof value === 'string' && value.includes(`${name}=1`);
ok(
	'the default, same-origin and include modes send the jar cookies',
	has(cred.defaultMode, 'cred') &&
		has(cred.sameOrigin, 'cred') &&
		has(cred.include, 'cred'),
	JSON.stringify([cred.defaultMode, cred.sameOrigin, cred.include]),
);
ok(
	'credentials: omit sends no cookies',
	cred.omit === null || cred.omit === '',
	JSON.stringify(cred.omit),
);
ok(
	'a Set-Cookie answered to an omit request is not stored',
	has(cred.afterOmitSet, 'cred') && !has(cred.afterOmitSet, 'omitted'),
	JSON.stringify(cred.afterOmitSet),
);
ok(
	'a route to the proxy origin itself is refused with 403',
	cred.self?.status === 403 && /own origin/.test(cred.self?.text || ''),
	JSON.stringify(cred.self),
);
// the refused document is one the proxy never injected, so the page sees it
// like a cross-origin frame (contentDocument null); its text is the refusal
const nested = page.frames().find((f) => f.url().includes('html:nested'));
const nestedText = nested
	? await nested
			.evaluate(() => [document.contentType, document.body?.textContent])
			.catch((error) => String(error))
	: 'no frame';
ok(
	'a frame navigated to the proxy origin shows the refusal, not the host page',
	// the built-in plain refusal, or the host's error page when the demo
	// configures one (errorPage): both name the refusal
	Array.isArray(nestedText) &&
		/^text\/(plain|html)$/.test(nestedText[0]) &&
		/own origin/.test(nestedText[1] || '') &&
		cred.selfFrame === 'unreadable',
	JSON.stringify([nestedText, cred.selfFrame]),
);
ok(
	'the fixture ran to completion',
	cred.done === true && !cred.error,
	cred.error,
);
await done(browser, page.errors);
