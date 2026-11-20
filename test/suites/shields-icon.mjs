// The demo's Shields panel showed the site's icon as a CSS background of
// the URL the proxied page declared, so the host page loaded the real icon
// itself, outside the proxy: a request from the user's own address to the
// site, which every other part of the demo avoids. The panel now shows the
// icon its tab's page fetched through the proxy (as a bookmark's is), a PNG
// data URL, and the globe until it has one.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const ICON = 'bookmark-icon.svg';
const browser = await launch();
const page = await openDemo(browser);
// every request the host page's own document makes for the icon
const leaked = [];
page.on('request', (request) => {
	if (request.frame() === page.mainFrame() && request.url().includes(ICON))
		leaked.push(request.url());
});
await submitLanding(page, `${FIXTURE}pages/bookmark-a.html`);
const until = async (read, want, timeout = 30000) => {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
};
await until(
	() =>
		!document.getElementById('browser').classList.contains('hidden') &&
		!document.getElementById('toolShields').hidden,
	Boolean,
);
// the page has said which icon it has by the time its title is shown
await sleep(1500);
await page.click('#toolShields');
const shown = await until(
	() =>
		document.querySelector('#shieldsPanel .shieldsFavicon')?.style
			.backgroundImage ?? '',
	(value) => typeof value === 'string' && value.includes('data:image/png'),
	20000,
);
ok(
	"the Shields panel shows the site's icon as fetched through the proxy",
	typeof shown === 'string' && shown.includes('data:image/png'),
	String(shown).slice(0, 120),
);
await sleep(500);
ok(
	'the host page never requested the icon itself',
	leaked.length === 0,
	JSON.stringify(leaked),
);

await done(browser, page.errors);
