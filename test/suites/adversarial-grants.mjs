// What a site that was never asked gets of another site's grants
// (test/pages/adv-grants.html): the browser keeps one grant for the proxy
// origin, which every proxied site is, so the proxy origin is given each
// permission before the page runs, as if another site had been, and every
// probe that gets a position, a device, a shown notification or a CDM's
// persistent state got that grant (docs/permissions.md).
import { runGroup } from '../adversarial.mjs';
import { NO_AUDIO } from '../lib.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none.
const KNOWN_OPEN = {};

const HELD = [
	'geolocation',
	'camera',
	'microphone',
	'notifications',
	'window-management',
	'local-fonts',
	'midi',
	'clipboard-read',
	'persistent-storage',
];

await runGroup(
	'grants',
	{},
	{
		knownOpen: KNOWN_OPEN,
		args: ['--use-fake-device-for-media-stream'],
		env: NO_AUDIO,
		before: async (page, browser, base) => {
			const session = await page.context().newCDPSession(page);
			const { targetInfo } = await session.send('Target.getTargetInfo');
			await session.detach();
			const cdp = await browser.newBrowserCDPSession();
			for (const name of HELD)
				await cdp.send('Browser.setPermission', {
					permission: { name },
					setting: 'granted',
					origin: new URL(base).origin,
					browserContextId: targetInfo.browserContextId,
				});
			// (kept: the browser drops a session's overrides when it detaches)
			await page.context().setGeolocation({ latitude: 12, longitude: 34 });
		},
	},
);
