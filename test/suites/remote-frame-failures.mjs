// RemoteController.wait() had no bound: every way the controller frame can
// fail to load left it pending for good. The browser shows a blocked frame
// as an error page and fires its load event, and the host page's
// ReportingObserver hears why (a csp-violation report for frame-ancestors, a
// coep report for a response without CORP or COEP). wait() now rejects with
// a ControllerFrameError that names the cause as soon as the report comes,
// and, for a frame that loaded and never answered (a 404, a wrong path),
// a few seconds after its load event with the causes it could be.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	sleep,
	waitForServer,
} from '../lib.mjs';

await waitForServer(HOST);
const browser = await launch();
const errors = [];

const SETTLE = `window.__settle = async (init, bound) => {
	const started = performance.now();
	try {
		const remote = new StompRemoteController(init);
		await Promise.race([
			remote.wait(),
			new Promise((resolve, reject) =>
				setTimeout(() => reject(new Error('no answer in ' + bound + ' ms')), bound),
			),
		]);
		return { name: 'resolved', ms: Math.round(performance.now() - started) };
	} catch (error) {
		return {
			name: error.name,
			message: error.message,
			ms: Math.round(performance.now() - started),
		};
	}
};`;

// a transport is never reached: the frame fails before
const transport = { module: '/nowhere/index.mjs', options: [] };

/** a host page: the fixture's own (not isolated), or the demo's (cross-origin isolated) */
async function hostPage(isolated) {
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	if (isolated) await page.goto(HOST);
	else {
		await page.goto(`${FIXTURE}pages/remote-host-noref.html`);
		await page.addScriptTag({ url: `${HOST}stomp/Controller.js` });
	}
	await page.waitForFunction(() => typeof StompRemoteController === 'function');
	await page.addScriptTag({ content: SETTLE });
	return page;
}

async function attempt(page, init) {
	return page.evaluate(
		([init, transport]) =>
			window.__settle(
				{ ...init, transport, codec: 'xor', id: 'failing' },
				30000,
			),
		[init, transport],
	);
}

// the fixture under another origin than the host page's
const other = FIXTURE.replace('127.0.0.1', 'localhost');

{
	const page = await hostPage(false);
	const result = await attempt(page, {
		proxyOrigin: other,
		directory: '/pages/',
		assets: { controllerFrame: 'cf-ancestors.html' },
	});
	ok(
		'a frame-ancestors that does not list the host page: a ControllerFrameError that names it',
		result.name === 'ControllerFrameError' &&
			/frame-ancestors/.test(result.message) &&
			result.message.includes(new URL(FIXTURE).origin) &&
			result.ms < 4000,
		JSON.stringify(result),
	);

	const missing = await attempt(page, {
		proxyOrigin: other,
		directory: '/pages/',
		assets: { controllerFrame: 'cf-missing.html' },
	});
	ok(
		'a frame that loads and never answers (a 404): a ControllerFrameError with the likely causes, in bounded time',
		missing.name === 'ControllerFrameError' &&
			/did not answer/.test(missing.message) &&
			/controllerFrame\.html/.test(missing.message) &&
			missing.ms < 15000,
		JSON.stringify(missing),
	);
	await page.close();
}

{
	const page = await hostPage(true);
	ok(
		'the demo host page is cross-origin isolated',
		await page.evaluate(() => crossOriginIsolated),
	);
	// the fixture's real controller frame, served with no CORP
	const noCorp = await attempt(page, {
		proxyOrigin: FIXTURE,
		directory: '/neutral/',
		assets: {
			controllerFrame: 'frame.html',
			controllerFrameScript: 'frame.js',
		},
	});
	ok(
		'an isolated host and a frame without Cross-Origin-Resource-Policy: a ControllerFrameError that names it',
		noCorp.name === 'ControllerFrameError' &&
			/Cross-Origin-Resource-Policy/.test(noCorp.message) &&
			noCorp.ms < 4000,
		JSON.stringify(noCorp),
	);
	const noCoep = await attempt(page, {
		proxyOrigin: FIXTURE,
		directory: '/pages/',
		assets: { controllerFrame: 'cf-corp-only.html' },
	});
	ok(
		'an isolated host and a frame without Cross-Origin-Embedder-Policy: a ControllerFrameError that names it',
		noCoep.name === 'ControllerFrameError' &&
			/Cross-Origin-Embedder-Policy: require-corp/.test(noCoep.message) &&
			noCoep.ms < 4000,
		JSON.stringify(noCoep),
	);
	await page.close();
}

await sleep(0);
await done(browser, errors);
