// Run against the protected demo as well as the plain one:
// STOMP_DEMO_SITE="$PWD/build/demo-site" PARALLEL=1 npm test -- demo-image-hydration
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	proxyOwned,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
try {
	const page = await openDemo(browser, PROXY);
	const leaked = [];
	page.on('request', (request) => {
		if (
			request.url().startsWith(FIXTURE) ||
			(proxyOwned(request.url()) &&
				new URL(request.url()).pathname === '/pages/object-events.png')
		)
			leaked.push(request.url());
	});
	await submitLanding(page, `${FIXTURE}pages/image-hydration.html`);
	const frame = await waitActive(
		page,
		() => document.body?.dataset.realm !== undefined,
	);
	ok(
		'hydration keeps the page realm',
		await frame.evaluate(() => document.body.dataset.realm === 'true'),
	);
	ok(
		'hydrated image and picture decode',
		!!(await waitActive(
			page,
			() => document.body?.dataset.loaded === 'yes',
			15000,
		).catch(() => null)),
	);
	ok(
		'hydration makes no direct or unrouted requests',
		leaked.length === 0,
		leaked.join(', '),
	);
} catch (error) {
	ok('hydration suite completes', false, String(error));
} finally {
	await done(browser);
}
