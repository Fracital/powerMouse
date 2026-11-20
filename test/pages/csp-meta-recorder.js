// The recorder of a /csp/doc page laid out by `l` (test/csp-server.mjs
// layout): the first script of the head, before any meta. It counts the
// layout's scripts that ran (`__ran(name)`), whether each of its styles is
// there and applies, the load and error events of
// each script element (`data-n`), the document's securitypolicyviolation
// events and the csp-violation reports a ReportingObserver is handed, and
// puts them on `window.__csp` a moment after load (test/csp-lib.mjs).
(() => {
	const query = new URLSearchParams(location.search);
	const names = (query.get('probes') ?? '').split(',').filter(Boolean);
	const ran = {};
	const fired = {};
	window.__ran = (name) => {
		ran[name] = (ran[name] ?? 0) + 1;
	};
	const events = [];
	document.addEventListener('securitypolicyviolation', (event) => {
		const target = event.target;
		events.push({
			blockedURI: event.blockedURI,
			violatedDirective: event.violatedDirective,
			effectiveDirective: event.effectiveDirective,
			originalPolicy: event.originalPolicy,
			disposition: event.disposition,
			documentURI: event.documentURI,
			statusCode: event.statusCode,
			sample: event.sample,
			target:
				target === document
					? 'document'
					: target instanceof Element
						? `${target.localName} ${target.dataset.n ?? ''}`
						: String(target),
		});
	});
	for (const type of ['load', 'error'])
		document.addEventListener(
			type,
			(event) => {
				const name = event.target?.dataset?.n;
				if (name) (fired[name] ??= []).push(type);
			},
			true,
		);
	const reports = [];
	try {
		new ReportingObserver(
			(list) => {
				for (const { type, body } of list)
					reports.push(
						JSON.stringify({
							type,
							blockedURL: body.blockedURL,
							effectiveDirective: body.effectiveDirective,
							originalPolicy: body.originalPolicy,
							disposition: body.disposition,
							documentURL: body.documentURL,
							statusCode: body.statusCode,
							sample: body.sample,
						}),
					);
			},
			{ types: ['csp-violation'], buffered: true },
		).observe();
	} catch (error) {
		reports.push(`threw ${error.name}`);
	}
	addEventListener('load', () =>
		setTimeout(() => {
			const results = {};
			for (const name of names)
				results[name] =
					name === 'reports'
						? JSON.stringify(reports.sort())
						: // a layout's style (`sty`): there, and what it applies
							document.getElementById(name)?.localName === 'style'
							? `style --${name}=${getComputedStyle(document.documentElement).getPropertyValue(`--${name}`)}`
							: `${ran[name] ? `ran ${ran[name]}` : 'not run'}${fired[name] ? ` ${fired[name].join(' ')}` : ''}`;
			window.__csp = {
				done: true,
				case: query.get('case'),
				results,
				events,
			};
		}, 600),
	);
})();
