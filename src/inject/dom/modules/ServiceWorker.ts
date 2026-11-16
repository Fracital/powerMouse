import type { ControlInfo, PageEvent } from '../../../serviceWorkerTypes';
import { SW_CONTROL, SW_EVENT } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import { deferred } from '../deferred';
import type { Emulated } from './serviceWorkerEmulation';

/**
 * `navigator.serviceWorker` for a proxied page, backed by the emulated
 * service workers STomp's own worker runs (docs/service-workers.md). Only
 * unless `serviceWorkers` is off; then the Navigator module removes the API.
 */
export default class ServiceWorkerModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const control = Reflect.get(global, SW_CONTROL) as ControlInfo | undefined;
		Reflect.deleteProperty(global, SW_CONTROL);
		if (!this.client.serviceWorkers) return;
		if (
			typeof global.ServiceWorkerContainer !== 'function' ||
			!('serviceWorker' in global.Navigator.prototype)
		)
			return;
		// a page of a plain http site is no secure context: natively it has
		// no service workers at all
		if (!trustworthy(this.client.url.url)) {
			for (const name of [
				'ServiceWorkerContainer',
				'ServiceWorkerRegistration',
				'ServiceWorker',
				'NavigationPreloadManager',
			])
				Reflect.deleteProperty(global, name);
			Reflect.deleteProperty(global.Navigator.prototype, 'serviceWorker');
			return;
		}
		const proxyModule = this.client.getModule(ProxyModule)!;
		const origin = () => this.client.url.url.origin;
		// an event of this document's registrations: its origin's, in its
		// partition (a site framed by another has registrations of its own)
		const ownEvent = (event: PageEvent) =>
			event.origin === origin() &&
			(event.partition ?? '') === this.client.partition;
		// the registration that controls this document, from its shell: only
		// its own origin's and partition's
		const own =
			control &&
			control.registration.scope.startsWith(origin()) &&
			(control.partition ?? '') === this.client.partition
				? control
				: undefined;
		// the objects, and the few hundred member hooks behind them, are made
		// when the page first reads navigator.serviceWorker (or a worker of
		// its site speaks to it), so a frame that never does pays nothing for
		// them; a document a worker controls makes them at once. What makes
		// them is a deferred part of the bundle (../deferred.ts): a frame
		// that never reads it does not evaluate that code either
		let emulated: Emulated | undefined;
		const emulate = () =>
			(emulated ??= deferred().emulateServiceWorker(
				this.client,
				own,
				proxyModule,
				origin,
				ownEvent,
			));
		if (own) emulate();
		this.client.onServiceWorkerEvent((message) => {
			const data = message.data as Record<string, unknown> | null;
			if (typeof data !== 'object' || data === null || !(SW_EVENT in data))
				return;
			const event = data[SW_EVENT] as PageEvent;
			if (!ownEvent(event)) return;
			emulate().handle(event, [...message.ports]);
		});

		// the native container's own calls never register anything: only
		// this module's container answers them
		const navigatorDescriptor = Reflect.getOwnPropertyDescriptor(
			global.Navigator.prototype,
			'serviceWorker',
		)!;
		Reflect.defineProperty(global.Navigator.prototype, 'serviceWorker', {
			...navigatorDescriptor,
			get: proxyModule.wrapFunction(navigatorDescriptor.get!, () => {
				// an opaque origin has no service workers
				if (this.client.opaqueRequests)
					throw new global.DOMException(
						"Failed to read the 'serviceWorker' property from 'Navigator': The document is sandboxed and lacks the 'allow-same-origin' flag.",
						'SecurityError',
					);
				return emulate().container;
			}),
		});
	}
}

/** what Chrome counts as a secure context's origin: https, and the loopback hosts */
export function trustworthy(url: URL): boolean {
	if (url.protocol === 'https:') return true;
	const host = url.hostname;
	return (
		url.protocol === 'http:' &&
		(host === 'localhost' ||
			host.endsWith('.localhost') ||
			host === '[::1]' ||
			/^127(\.\d{1,3}){3}$/.test(host))
	);
}
