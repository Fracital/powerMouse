import { governing, sourcesMatch } from '../../../csp';
import { CSP_REPORT } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import type DocumentClient from '../Client';
import { addDocumentOpenListener } from '../Client';

/** how much of the code a violation's sample shows (measured) */
const SAMPLE_LENGTH = 40;

/**
 * The page's code an inline violation's `sample` (the browser's, of the
 * rewritten code) stands for: the text the page reads back of the script
 * or the style element, or of the attribute of `element` whose rewritten
 * value starts with it (a handler, a style attribute); null for none
 */
function pageCode(target: unknown, sample: string): string | null {
	const element = target as Element;
	let local: unknown;
	try {
		local = Reflect.apply(nativeLocalName, element, []);
	} catch (error) {
		// the document, or no node at all
		return null;
	}
	if (local === 'script' || local === 'style')
		return (element.textContent ?? '').slice(0, SAMPLE_LENGTH);
	for (const name of nativeAttributeNames.call(element))
		if (
			(name === 'style' || name.startsWith('on')) &&
			(nativeGetAttribute.call(element, name) ?? '').startsWith(sample)
		)
			return (element.getAttribute(name) ?? '').slice(0, SAMPLE_LENGTH);
	return null;
}
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
		const global = this.client.global as typeof globalThis;
		const prototype = global.SecurityPolicyViolationEvent?.prototype;
		if (!prototype) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const native = (key: string) =>
			Reflect.getOwnPropertyDescriptor(prototype, key)?.get;
		const nativePolicy = native('originalPolicy');
		const nativeBlocked = native('blockedURI');
		const nativeDirective = native('effectiveDirective');
		const nativeTrusted = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			'isTrusted',
		)?.get;
		const stop = global.Event.prototype.stopImmediatePropagation;
		const listen = global.EventTarget.prototype.addEventListener;
		// The browser reports a refusal against each of its policies that
		// refuses the URL it was given (a refusal URL, the proxy origin's
		// route of a refused hop): one of the page's that allows the page's
		// URL natively reports nothing. Its event goes no further than the
		// window's capture, where this listener comes first (the browser's
		// events of the page's scripts' own refusals are untouched).
		const shows = (event: Event): boolean => {
			try {
				if (nativeTrusted && !Reflect.apply(nativeTrusted, event, []))
					return true;
				const text = Reflect.apply(nativePolicy!, event, []) as string;
				const entry = this.client
					.pagePolicies()
					.find(({ browser }) => browser === text);
				if (!entry) return true;
				const blocked = Reflect.apply(nativeBlocked!, event, []) as string;
				const refused = this.client.refusedURI(blocked);
				const page =
					refused?.url ??
					(blocked.includes(':') ? unrouteURL(this.client, blocked) : null);
				if (!page || page === blocked) return true;
				const url = new URL(page);
				const directive = Reflect.apply(nativeDirective!, event, []) as string;
				const governed = governing(entry.policy, directive);
				if (!governed || !sourcesMatch(governed.sources, url, entry.self))
					return true;
				// allowed here: a refusal URL is this policy's to report only
				// where it refuses the load; a refused route is shown for a
				// refusal no policy explains (a later hop of a redirect, which
				// names the first URL)
				return (
					!refused &&
					!this.client
						.pageRefusals(directive, url)
						.some(({ policy }) => policy.disposition === 'enforce')
				);
			} catch (error) {
				return true;
			}
		};
		// a request the worker let through that a report-only policy refuses
		this.client.onServiceWorkerMessage((data) => {
			if (typeof data !== 'object' || data === null) return;
			const report = (data as Record<string, unknown>)[CSP_REPORT];
			if (!Array.isArray(report)) return;
			try {
				this.client.reportRefusal(
					String(report[0]),
					new URL(String(report[1])),
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
		const hook = (key: string, read: (value: string) => string) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.get) return;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					return typeof value === 'string' ? read(value) : value;
				}),
			});
		};
		for (const key of URL_FIELDS)
			hook(key, (value) => {
				if (!value.includes(':')) return value;
				if (key === 'blockedURI') {
					const refused = this.client.refusedURI(value);
					if (refused !== null) return refused.blocked;
				}
				const page = unrouteURL(this.client, value);
				if (page === null) return '';
				// a report names no fragment
				return key === 'blockedURI' ? page.replace(/#.*$/s, '') : page;
			});
		hook(
			'originalPolicy',
			(value) => this.client.pagePolicyText(value) ?? value,
		);
		// the page's code, which the rewriter changed ('report-sample'): what
		// it evaluated, or the text the page reads back of the element
		const nativeTarget = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			'target',
		)?.get;
		const sample = Reflect.getOwnPropertyDescriptor(prototype, 'sample');
		if (sample?.get && nativeBlocked && nativeTarget)
			Reflect.defineProperty(prototype, 'sample', {
				...sample,
				get: proxyModule.wrapFunction(sample.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					if (typeof value !== 'string' || !value) return value;
					try {
						const blocked = Reflect.apply(nativeBlocked, that, []);
						if (blocked === 'eval') return this.client.codeSample(value);
						if (blocked !== 'inline') return value;
						return (
							pageCode(
								Reflect.apply(nativeTarget, that, []) as unknown,
								value,
							) ?? value
						);
					} catch (error) {
						return value;
					}
				}),
			});
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
					return value !== '' && value === this.client.scriptNonce ? '' : value;
				}),
			});
		}
	}
}
