// The Trusted Types probes of a /csp/doc?js=tt page (test/csp-server.mjs):
// each writes one kind of value into one sink, or makes a policy, and says
// what happened as the page sees it (what it threw, what landed, which
// calls the default policy got). A probe named `default-<how>` makes a
// default policy whose callbacks pass the value through (`pass`), tag it
// (MARK becomes POLICY), return null or throw; the probes after it see it.
// `window.__csp` holds the outcomes and the securitypolicyviolation events
// the document saw, once every probe the query names is done (`name~2`
// runs a probe again).
(() => {
	const query = new URLSearchParams(location.search);
	const names = (query.get('probes') ?? '').split(',').filter(Boolean);
	const events = [];
	const listen = (target, where) =>
		target.addEventListener('securitypolicyviolation', (event) => {
			events.push({
				blockedURI: event.blockedURI,
				violatedDirective: event.violatedDirective,
				effectiveDirective: event.effectiveDirective,
				originalPolicy: event.originalPolicy,
				disposition: event.disposition,
				documentURI: event.documentURI,
				statusCode: event.statusCode,
				sample: event.sample,
				target: where,
				isTrusted: event.isTrusted,
			});
		});
	listen(document, 'document');
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const error = (e) => `${e?.name}: ${e?.message}`;
	const calls = [];
	/** what `run` did: what it returned or threw, and the default policy's calls */
	const outcome = (run) => {
		const from = calls.length;
		let result;
		try {
			result = `ok ${run()}`;
		} catch (e) {
			result = `threw ${error(e)}`;
		}
		const made = calls.slice(from);
		return made.length ? `${result} | calls ${JSON.stringify(made)}` : result;
	};
	const callback = (kind, how) =>
		function (...args) {
			calls.push([kind, args.length, ...args.map(String)]);
			if (how === 'null') return null;
			if (how === 'throw') throw new RangeError('policy threw');
			if (how === 'tag') return String(args[0]).replace('MARK', 'POLICY');
			return args[0];
		};
	const policy = (name, how) =>
		trustedTypes.createPolicy(name, {
			createHTML: callback('html', how),
			createScript: callback('script', how),
			createScriptURL: callback('url', how),
		});
	let own = null;
	/** a policy of the page's own, passing values through */
	const same = (value) => value;
	const mine = () =>
		(own ??= trustedTypes.createPolicy('mine', {
			createHTML: same,
			createScript: same,
			createScriptURL: same,
		}));
	const div = () => document.createElement('div');
	const ran = (key) => (window.__tt ?? {})[key];
	window.__tt = {};
	const code = (key) => `window.__tt[${JSON.stringify(key)}]=1//MARK`;
	/** a script made with `set`, inserted: whether it ran */
	const script = (key, set) =>
		outcome(() => {
			const node = document.createElement('script');
			try {
				set(node);
			} finally {
				document.body.append(node);
			}
			return `ran ${ran(key)}`;
		});
	/** a script loaded from a URL set with `set` */
	const scriptURL = (set) =>
		new Promise((resolve) => {
			window.__ran = undefined;
			const node = document.createElement('script');
			let result;
			node.onload = () => resolve(`${result} load ran ${window.__ran}`);
			node.onerror = () => resolve(`${result} error`);
			result = outcome(() => {
				set(node);
				document.body.append(node);
				return 'set';
			});
			if (result.startsWith('threw')) resolve(result);
			setTimeout(() => resolve(`${result} timeout`), 3000);
		});
	const later = async (run, ms = 300) => {
		const result = outcome(run);
		await wait(ms);
		return result;
	};

	const PROBES = {
		'default-pass': () => outcome(() => policy('default', 'pass').name),
		'default-tag': () => outcome(() => policy('default', 'tag').name),
		'default-null': () => outcome(() => policy('default', 'null').name),
		'default-throw': () => outcome(() => policy('default', 'throw').name),
		'default-html-only': () =>
			outcome(
				() =>
					trustedTypes.createPolicy('default', {
						createHTML: callback('html', 'pass'),
					}).name,
			),
		// HTML sinks
		innerHTML: () =>
			outcome(() => {
				const node = div();
				node.innerHTML = '<b>MARK</b>';
				return node.innerHTML;
			}),
		'innerHTML-null': () =>
			outcome(() => {
				const node = div();
				node.innerHTML = null;
				return JSON.stringify(node.innerHTML);
			}),
		'innerHTML-object': () =>
			outcome(() => {
				const node = div();
				node.innerHTML = { toString: () => '<i>MARK</i>' };
				return node.innerHTML;
			}),
		outerHTML: () =>
			outcome(() => {
				const node = div();
				const child = document.createElement('span');
				node.append(child);
				child.outerHTML = '<b>MARK</b>';
				return node.innerHTML;
			}),
		insertAdjacentHTML: () =>
			outcome(() => {
				const node = div();
				node.insertAdjacentHTML('beforeend', '<b>MARK</b>');
				return node.innerHTML;
			}),
		setHTMLUnsafe: () =>
			outcome(() => {
				const node = div();
				node.setHTMLUnsafe('<b>MARK</b>');
				return node.innerHTML;
			}),
		parseHTMLUnsafe: () =>
			outcome(() => Document.parseHTMLUnsafe('<p>MARK</p>').body.innerHTML),
		parseFromString: () =>
			outcome(
				() =>
					new DOMParser().parseFromString('<p>MARK</p>', 'text/html').body
						.innerHTML,
			),
		createContextualFragment: () =>
			outcome(() => {
				const range = document.createRange();
				range.selectNode(document.body);
				const fragment = range.createContextualFragment('<b>MARK</b>');
				return fragment.firstChild?.outerHTML;
			}),
		write: () =>
			outcome(() => {
				// a document of no frame: nothing of this page is replaced
				const written = document.implementation.createHTMLDocument('w');
				written.write('<b>MARK</b>');
				return written.body.innerHTML;
			}),
		srcdoc: () =>
			outcome(() => {
				const node = document.createElement('iframe');
				node.srcdoc = '<b>MARK</b>';
				return node.srcdoc;
			}),
		'srcdoc-attribute': () =>
			outcome(() => {
				const node = document.createElement('iframe');
				node.setAttribute('srcdoc', '<b>MARK</b>');
				return node.getAttribute('srcdoc');
			}),
		// script sinks
		'script-text': () => script('text', (node) => (node.text = code('text'))),
		'script-textContent': () =>
			script('textContent', (node) => (node.textContent = code('textContent'))),
		'script-innerText': () =>
			script('innerText', (node) => (node.innerText = code('innerText'))),
		'script-innerHTML': () =>
			script('innerHTML', (node) => (node.innerHTML = code('innerHTML'))),
		'script-text-node': () =>
			script('node', (node) =>
				node.append(document.createTextNode(code('node'))),
			),
		'script-src': () => scriptURL((node) => (node.src = '/csp/run.js?MARK')),
		'script-src-attribute': () =>
			scriptURL((node) => node.setAttribute('src', '/csp/run.js?MARK')),
		handler: () =>
			outcome(() => {
				const node = div();
				node.setAttribute('onclick', code('handler'));
				node.click();
				return `${node.getAttribute('onclick')} ran ${ran('handler')}`;
			}),
		'handler-property': () =>
			outcome(() => {
				const node = div();
				node.onclick = code('property');
				return String(node.onclick);
			}),
		// code
		eval: () => outcome(() => eval('1 + 1 //MARK')),
		'eval-indirect': () => outcome(() => (0, eval)('2 + 2 //MARK')),
		'eval-object': () => outcome(() => typeof eval({ code: 1 })),
		function: () => outcome(() => new Function('a', 'return a + 1 //MARK')(2)),
		timeout: () =>
			later(() => typeof setTimeout(code('timeout'), 0)).then(
				(result) => `${result} ran ${ran('timeout')}`,
			),
		'timeout-function': () => outcome(() => typeof setTimeout(() => {}, 0)),
		worker: () =>
			outcome(() => {
				const started = new Worker('/csp/worker.js?MARK');
				started.terminate();
				return 'made';
			}),
		'javascript-url': () =>
			later(() => {
				location.href = `javascript:${code('javascript')}`;
				return 'set';
			}).then((result) => `${result} ran ${ran('javascript')}`),
		// the page's own trusted values
		'trusted-html': () =>
			outcome(() => {
				const node = div();
				node.innerHTML = mine().createHTML('<b>MARK</b>');
				return node.innerHTML;
			}),
		'trusted-script': () =>
			script(
				'trusted',
				(node) => (node.text = mine().createScript(code('trusted'))),
			),
		'trusted-url': () =>
			scriptURL(
				(node) => (node.src = mine().createScriptURL('/csp/run.js?MARK')),
			),
		'trusted-handler': () =>
			outcome(() => {
				const node = div();
				node.setAttribute('onclick', mine().createScript(code('th')));
				node.click();
				return `ran ${ran('th')}`;
			}),
		'trusted-eval': () => outcome(() => eval(mine().createScript('3 + 3'))),
		'trusted-wrong-type': () =>
			outcome(() => {
				const node = div();
				node.innerHTML = mine().createScript('<b>MARK</b>');
				return node.innerHTML;
			}),
		// a worker of the page's trusted blob: URL (it inherits the policy)
		'trusted-worker': () =>
			new Promise((resolve) => {
				let started;
				const url = URL.createObjectURL(
					new Blob(['postMessage(typeof eval)'], { type: 'text/javascript' }),
				);
				const result = outcome(() => {
					started = new Worker(mine().createScriptURL(url));
					return 'made';
				});
				if (!started) return resolve(result);
				started.onmessage = (event) => resolve(`${result} ${event.data}`);
				started.onerror = () => resolve(`${result} error`);
				setTimeout(() => resolve(`${result} timeout`), 3000);
			}),
		// the scripts of a trusted fragment run as they are inserted
		'trusted-fragment-script': () =>
			outcome(() => {
				const range = document.createRange();
				range.selectNode(document.body);
				document.body.append(
					range.createContextualFragment(
						mine().createHTML(`<script>${code('fragment')}<\/script>`),
					),
				);
				return `ran ${ran('fragment')}`;
			}),
		// text that lands in a connected script runs it, judged as it runs
		'script-connected-text': () =>
			outcome(() => {
				const node = document.createElement('script');
				document.body.append(node);
				node.append(document.createTextNode(code('connected')));
				return `ran ${ran('connected')}`;
			}),
		'trusted-empty': () =>
			outcome(() => {
				const node = div();
				node.innerHTML = trustedTypes.emptyHTML;
				return JSON.stringify(node.innerHTML);
			}),
		// policies
		'policy-foo': () => outcome(() => policy('foo', 'pass').name),
		'policy-bar': () => outcome(() => policy('bar', 'pass').name),
		'policy-baz': () => outcome(() => policy('baz', 'pass').name),
		'policy-default': () => outcome(() => policy('default', 'pass').name),
		'policy-empty-name': () => outcome(() => policy('', 'pass').name),
		readback: () =>
			outcome(() =>
				JSON.stringify([
					trustedTypes.defaultPolicy?.name ?? null,
					Object.getOwnPropertyNames(Object.getPrototypeOf(trustedTypes)),
					trustedTypes.getAttributeType('script', 'src'),
					trustedTypes.getPropertyType('div', 'innerHTML'),
					trustedTypes.isHTML(trustedTypes.emptyHTML),
					String(trustedTypes.emptyScript),
				]),
			),
		// a frame of the page's document inherits its policy, with a factory
		// (and no default policy) of its own
		'frame-innerHTML': () =>
			outcome(() => {
				const node = document.createElement('iframe');
				document.body.append(node);
				const child = node.contentWindow;
				listen(node.contentDocument, 'child');
				const inner = child.document.createElement('div');
				inner.innerHTML = '<b>MARK</b>';
				return `${inner.innerHTML} ${child.trustedTypes === trustedTypes}`;
			}),
	};

	(async () => {
		const results = {};
		for (const name of names) {
			try {
				// (`name~2`: the probe again)
				const probe = PROBES[name.split('~')[0]];
				results[name] = probe ? await probe() : 'no such probe';
			} catch (e) {
				results[name] = `probe threw ${error(e)}`;
			}
		}
		// the violation events of the last probes are queued as tasks
		await wait(500);
		window.__csp = { done: true, case: query.get('case'), results, events };
	})();
})();
