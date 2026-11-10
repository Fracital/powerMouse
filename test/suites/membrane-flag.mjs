// The window membrane's setting reaches every document a proxied page
// makes, and each document knows the site it compares windows by. A
// controller has the membrane on unless the host passes `membrane: false`,
// and the setting travels with the config into the shell of the top page,
// a frame of its own site and one of another site, an about:blank child the
// page writes into and a srcdoc child. Each one's client carries its site
// key: one per scheme, registrable domain and port, the same for the page
// and its same-site, srcdoc and about:blank children, another for the frame
// of the other site. Both modes: the suite builds its own controllers from
// the controller module, a StompController on the proxy origin and a
// RemoteController on the host origin (the setting travels to the
// controller frame).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

const target = `${FIXTURE}pages/membrane-flag.html`;
const NAMES = ['same', 'cross', 'srcdoc', 'blank'];

/** what each document's client says, by frame name ('top' for the page) */
async function readClients(page, clientName) {
	let found = {};
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		found = {};
		const same = page.frames().find((frame) => frame.name() === 'same');
		const top = same?.parentFrame();
		const frames = [
			['top', top],
			...NAMES.map((name) => [
				name,
				page.frames().find((frame) => frame.name() === name),
			]),
		];
		for (const [name, frame] of frames) {
			const value = await frame
				?.evaluate((clientName) => {
					const client = window[clientName];
					if (!client) return null;
					return {
						membrane: client.membrane,
						siteKey: client.siteKey,
						title: document.title,
					};
				}, clientName)
				.catch(() => null);
			if (value) found[name] = value;
		}
		const loaded = ['same', 'cross'].every(
			(name) => found[name]?.title === 'MEMBRANE FLAG CHILD',
		);
		if (loaded && ['top', ...NAMES].every((name) => found[name])) break;
	}
	return found;
}

const browser = await launch();
const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const membrane of [undefined, false]) {
		const label = `${mode}, ${membrane === false ? 'membrane: false' : 'default'}`;
		await waitForServer(base);
		const page = await browser.newPage();
		page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
		await page.goto(`${base}stomp/controllerFrame.html`);
		const { clientName, error } = await page.evaluate(
			async ({ target, isolated, proxyOrigin, membrane }) => {
				let step = 'import';
				try {
					const { StompController, RemoteController } =
						await import('/stomp/controller.mjs');
					const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
					const transport = {
						module: `${proxyOrigin}/epoxy/index.mjs`,
						options: [{ wisp }],
					};
					step = 'register';
					const init = isolated
						? { proxyOrigin, directory: '/stomp/', transport, codec: 'xor' }
						: {
								serviceworker: await StompController.register('/stomp/'),
								transport,
								directory: '/stomp/',
								codec: 'xor',
							};
					if (membrane !== undefined) init.membrane = membrane;
					const Controller = isolated ? RemoteController : StompController;
					step = 'construct';
					const controller = new Controller(init);
					step = 'wait';
					await controller.wait();
					step = 'frame';
					const frame = controller.createFrame();
					document.body.append(frame.element);
					step = 'go';
					await frame.go(target);
					return { clientName: controller.config.names.client };
				} catch (error) {
					return { error: `${step}: ${error.stack}` };
				}
			},
			{
				target,
				isolated: mode === 'isolated',
				proxyOrigin: new URL(PROXY).origin,
				membrane,
			},
		);
		if (error) console.log(`${label} setup error`, error);
		const found = await readClients(page, clientName);
		const detail = JSON.stringify(found);
		const expected = membrane !== false;
		ok(
			`${label}: the page and each of its children has a client`,
			['top', ...NAMES].every((name) => found[name]),
			detail,
		);
		ok(
			`${label}: every document's client has the membrane ${expected ? 'on' : 'off'}`,
			['top', ...NAMES].every((name) => found[name]?.membrane === expected),
			detail,
		);
		const key = found.top?.siteKey;
		ok(
			`${label}: the page, its same-site, srcdoc and about:blank children share one site key`,
			typeof key === 'string' &&
				key.length > 0 &&
				['same', 'srcdoc', 'blank'].every(
					(name) => found[name]?.siteKey === key,
				),
			detail,
		);
		ok(
			`${label}: the frame of another site has a site key of its own`,
			typeof found.cross?.siteKey === 'string' && found.cross.siteKey !== key,
			detail,
		);
		await page.close();
	}
}
await done(browser, errors);
