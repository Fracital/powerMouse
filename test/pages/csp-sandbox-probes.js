// The probes of a /csp/sbx page (test/csp-server.mjs, csp-sandbox suite):
// what a document under a policy's `sandbox` directive may do, as it sees
// it. Every outcome is sent to the fixture (`/csp/sbx-put`), not kept in
// the page: a document without allow-scripts runs no probe at all (its
// markup's loads say what ran), a popup has no one to post to, and a
// frame whose top navigates is gone. `role` names the document's report,
// `probes` the groups it runs.
(() => {
	const query = new URLSearchParams(location.search);
	const key = query.get('k') ?? 'x';
	const role = query.get('role') ?? 'top';
	const groups = (query.get('probes') ?? '').split(',').filter(Boolean);
	const kept = [];
	const put = (name, value) => {
		const image = new Image();
		kept.push(image);
		image.src = `/csp/sbx-put?${new URLSearchParams({ k: key, n: name, v: String(value) })}`;
	};
	const error = (e) => `threw ${e?.name}: ${e?.message}`;
	// each outcome is sent at once: a document that navigates away (a
	// form, its top) sends nothing later
	const record = (name, value) => put(`${role}: ${name}`, value);
	const t = (name, run) => {
		try {
			record(name, String(run()));
		} catch (e) {
			record(name, error(e));
		}
	};
	const settle = (ms, value = 'timeout') =>
		new Promise((resolve) => setTimeout(() => resolve(value), ms));
	const ta = async (name, run) => {
		try {
			record(name, String(await Promise.race([run(), settle(4000)])));
		} catch (e) {
			record(name, `rejected ${e?.name}: ${e?.message}`);
		}
	};
	/** a URL of this route for another role of the same case */
	const sibling = (params) => {
		const next = new URLSearchParams(location.search);
		for (const name of [
			'p',
			'ro',
			'm',
			'frame',
			'fs',
			'b',
			...Object.keys(params),
		])
			next.delete(name);
		for (const [name, value] of Object.entries(params))
			for (const item of [].concat(value)) next.append(name, item);
		return `/csp/sbx?${next}`;
	};
	const landing = (name) =>
		`/csp/sbx-put?${new URLSearchParams({ k: key, n: name, v: 'navigated' })}`;

	const env = async () => {
		t('self.origin', () => self.origin);
		t('location.origin', () => location.origin);
		t('document.domain', () => document.domain);
		t('document.domain=', () => {
			document.domain = document.domain;
			return 'set';
		});
		t('cookie read', () => typeof document.cookie);
		t('cookie write', () => {
			document.cookie = 'sbx=1; path=/';
			return document.cookie.includes('sbx=1');
		});
		t('localStorage', () => typeof localStorage.length);
		t('sessionStorage', () => typeof sessionStorage.length);
		await ta(
			'indexedDB.open',
			() =>
				new Promise((resolve) => {
					const request = indexedDB.open('sbx');
					request.onsuccess = () => {
						request.result.close();
						resolve('success');
					};
					request.onerror = () => resolve(`error ${request.error?.name}`);
				}),
		);
		await ta('indexedDB.databases', () =>
			indexedDB.databases().then((list) => typeof list),
		);
		t('indexedDB.deleteDatabase', () => typeof indexedDB.deleteDatabase('sbx'));
		await ta('caches.keys', () => caches.keys().then((list) => typeof list));
		await ta('fetch self', () =>
			fetch('/csp/ok').then(
				(response) => `${response.status} ${response.type}`,
			),
		);
		t('isSecureContext', () => isSecureContext);
		t('document.referrer', () => document.referrer);
		t('window.name', () => window.name);
		t('frameElement', () => String(window.frameElement));
		t('top === self', () => top === self);
	};

	const GROUPS = {
		env,
		modals: () => {
			t('alert', () => alert('sbx'));
			t('confirm', () => confirm('sbx'));
			t('prompt', () => prompt('sbx'));
		},
		print: () => {
			t('print', () => print());
		},
		// a form's submission: it lands on the fixture when it goes
		form: async () => {
			const form = document.createElement('form');
			form.action = '/csp/sbx-put';
			for (const [name, value] of [
				['k', key],
				['n', `${role} form`],
				['v', 'submitted'],
			]) {
				const input = document.createElement('input');
				input.type = 'hidden';
				input.name = name;
				input.value = value;
				form.append(input);
			}
			document.body.append(form);
			t('form.submit()', () => form.submit());
			t('form.requestSubmit()', () => form.requestSubmit());
			await settle(1500);
			t('still here', () => 'yes');
		},
		// a popup of a click (the suite clicks #b)
		popup: async () => {
			const button = document.createElement('button');
			button.id = 'b';
			button.textContent = 'open';
			document.body.append(button);
			await new Promise((resolve) => {
				button.onclick = async () => {
					let opened = null;
					t('window.open', () => {
						opened = window.open(
							sibling({ role: 'popup', probes: 'env' }),
							'sbxpopup',
						);
						return opened === null ? 'null' : 'Window';
					});
					await settle(2500);
					t('popup.origin', () => opened?.origin);
					t('popup.location.href', () =>
						String(opened?.location.href).replace(/\?.*/, '?'),
					);
					resolve();
				};
			});
		},
		// a frame's navigation of its top, by script
		'top-href': () => {
			t('top.location.href=', () => {
				top.location.href = landing('top-href');
				return 'returned';
			});
		},
		'top-replace': () => {
			t('top.location.replace', () => {
				top.location.replace(landing('top-replace'));
				return 'returned';
			});
		},
		'top-open': () => {
			t('window.open _top', () => {
				const opened = window.open(landing('top-open'), '_top');
				return opened === null ? 'null' : typeof opened;
			});
		},
		// what a document reads of its frames: an http one (which reports
		// itself as `child`), a srcdoc and an about:blank it makes
		frames: async () => {
			const http = document.createElement('iframe');
			http.src = sibling({ role: 'child', probes: 'env' });
			const srcdoc = document.createElement('iframe');
			srcdoc.srcdoc = '<p>srcdoc</p>';
			document.body.append(http, srcdoc);
			await settle(2000);
			const blank = document.createElement('iframe');
			document.body.append(blank);
			for (const [name, frame] of [
				['about:blank', blank],
				['srcdoc', srcdoc],
				['http', http],
			]) {
				t(`${name} contentDocument`, () => frame.contentDocument === null);
				t(`${name} origin`, () => frame.contentWindow.origin);
			}
		},
	};

	(async () => {
		for (const group of groups)
			try {
				await GROUPS[group]?.();
			} catch (e) {
				record(`group ${group}`, error(e));
			}
		put(`${role} done`, 'yes');
	})();
})();
