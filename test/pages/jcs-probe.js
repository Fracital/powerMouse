// The just-call-stomp audit's probe (test/suites/just-call-stomp-audit.mjs):
// every page of the audit's walk reports what it can read of its own
// navigation state as a console line `JCS:<json>`, on load, on a
// back/forward cache restore and on every fragment or history step.
(() => {
	const step = document.documentElement.dataset.step;
	const order = [`script:${document.readyState}`];
	const nameAtStart = window.name;
	document.addEventListener('DOMContentLoaded', () =>
		order.push('DOMContentLoaded'),
	);
	addEventListener('load', () => {
		order.push('load');
		setTimeout(report, 0, 'load');
	});
	addEventListener('pageshow', (event) => {
		order.push(`pageshow:${event.persisted}`);
		if (event.persisted) report('pageshow-persisted');
	});
	addEventListener('hashchange', () => report('hashchange'));
	addEventListener('popstate', () => report('popstate'));
	function report(why) {
		const nav = performance.getEntriesByType('navigation')[0];
		let frameElement;
		try {
			frameElement = window.frameElement === null ? 'null' : 'element';
		} catch (error) {
			frameElement = `throws ${error.name}`;
		}
		console.log(
			`JCS:${JSON.stringify({
				step,
				why,
				href: location.href,
				url: document.URL,
				referrer: document.referrer,
				historyLength: history.length,
				state: history.state,
				scrollRestoration: history.scrollRestoration,
				entries: window.navigation
					? navigation.entries().map((entry) => entry.url)
					: null,
				current: window.navigation?.currentEntry?.url ?? null,
				activation: window.navigation?.activation
					? {
							type: navigation.activation.navigationType,
							from: navigation.activation.from?.url ?? null,
						}
					: null,
				navEntry: nav
					? { name: nav.name, type: nav.type, redirectCount: nav.redirectCount }
					: null,
				legacyNavType: performance.navigation?.type ?? null,
				resources: performance.getEntriesByType('resource').length,
				nameAtStart,
				name: window.name,
				isTop: window.top === window,
				frameElement,
				ancestorOrigins: [...(location.ancestorOrigins ?? [])],
				target: document.querySelector(':target')?.id ?? null,
				userActivation: navigator.userActivation
					? [
							navigator.userActivation.hasBeenActive,
							navigator.userActivation.isActive,
						]
					: null,
				focus: document.hasFocus(),
				order: order.join(','),
				coi: globalThis.crossOriginIsolated,
				origin: window.origin,
			})}`,
		);
	}
	window.__jcsReport = report;
	// the walk's secret: what the next document of this window reads
	if (!step.startsWith('child')) window.name = `jcs-secret-${step}`;
})();
