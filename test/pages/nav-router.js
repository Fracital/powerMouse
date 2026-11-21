// A single-page app on a real router that drives the Navigation API: UI-Router
// (vendor-ui-router-core.min.js) with its Navigation API location service
// (vendor-ui-router-navigation.js), which navigates with
// navigation.navigate() and intercepts its own navigations and every
// traversal. test/suites/nav-router.mjs reads the steps it logs
// ("NAVROUTER [step, facts]") natively and proxied.
import { navigationLocationPlugin } from './vendor-ui-router-navigation.js';

const { UIRouter, servicesPlugin } = globalThis['@uirouter/core'];
const view = document.getElementById('view');
const log = (step, facts) =>
	console.log(`NAVROUTER ${JSON.stringify([step, facts])}`);
const path = (url) => {
	const parsed = new URL(url);
	return parsed.pathname + parsed.search + parsed.hash;
};

// what the page heard of each step
let heard = [];
navigation.addEventListener('navigate', (event) =>
	heard.push([
		'navigate',
		event.navigationType,
		event.canIntercept,
		event.hashChange,
		event.userInitiated,
		event.cancelable,
		path(event.destination.url),
		event.destination.sameDocument,
		event.isTrusted,
	]),
);
navigation.addEventListener('navigatesuccess', () =>
	heard.push(['navigatesuccess']),
);
navigation.addEventListener('navigateerror', (event) =>
	heard.push(['navigateerror', event.message]),
);
navigation.addEventListener('currententrychange', (event) =>
	heard.push(['currententrychange', event.navigationType]),
);
addEventListener('popstate', () => heard.push(['popstate']));
addEventListener('hashchange', () => heard.push(['hashchange']));

const router = new UIRouter();
router.plugin(servicesPlugin);
router.plugin(navigationLocationPlugin, {
	intercept: () => ({
		async handler() {
			await new Promise((resolve) => setTimeout(resolve, 10));
		},
	}),
	interceptTraverse: true,
});
const states = [
	{ name: 'home', url: '/nav-router.html' },
	{ name: 'list', url: '/nav-router/list?page' },
	{ name: 'item', url: '/nav-router/item/:id' },
	{
		name: 'old',
		url: '/nav-router/old/:id',
		redirectTo: (transition) => ({
			state: 'item',
			params: { id: transition.params().id },
		}),
	},
	{
		name: 'slow',
		url: '/nav-router/slow',
		resolve: [
			{
				token: 'data',
				resolveFn: () =>
					new Promise((resolve) => setTimeout(() => resolve('slow'), 50)),
			},
		],
	},
];
for (const state of states) router.stateRegistry.register(state);
router.urlService.rules.otherwise({ state: 'home' });
router.transitionService.onSuccess({}, (transition) => {
	const params = { ...transition.params() };
	delete params['#'];
	view.textContent = `${transition.to().name} ${JSON.stringify(params)}`;
});

const settle = async () => {
	for (let i = 0; i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (navigation.transition) {
			await navigation.transition.finished.catch(() => {});
			continue;
		}
		const transition = router.globals.transition;
		if (transition) {
			await transition.promise.catch(() => {});
			continue;
		}
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 30));
};

const facts = () => {
	const params = { ...router.globals.params };
	delete params['#'];
	const facts = {
		path: path(location.href),
		state: router.globals.current.name,
		params,
		view: view.textContent,
		entries: navigation.entries().map((entry) => path(entry.url)),
		index: navigation.currentEntry.index,
		entryState: navigation.currentEntry.getState() ?? null,
		canGoBack: navigation.canGoBack,
		canGoForward: navigation.canGoForward,
		scrollY: Math.round(scrollY),
		heard,
	};
	heard = [];
	return facts;
};

const steps = [
	['list', () => router.stateService.go('list', { page: 2 })],
	['item', () => router.stateService.go('item', { id: 1 })],
	['scrolled', () => scrollTo(0, 600)],
	['redirected', () => router.stateService.go('old', { id: 7 })],
	[
		'replaced',
		() => router.stateService.go('item', { id: 8 }, { location: 'replace' }),
	],
	['slow', () => router.stateService.go('slow')],
	['navigation.back', () => navigation.back()],
	['history.back', () => history.back()],
	['navigation.forward', () => navigation.forward()],
	['traverseTo', () => navigation.traverseTo(navigation.entries()[0].key)],
	['url', () => router.urlService.url('/nav-router/item/9')],
	// (of this document's URL: the page's <base href> would resolve a bare
	// '#notes' to another document)
	[
		'fragment',
		() => navigation.navigate(new URL('#notes', location.href).href),
	],
	['back from fragment', () => history.back()],
];

const run = async () => {
	router.urlService.listen();
	router.urlService.sync();
	await settle();
	log('boot', facts());
	for (const [step, act] of steps) {
		try {
			const result = act();
			result?.finished?.catch(() => {});
			result?.committed?.catch(() => {});
			if (result?.catch) result.catch(() => {});
		} catch (error) {
			log(step, { threw: String(error) });
			continue;
		}
		await settle();
		log(step, facts());
	}
	log('end', {});
};
run();
