import { CSP_REPORT } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, { memberName } from '../../modules/Proxy';
import { trustTaggedViolations } from '../../violationViews';
import type DocumentClient from '../Client';
import { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { ViolationNatives } from '../violations';

const nativeAttributeNames = Element.prototype.getAttributeNames;
const nativeLocalName = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'localName',
)!.get!;
const nativeGetAttribute = Element.prototype.getAttribute;

/** the fields of a violation that name URLs */
const URL_FIELDS = ['documentURI', 'blockedURI', 'referrer', 'sourceFile'];

/**
 * The browser's own violations of the page's policy (src/csp.ts: the
 * browser applies what of it it can to the proxy's URLs), as the page sees
 * them natively: a securitypolicyviolation event names the page's URLs
 * (its document's, the blocked load's, the script's) and the page's policy
 * as the page wrote it, not the policy the browser was given. The event is
 * the browser's, trusted and dispatched where natively; only what its
 * getters read is put right. A URL of the inject's own (its bundle, as
 * the script that called a hooked API) reads as no URL.
 */
export default class ContentSecurityModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global as typeof globalThis;
		const prototype = global.SecurityPolicyViolationEvent?.prototype;
		if (!prototype) return;
		const proxyModule = client.getModule(ProxyModule)!;
		const native = (key: string) =>
			Reflect.getOwnPropertyDescriptor(prototype, key)?.get;
		const nativePolicy = native('originalPolicy');
		const nativeBlocked = native('blockedURI');
		const nativeDirective = native('effectiveDirective');
		// isTrusted lives on Event.prototype; walk the event's own chain to it,
		// since the realm's `Event` may be the inject's stand-in
		let nativeTrusted: (() => boolean) | undefined;
		for (
			let proto: object | null = prototype;
			proto;
			proto = Reflect.getPrototypeOf(proto)
		) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, 'isTrusted');
			if (descriptor?.get) {
				nativeTrusted = descriptor.get as () => boolean;
				break;
			}
		}
		const stop = global.Event.prototype.stopImmediatePropagation;
		const listen = global.EventTarget.prototype.addEventListener;
		const nativeTarget = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			'target',
		)?.get;
		const natives: ViolationNatives = {
			policy: nativePolicy!,
			blocked: nativeBlocked!,
			directive: nativeDirective!,
			localName: nativeLocalName,
			attributeNames: nativeAttributeNames,
			getAttribute: nativeGetAttribute,
		};
		// Whether one of the browser's events reaches the page: its event goes
		// no further than the window's capture, where this listener comes first
		// (the browser's events of the page's scripts' own refusals are
		// untouched, and the inject's own, untrusted, always do). The reading is
		// a deferred part (../violations.ts), made at the first; without it the
		// event is stopped, so no proxy URL reaches the page.
		const shows = (event: Event): boolean => {
			try {
				if (nativeTrusted && !Reflect.apply(nativeTrusted, event, []))
					return true;
				// none of the page's policies: a policy of the browser's alone
				// (no part is made for it)
				if (!client.pagePolicies().length) return true;
			} catch (error) {
				return true;
			}
			try {
				return deferred('violationShows')(client, natives, event);
			} catch (error) {
				return false;
			}
		};
		// a request the worker let through that a report-only policy refuses
		client.onServiceWorkerMessage((data) => {
			if (typeof data !== 'object' || data === null) return;
			const report = (data as Record<string, unknown>)[CSP_REPORT];
			if (!Array.isArray(report)) return;
			// (a navigation's later hop: what it names, how often, and whether
			// the policy is this frame's parent's)
			const [directive, url, blocked, times, parent] = report;
			try {
				(parent === true ? client.parentClient() : client)?.reportRefusal(
					String(directive),
					new URL(String(url)),
					false,
					typeof times === 'number' ? Math.min(times, 2) : 1,
					typeof blocked === 'string' ? blocked : undefined,
				);
			} catch (error) {
				// not a URL
			}
		});
		if (nativePolicy && nativeBlocked && nativeDirective) {
			const listener = (event: Event) => {
				if (!shows(event)) Reflect.apply(stop, event, []);
			};
			const register = () =>
				Reflect.apply(listen, global, [
					'securitypolicyviolation',
					listener,
					true,
				]);
			register();
			addDocumentOpenListener(global, register);
		}
		// a getter's call that hands what the browser read to `read`, with the
		// member it is (one call for all the URL fields, which read which one
		// they are from the native getter they wrap)
		const reading =
			(read: (value: string, key: string) => string) =>
			(target: Function, that: unknown, args: unknown[]) => {
				const value = Reflect.apply(target, that, args);
				return typeof value === 'string'
					? read(value, memberName(target))
					: value;
			};
		const hook = (
			key: string,
			call: (target: Function, that: unknown, args: unknown[]) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.get) return;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, call),
			});
		};
		// (a deferred part, ../violations.ts: the getter throws without it)
		const urlField = reading((value, key) =>
			value.includes(':')
				? deferred('violationURL')(client, value, key)
				: value,
		);
		for (const key of URL_FIELDS) hook(key, urlField);
		hook(
			'originalPolicy',
			reading((value) => client.pagePolicyText(value) ?? value),
		);
		// the page's code, which the rewriter changed ('report-sample'): what
		// it evaluated, or the text the page reads back of the element
		const sample = Reflect.getOwnPropertyDescriptor(prototype, 'sample');
		if (sample?.get && nativeBlocked && nativeTarget)
			Reflect.defineProperty(prototype, 'sample', {
				...sample,
				get: proxyModule.wrapFunction(sample.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					if (typeof value !== 'string' || !value) return value;
					let blocked: unknown;
					try {
						blocked = Reflect.apply(nativeBlocked, that, []);
						if (blocked === 'eval') return client.codeSample(value);
						if (blocked !== 'inline') return value;
					} catch (error) {
						return value;
					}
					// an inline one's: a deferred part (../violations.ts), the getter
					// throws without it
					const pageCode = deferred('violationPageCode');
					try {
						return (
							pageCode(
								natives,
								Reflect.apply(nativeTarget, that, []) as unknown,
								value,
							) ?? value
						);
					} catch (error) {
						return value;
					}
				}),
			});
		// A violation the inject fires reads back trusted, as the browser's
		// would (the csp-trusted-types, csp-scripts and csp-base-uri cases
		// compare isTrusted, and that every listener is handed one object,
		// window.event)
		trustTaggedViolations(global, proxyModule, client.violationViews);
		// A synthesised script-src/style-src violation of the page's own code
		// (dom/Client.ts: the browser never gets those directives) is dispatched
		// on the document so the page's listener always hears it, but names the
		// element the browser would (an inline script or style, a handler's
		// element): read that element back here.
		// The getter is Event.prototype's, hooked in place the first time such
		// an event is made: a `target` of SecurityPolicyViolationEvent.prototype's
		// own is a member the browser's prototype does not have (a page that
		// lists it saw one more key), and a hook on every event's target is
		// paid only by a document that has such a violation.
		if (nativeTarget) {
			const eventPrototype = global.Event.prototype;
			const descriptor = Reflect.getOwnPropertyDescriptor(
				eventPrototype,
				'target',
			)!;
			client.namesViolationTargets = () => {
				client.namesViolationTargets = undefined;
				Reflect.defineProperty(eventPrototype, 'target', {
					...descriptor,
					get: proxyModule.wrapFunction(
						nativeTarget,
						(target, that, args) =>
							client.codeViolationTarget.get(that as object) ??
							Reflect.apply(target, that, args),
					),
				});
			};
		}
		// the document's nonce on an element of the page's (one its policy
		// lets through by a hash or a host, which the browser's copy cannot
		// judge: DocumentClient.codeNonce) is not the page's
		for (const owner of [global.HTMLElement, global.SVGElement]) {
			const descriptor = owner
				? Reflect.getOwnPropertyDescriptor(owner.prototype, 'nonce')
				: undefined;
			if (!descriptor?.get) continue;
			Reflect.defineProperty(owner.prototype, 'nonce', {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					return value !== '' && value === client.scriptNonce ? '' : value;
				}),
			});
		}
	}
}
