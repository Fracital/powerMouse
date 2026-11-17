// Popups and their openers (popup-openers suite): what window.open returns,
// the popup's opener, messages both ways with their origin and source,
// closed and close(), links with and without rel=noopener, and what a page
// that sends COOP same-origin does to them. One script for every role: the
// top-level page (popup-openers.html, popup-openers-coop.html with COOP
// same-origin), its frame of another site (popup-openers-frame.html), a
// sandboxed frame of another site (popup-openers-sandboxed.html), one
// sandboxed without allow-scripts (popup-openers-noscript.html) and the
// popups (popup-openers-popup.html, popup-openers-popup-coop.html).
(() => {
	const role = document.documentElement.dataset.role;
	const params = new URLSearchParams(location.search);
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const other = (path) => {
		const url = new URL(path, location.href);
		url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
		return url.href;
	};
	const same = (path) => new URL(path, location.href).href;

	if (role === 'popup') {
		const name = params.get('case');
		const info = (window.__popupInfo = {
			case: name,
			opener: window.opener !== null,
			// messages that are none of the page's
			foreign: 0,
		});
		addEventListener('message', (event) => {
			if (event.data?.pong !== name) {
				info.foreign++;
				return;
			}
			info.pong = {
				origin: event.origin === params.get('from'),
				source: event.source === window.opener,
			};
			event.source.postMessage({ ponged: name, ...info.pong }, event.origin);
		});
		if (window.opener)
			window.opener.postMessage({ hello: name }, params.get('from') || '*');
		return;
	}

	// a popup's page, told which case it is and who opens it
	const popupURL = (page, name, cross = true) => {
		const url = new URL(cross ? other(page) : same(page));
		url.searchParams.set('case', name);
		url.searchParams.set('from', location.origin);
		return url.href;
	};
	const message = (test, ms) =>
		new Promise((resolve) => {
			const listener = (event) => {
				if (!test(event.data)) return;
				removeEventListener('message', listener);
				clearTimeout(timer);
				resolve(event);
			};
			const timer = setTimeout(() => {
				removeEventListener('message', listener);
				resolve(null);
			}, ms);
			addEventListener('message', listener);
		});

	/**
	 * One popup: `open` opens it (a window, or null for a link), `origin`
	 * is the origin its page is of. The popup says hello to its opener when
	 * it has one and answers a message; then it is closed.
	 */
	async function popupCase(name, open, origin, severs = false) {
		const result = {};
		const hello = message((data) => data?.hello === name, severs ? 2500 : 8000);
		let popup = null;
		try {
			popup = open();
		} catch (error) {
			result.threw = error.name;
		}
		result.window = popup !== null && popup !== undefined;
		if (popup)
			try {
				result.openerIsThis = popup.opener === window;
			} catch (error) {
				result.openerIsThis = error.name;
			}
		const said = await hello;
		result.hello = said && {
			origin: said.origin === origin,
			source: popup ? said.source === popup : said.source !== null,
		};
		if (said) {
			const ponged = message((data) => data?.ponged === name, 8000);
			said.source.postMessage({ pong: name }, origin);
			const answer = await ponged;
			result.pong = answer && {
				origin: answer.data.origin && answer.origin === origin,
				source: answer.data.source && (!popup || answer.source === popup),
			};
		}
		if (popup) {
			// a popup taken out of its opener's group reads closed once its
			// document came
			for (let i = 0; i < 40 && severs && !popup.closed; i++) await wait(100);
			result.closed = popup.closed;
			popup.close();
			for (let i = 0; i < 40 && !popup.closed; i++) await wait(50);
			result.closedAfterClose = popup.closed;
		}
		return result;
	}

	const blank = (name) => () => {
		const popup = window.open('', `${name}-${Math.random()}`);
		if (popup)
			popup.document.write(
				`<script>(${(() => {
					// the opener's own origin
					const from = window.opener.origin;
					const info = (window.__popupInfo = {
						case: 'NAME',
						opener: true,
						foreign: 0,
					});
					addEventListener('message', (event) => {
						if (event.data?.pong !== 'NAME') {
							info.foreign++;
							return;
						}
						info.pong = {
							origin: event.origin === from,
							source: event.source === window.opener,
						};
						event.source.postMessage(
							{
								ponged: 'NAME',
								origin: event.origin === from,
								source: event.source === window.opener,
							},
							event.origin,
						);
					});
					window.opener.postMessage({ hello: 'NAME' }, from);
				}).toString()})()<\/script>`.replaceAll('NAME', name),
			);
		return popup;
	};
	const navigated =
		(name, page, cross = true) =>
		() => {
			const popup = window.open('', `${name}-${Math.random()}`);
			if (popup) popup.location = popupURL(page, name, cross);
			return popup;
		};
	const link = (name, rel) => () => {
		const a = document.createElement('a');
		a.href = popupURL('popup-openers-popup.html', name);
		a.target = '_blank';
		if (rel !== null) a.rel = rel;
		document.body.append(a);
		a.click();
		a.remove();
		return null;
	};

	async function run() {
		const top = params.get('top');
		const cross = other('/').replace(/\/$/, '');
		if (role === 'frame' && top === 'coop')
			return {
				'a frame of another origin than a COOP same-origin page opens a blank popup':
					await popupCase(
						'coop-frame-blank',
						blank('coop-frame-blank'),
						location.origin,
					),
				'a frame of another origin than a COOP same-origin page opens a popup and navigates it':
					await popupCase(
						'coop-frame-navigated',
						navigated('coop-frame-navigated', 'popup-openers-popup.html'),
						cross,
					),
			};
		if (role === 'frame')
			return {
				'a frame of another site opens a blank popup and writes it':
					await popupCase('blank', blank('blank'), location.origin),
				'a frame of another site opens a popup and navigates it to a third origin':
					await popupCase(
						'navigated',
						navigated('navigated', 'popup-openers-popup.html'),
						cross,
					),
				'a frame of another site opens a popup to a page that sends COOP same-origin':
					await popupCase(
						'to-coop',
						navigated('to-coop', 'popup-openers-popup-coop.html'),
						cross,
						true,
					),
			};
		if (role === 'sandboxed')
			return {
				'a sandboxed frame of another site: window.open(url)': await popupCase(
					'sandboxed-url',
					() =>
						window.open(
							popupURL('popup-openers-popup.html', 'sandboxed-url'),
							`s-${Math.random()}`,
						),
					cross,
				),
				'a sandboxed frame: a target=_blank link with rel=opener':
					await popupCase('link-opener', link('link-opener', 'opener'), cross),
				'a sandboxed frame: a target=_blank link with rel=noopener':
					await popupCase(
						'link-noopener',
						link('link-noopener', 'noopener'),
						cross,
						true,
					),
				'a sandboxed frame: a target=_blank link without rel': await popupCase(
					'link-plain',
					link('link-plain', null),
					cross,
					true,
				),
			};
		// the top-level page
		const coop = role === 'coop';
		const own = coop
			? {
					'a COOP same-origin page opens a blank popup': await popupCase(
						'coop-top-blank',
						blank('coop-top-blank'),
						location.origin,
					),
					'a COOP same-origin page navigates its popup to another origin':
						await popupCase(
							'coop-top-navigated',
							navigated('coop-top-navigated', 'popup-openers-popup.html'),
							cross,
							true,
						),
					'a COOP same-origin page navigates its popup to a page of its origin with the same policy':
						await popupCase(
							'coop-top-same',
							navigated(
								'coop-top-same',
								'popup-openers-popup-coop.html',
								false,
							),
							location.origin,
						),
				}
			: {};
		const frames = {};
		for (const [file, sandbox] of [
			['popup-openers-frame.html', null],
			...(coop
				? []
				: [
						[
							'popup-openers-sandboxed.html',
							'allow-scripts allow-same-origin allow-popups',
						],
					]),
		]) {
			const frame = document.createElement('iframe');
			if (sandbox) frame.setAttribute('sandbox', sandbox);
			const url = new URL(other(file));
			if (coop) url.searchParams.set('top', 'coop');
			const reported = message((data) => data?.frameDone === file, 60000);
			frame.src = url.href;
			document.body.append(frame);
			const event = await reported;
			Object.assign(frames, event ? event.data.cases : { [file]: 'no report' });
		}
		// the sandbox reaches a frame of another site (with the site pool,
		// another slot, which cannot read its frame element): without
		// allow-scripts its document runs no script
		if (!coop) {
			const frame = document.createElement('iframe');
			frame.setAttribute('sandbox', 'allow-same-origin');
			const ran = message((data) => data?.noscriptRan === true, 30000);
			const loaded = new Promise((resolve) => {
				frame.addEventListener('load', resolve, { once: true });
				setTimeout(resolve, 20000);
			});
			frame.src = other('popup-openers-noscript.html');
			document.body.append(frame);
			await Promise.race([loaded.then(() => wait(1500)), ran]);
			frames[
				'a frame of another site sandboxed without allow-scripts runs no script'
			] = {
				ran: (await Promise.race([ran, wait(0).then(() => null)])) !== null,
			};
		}
		return { ...own, ...frames };
	}

	const started = new Promise((resolve) =>
		document.readyState === 'complete'
			? resolve()
			: addEventListener('load', resolve, { once: true }),
	);
	started
		.then(() => wait(300))
		.then(run)
		.then((cases) => {
			if (role === 'top' || role === 'coop')
				window.__popups = { done: true, cases };
			else
				parent.postMessage(
					{ frameDone: location.pathname.split('/').pop(), cases },
					'*',
				);
		});
})();
