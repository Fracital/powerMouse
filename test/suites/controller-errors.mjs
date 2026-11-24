// Two errors a host met that named the wrong cause. A host page whose
// Content-Security-Policy has no 'wasm-unsafe-eval' may not compile the
// rewriter's wasm core module, and wait() said "the host does not serve the
// asset 'core'" though it served it. And register() on a page that is not a
// secure context (plain http off localhost), where the browser hides
// navigator.serviceWorker, said "Your browser does not support service
// workers." Both now say what is wrong and what to change.
import { readFileSync } from 'node:fs';
import { done, launch, ok, PROXY, waitForServer } from '../lib.mjs';

await waitForServer(PROXY);
const browser = await launch();
const errors = [];

/** wait() of a same-origin controller on a page of PROXY served with `policy` */
async function underPolicy(policy) {
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	const url = `${PROXY}controller-errors-host.html`;
	await page.route(url, (route) =>
		route.fulfill({
			contentType: 'text/html',
			headers: { 'content-security-policy': policy },
			body: '<!doctype html><title>csp host</title>',
		}),
	);
	await page.goto(url);
	await page.addScriptTag({ url: '/stomp/Controller.js' });
	const result = await page.evaluate(async (proxy) => {
		try {
			const registration = await window.StompController.register('/stomp/');
			const controller = new window.StompController({
				serviceworker: registration,
				transport: {
					module: `${proxy}epoxy/index.mjs`,
					options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await Promise.race([
				controller.wait(),
				new Promise((resolve, reject) =>
					setTimeout(() => reject(new Error('no answer in 30 s')), 30000),
				),
			]);
			return { resolved: true };
		} catch (error) {
			return { message: String(error.message) };
		}
	}, PROXY);
	await page.close();
	return result;
}

const blocked = await underPolicy("script-src 'self'");
ok(
	"a host CSP without 'wasm-unsafe-eval': wait() names the policy, not a missing asset",
	/wasm-unsafe-eval/.test(blocked.message ?? '') &&
		/Content-Security-Policy/.test(blocked.message) &&
		!/does not serve/.test(blocked.message),
	JSON.stringify(blocked),
);
const allowed = await underPolicy("script-src 'self' 'wasm-unsafe-eval'");
ok(
	"the same policy with 'wasm-unsafe-eval': wait() resolves",
	allowed.resolved === true,
	JSON.stringify(allowed),
);

// register() that resolves empty (Playwright serviceWorkers: "block")
// is wait()'s failure, not an unhandled read of .state on a later turn
{
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(PROXY);
	await page.addScriptTag({ url: '/stomp/Controller.js' });
	const result = await page.evaluate(async () => {
		try {
			const controller = new window.StompController({
				serviceworker: Promise.resolve(undefined),
				transport: { module: '/x.mjs' },
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			return { resolved: true };
		} catch (error) {
			return { message: String(error.message) };
		}
	});
	await page.waitForTimeout(500);
	ok(
		'register() resolving empty: wait() says there is no registration, and the page does not throw',
		/without a service worker registration/.test(result.message ?? '') &&
			!errors.some((message) => /state/.test(message)),
		JSON.stringify({ result, errors }),
	);
	await page.close();
}

// a page that is not a secure context: a host name of its own over http,
// answered by the test (it resolves nowhere)
{
	const page = await browser.newPage();
	await page.route('http://insecure.test/**', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><title>insecure host</title>',
		}),
	);
	await page.goto('http://insecure.test/');
	await page.addScriptTag({
		content: readFileSync(
			new URL('../../dist/Controller.js', import.meta.url),
			'utf8',
		),
	});
	const result = await page.evaluate(async () => {
		const secure = isSecureContext;
		let registered;
		try {
			await window.StompController.register('/stomp/');
			registered = 'resolved';
		} catch (error) {
			registered = error.message;
		}
		let constructed;
		try {
			new window.StompController({
				serviceworker: {},
				transport: { module: '/x.mjs' },
				directory: '/stomp/',
			});
			constructed = 'made';
		} catch (error) {
			constructed = error.message;
		}
		return { secure, registered, constructed };
	});
	ok(
		'register() off a secure context says it needs one (HTTPS or localhost)',
		result.secure === false &&
			/secure context/.test(result.registered) &&
			/HTTPS/.test(result.registered) &&
			/localhost/.test(result.registered),
		JSON.stringify(result),
	);
	ok(
		'so does the constructor',
		/secure context/.test(result.constructed),
		JSON.stringify(result),
	);
	await page.close();
}

await done(browser, errors);
