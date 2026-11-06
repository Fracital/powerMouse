// The build id baked into the controller bundle, the service worker and the
// inject bundle must agree: the controller handshake checks it (wait()
// rejects otherwise) and the page client checks the bundle it runs from.
// One build cannot produce a mismatch, so this checks that all three carry
// the same id and that it is the package version (or STOMP_BUILD).
import { readFileSync } from 'node:fs';
import { done, launch, ok, openDemo, PROXY } from '../lib.mjs';

const pkg = JSON.parse(
	readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const browser = await launch();
const page = await openDemo(browser, PROXY);
const hostBuild = await page.evaluate(() => window.controller.config.build);
ok(
	'the controller config carries the service worker build id',
	typeof hostBuild === 'string' && hostBuild.startsWith(pkg.version),
	JSON.stringify(hostBuild),
);
await page.evaluate(async () => {
	const element = document.createElement('iframe');
	document.body.append(element);
	await window.controller.createFrame(element).go('https://example.com/');
	await new Promise((resolve) =>
		element.addEventListener('load', resolve, { once: true }),
	);
});
const pageBuild = await page.evaluate(() => {
	const frame = document.querySelector('iframe:not(.frame)');
	return frame.contentWindow.$P$s.config.build;
});
ok(
	'the page client got the same build id from the shell',
	pageBuild === hostBuild,
	JSON.stringify(pageBuild),
);
ok(
	'wait() resolved, so the controller and the service worker agree',
	(await page.evaluate(() =>
		window.controller.wait().then(
			() => true,
			(e) => String(e),
		),
	)) === true,
);

await done(browser, page.errors);
