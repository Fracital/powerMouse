// ui-router-navigation-location-plugin 1.2.1 (dist/index.js), MIT License,
// Copyright (c) 2026-present Lit UI-Router Team,
// https://github.com/simshanith/lit-ui-router/tree/main/packages/navigation-location-plugin
// Vendored for test/suites/nav-router.mjs: its import of @uirouter/core reads
// the UMD bundle's global (vendor-ui-router-core.min.js), and
// compose-navigate-url.js is inlined; nothing else is changed.
const { BaseLocationServices, BrowserLocationConfig, root, splitHash, splitQuery, stripLastPathElement, UIRouter } = globalThis["@uirouter/core"];
function composeNavigateUrl(url, baseHref) {
	if (url === "" || url === "/") {
		return baseHref;
	}
	const slash = url.startsWith("/") ? "" : "/";
	return (stripLastPathElement(baseHref) + slash + url).replace(/^(?:[\t\n\r]*[/\\]){2,}[\t\n\r]*/, "/");
}
const CURRENT_ENTRY_CHANGE_EVENT = "currententrychange";
const NAVIGATE_EVENT = "navigate";
const globalRoot = root;
export function isUIRouterNavigateEvent(event) {
	const info = event?.info;
	return (typeof info === "object" || typeof info === "function") && info !== null && "uiRouter" in info && info.uiRouter instanceof UIRouter;
}
export class NavigationLocationService extends BaseLocationServices {
	constructor(router, options = {}) {
		if (!router) {
			throw new Error("NavigationLocationService requires a UIRouter instance");
		}
		super(router, false);
		this._onCurrentEntryChange = (event) => {
			if (event.navigationType === "traverse" && event.from === this._navigation().currentEntry) {
				return;
			}
			this._listener(event);
		};
		this._intercept = (event) => {
			if (!event.canIntercept) {
				return;
			}
			if (!isUIRouterNavigateEvent(event)) {
				this._interceptTraverse(event);
				return;
			}
			if (event.info.uiRouter !== this._router) {
				return;
			}
			event.intercept({
				focusReset: "manual",
				...this._options.intercept?.(event) ?? { handler: () => Promise.resolve() }
			});
		};
		this._router = router;
		this._options = options;
		this._config = router.urlService.config;
		this._navigation().addEventListener(CURRENT_ENTRY_CHANGE_EVENT, this._onCurrentEntryChange, false);
		this._navigation().addEventListener(NAVIGATE_EVENT, this._intercept);
	}
	_interceptTraverse(event) {
		const option = this._options.interceptTraverse;
		if (!option || event.navigationType !== "traverse") {
			return;
		}
		let transition;
		const stopWatching = this._router.transitionService.onCreate({}, (created) => {
			if (!transition || created.originalTransition() === transition.originalTransition()) {
				transition = created;
			}
		});
		const aborted = new Promise((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
		void aborted.then(stopWatching);
		const { handler, ...options } = option === true ? {} : option(event);
		const settle = async () => {
			for (let awaited = transition; awaited && !event.signal.aborted;) {
				await Promise.race([awaited.promise.catch(() => undefined), aborted]);
				awaited = awaited === transition ? undefined : transition;
			}
			stopWatching();
			if (!event.signal.aborted) {
				await handler?.(transition);
				void globalRoot.document.documentElement.scrollHeight;
			}
		};
		let settled;
		event.intercept({
			focusReset: "manual",
			...options,
			handler: () => settled ??= settle()
		});
	}
	_navigation() {
		return globalRoot.navigation;
	}
	_getBasePrefix() {
		return stripLastPathElement(this._config.baseHref());
	}
	_get() {
		let { pathname, hash, search } = this._location;
		search = splitQuery(search)[1];
		hash = splitHash(hash)[1];
		const basePrefix = this._getBasePrefix();
		const exactBaseHrefMatch = pathname === this._config.baseHref();
		const startsWithBase = pathname.startsWith(basePrefix);
		pathname = exactBaseHrefMatch ? "/" : startsWithBase ? pathname.substring(basePrefix.length) : pathname;
		return pathname + (search ? "?" + search : "") + (hash ? "#" + hash : "");
	}
	_set(state, title, url, replace) {
		const fullUrl = composeNavigateUrl(url, this._config.baseHref());
		this._navigation().navigate(fullUrl, {
			state,
			info: {
				uiRouter: this._router,
				title
			},
			history: replace ? "replace" : "push"
		});
	}
	dispose(router) {
		super.dispose(router);
		this._navigation().removeEventListener(CURRENT_ENTRY_CHANGE_EVENT, this._onCurrentEntryChange);
		this._navigation().removeEventListener(NAVIGATE_EVENT, this._intercept);
	}
}
export function navigationLocationPlugin(router, options = {}) {
	const service = router.locationService = new NavigationLocationService(router, options);
	const configuration = router.locationConfig = new BrowserLocationConfig(router, true);
	return {
		name: "vanilla.navigationLocation",
		service,
		configuration,
		dispose(r) {
			r.dispose(service);
			r.dispose(configuration);
		}
	};
}
