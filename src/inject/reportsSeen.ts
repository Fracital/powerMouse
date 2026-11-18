// How a report a page reads through ReportingObserver names the page's
// URLs (./modules/Unroute.ts applyReports): the report's and its body's
// prototypes hooked from the first reports of their kind, and the reports
// about the inject's own code dropped. A deferred part of the document
// bundle (./dom/deferred.ts), made when the first report reaches the page;
// the worker bundle's own (./reportParts.ts).
import type Client from './Client';
import type ProxyModule from './modules/Proxy';
import { unrouteURL, type ErrorLocation } from './modules/Unroute';
import type { LazyWeakSet } from './ownCollections';

/** the deprecation report's id for a synchronous request on a document's main thread */
const SYNCHRONOUS_REQUEST_REPORT =
	'XMLHttpRequestSynchronousInNonWorkerOutsideBeforeUnload';
// the members of a report and its body that hold a URL
const REPORT_URL_KEYS = [
	'url',
	'sourceFile',
	'documentURL',
	'blockedURL',
	'referrer',
];

/** what Unroute hands the part: its client, the prototypes hooked so far and the call sites it noted */
export interface ReportView {
	client: Client;
	proxyModule: ProxyModule;
	hooked: LazyWeakSet<object>;
	/** where the page first opened a synchronous request */
	synchronousSite: () => ErrorLocation | undefined;
	/** the first call site a hook noted */
	firstSite: () => ErrorLocation | undefined;
}

/**
 * The reports a ReportingObserver hands the page (its callback's list,
 * takeRecords'), without the inject's own, their prototypes hooked
 * before the page reads them
 */
export function reportsSeen(view: ReportView, reports: unknown): unknown {
	const { client, proxyModule } = view;
	const unroute = (value: unknown) =>
		typeof value === 'string' ? (unrouteURL(client, value) ?? value) : value;
	const unrouteJSON = (json: Record<string, unknown>) => {
		const site = Object.hasOwn(json, 'sourceFile')
			? siteFor(json.sourceFile, json.id)
			: undefined;
		if (site) {
			json.sourceFile = site.filename;
			if (Object.hasOwn(json, 'lineNumber')) json.lineNumber = site.lineno;
			if (Object.hasOwn(json, 'columnNumber')) json.columnNumber = site.colno;
		}
		for (const key of REPORT_URL_KEYS)
			if (Object.hasOwn(json, key) && typeof json[key] === 'string')
				json[key] = unroute(json[key]);
		if (typeof json.originalPolicy === 'string')
			json.originalPolicy = pagePolicy(json.originalPolicy);
	};
	// a policy violation names the page's policy as the page wrote it, not
	// the one the browser was given for it (src/csp.ts)
	const pagePolicy = (value: unknown) =>
		typeof value === 'string'
			? ((
					client as { pagePolicyText?: (text: string) => string | null }
				).pagePolicyText?.(value) ?? value)
			: value;
	// A report that names one of the inject's bundles as its source was
	// made inside a hook the page called (a deprecated `unload` listener
	// added through the hooked addEventListener): the browser takes the
	// hook for the caller. It shows the page's call site, which the hook
	// noted (noteReportSite; a deprecation is reported once a document,
	// so the first one noted is the one reported).
	// (a synchronous request's has a place of its own: `id` is the
	// report's)
	const siteFor = (sourceFile: unknown, id?: unknown) =>
		typeof sourceFile === 'string' && unrouteURL(client, sourceFile) === null
			? (id === SYNCHRONOUS_REQUEST_REPORT && view.synchronousSite()) ||
				view.firstSite()
			: undefined;
	const idOf = (body: unknown) => {
		try {
			return (body as { id?: unknown }).id;
		} catch (error) {
			return undefined;
		}
	};
	const hooked = view.hooked;
	const hook = (prototype: any) => {
		if (!prototype || hooked.has(prototype)) return;
		hooked.add(prototype);
		const nativeSource = Reflect.getOwnPropertyDescriptor(
			prototype,
			'sourceFile',
		)?.get;
		for (const key of REPORT_URL_KEYS) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					return key === 'sourceFile'
						? (siteFor(value, idOf(that))?.filename ?? unroute(value))
						: unroute(value);
				}),
			});
		}
		const policy = Reflect.getOwnPropertyDescriptor(
			prototype,
			'originalPolicy',
		);
		if (policy?.get)
			Reflect.defineProperty(prototype, 'originalPolicy', {
				...policy,
				get: proxyModule.wrapFunction(policy.get, (target, that, args) =>
					pagePolicy(Reflect.apply(target, that, args)),
				),
			});
		if (nativeSource)
			for (const [key, part] of [
				['lineNumber', 'lineno'],
				['columnNumber', 'colno'],
			] as const) {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, key, {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const value = Reflect.apply(target, that, args);
							const site = siteFor(
								Reflect.apply(nativeSource, that, []),
								idOf(that),
							);
							return site ? site[part] : value;
						},
					),
				});
			}
		if (Object.hasOwn(prototype, 'toJSON'))
			prototype.toJSON = proxyModule.wrapFunction(
				prototype.toJSON,
				(target, that, args) => {
					const json: Record<string, any> = Reflect.apply(target, that, args);
					if (json && typeof json === 'object') {
						unrouteJSON(json);
						if (json.body && typeof json.body === 'object')
							unrouteJSON(json.body);
					}
					return json;
				},
			);
	};
	// A report about the inject's own code is not the page's. There is
	// one: a document with no top to take the rewriter library from (a
	// frame under a top of another build) fetches it with a synchronous
	// request (src/inject/rewriter.ts), which the browser reports as
	// deprecated, naming the inject bundle. No request of the page's
	// raises that report here: its synchronous requests go through the
	// bridge (dom/modules/Sync.ts).
	const own = (report: unknown) => {
		try {
			const { type, body } = report as {
				type?: unknown;
				body?: { id?: unknown; sourceFile?: unknown } | null;
			};
			return (
				type === 'deprecation' &&
				body?.id === SYNCHRONOUS_REQUEST_REPORT &&
				// (one the page opened is the page's: noteSynchronousRequest)
				!view.synchronousSite() &&
				typeof body.sourceFile === 'string' &&
				unrouteURL(client, body.sourceFile) === null
			);
		} catch (error) {
			return false;
		}
	};
	const seen = (reports: unknown) => {
		if (Array.isArray(reports) && reports.some(own))
			reports = reports.filter((report) => !own(report));
		if (Array.isArray(reports))
			for (const report of reports) {
				if (typeof report !== 'object' || report === null) continue;
				hook(Reflect.getPrototypeOf(report));
				try {
					const body = (report as Report).body;
					if (body) hook(Reflect.getPrototypeOf(body));
				} catch (error) {
					// a report without a body
				}
			}
		return reports;
	};
	return seen(reports);
}
