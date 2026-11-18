import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { reportOnly } from '../../modules/Fetch';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule from '../../modules/Proxy';
import { LazyWeakMap } from '../../ownCollections';
import DocumentClient from '../Client';
import { deferred } from '../deferred';

const nativeToString = Object.prototype.toString;
const tagOf = (value: unknown) =>
	(Reflect.apply(nativeToString, value, []) as string).slice(8, -1);

/**
 * The beacon bytes this bundle has in flight through each controlled
 * document, for the documents under it that no service worker controls:
 * their beacons go out as that document's keepalive requests, which share
 * its quota
 */
const relayedBytes = new LazyWeakMap<object, number>();

export default class NavigatorModule extends Module<DocumentClient> {
	/** the beacon bytes this document has in flight through an ancestor */
	#beacons = { bytes: 0 };

	apply() {
		const client = this.client;
		const global = client.global;
		// with emulated service workers the ServiceWorker module answers
		// instead (docs/service-workers.md); without, a page could register a
		// real worker on the proxy origin, which would serve every site
		if (
			!client.serviceWorkers &&
			'serviceWorker' in global.Navigator.prototype
		) {
			delete (global as any).ServiceWorkerContainer;
			delete (global as any).ServiceWorkerRegistration;
			delete (global.Navigator.prototype as any).serviceWorker;
		}

		const proxyModule = client.getModule(ProxyModule)!;

		// a protocol handler would be registered for the proxy origin, with the
		// browser's prompt naming it: accepted silently, like a denied prompt,
		// after the checks the browser makes first (a deferred part,
		// ../protocolHandlers.ts)
		const navigator = global.Navigator.prototype as Record<string, any>;
		for (const name of ['registerProtocolHandler', 'unregisterProtocolHandler'])
			if (typeof navigator[name] === 'function')
				navigator[name] = proxyModule.wrapFunction(
					navigator[name],
					(target, that, args) => {
						// the browser's own refusals: of too few arguments, and of
						// a receiver that is not this window's navigator
						if (args.length < 2 || that !== global.navigator)
							return Reflect.apply(target, that, args);
						return deferred('protocolHandler')(global, name, args);
					},
				);

		// navigator.keyboard.getLayoutMap() rejects with a SecurityError
		// ("must be called from a top-level browsing context or allowed by the
		// permission policy") in any document the browser does not see as the
		// outermost main frame. Every proxied document is a frame of the host,
		// so a page that reads the keyboard layout at the top level (twitch)
		// hits it where it would not natively, and in an isolated deployment a
		// cross-origin proxied subframe hits it for good. A proxied document
		// believes it is top-level, so the call resolves as it would there:
		// the real layout when the browser still gives it (a same-origin frame
		// is allowed the feature), an empty map when it refuses, never the
		// SecurityError the page never catches.
		const Keyboard = (global as Record<string, any>).Keyboard;
		const nativeGetLayoutMap = Keyboard?.prototype?.getLayoutMap;
		if (typeof nativeGetLayoutMap === 'function') {
			const Mapp = global.Map;
			Keyboard.prototype.getLayoutMap = proxyModule.wrapFunction(
				nativeGetLayoutMap,
				async (target, that, args) => {
					try {
						return await Reflect.apply(target, that, args);
					} catch (error) {
						if ((error as { name?: string })?.name === 'SecurityError')
							return new Mapp();
						throw error;
					}
				},
			);
		}

		if (global.Navigator.prototype.sendBeacon)
			global.Navigator.prototype.sendBeacon = proxyModule.wrapFunction(
				global.Navigator.prototype.sendBeacon,
				(target, that, args) => {
					// no URL to route: the browser's own error for the call
					if (args.length < 1) return Reflect.apply(target, that, args);
					let url: URL;
					try {
						url = client.encodingParse(args[0], client.baseHref);
					} catch (error) {
						// the browser's own TypeError for a URL that does not parse
						return Reflect.apply(target, that, args);
					}
					// mixed content: Chrome refuses an insecure beacon from an https
					// page at once (sendBeacon answers false) and upgrades it under
					// upgrade-insecure-requests
					const mixed = client
						.getModule(MixedContentModule)
						?.verdict(url, 'empty', 'Beacon endpoint');
					if (mixed?.action === 'block') {
						client.getModule(MixedContentModule)!.report(mixed.notices);
						return false;
					}
					if (mixed?.action === 'upgrade') url = mixed.url;
					reportOnly(client, url, 2);
					args[0] = routeXHR(new StompURL(url, client.url));

					// A document no service worker controls (an about:blank
					// frame the page built, a document it wrote): Chrome hands
					// its beacon to no worker, so the routed request went to
					// the proxy origin's own server, a 404 there, and the site
					// never heard. It goes out as a request of the nearest
					// controlled document instead (as this document's fetches
					// do), a POST with the beacon's body, mode and credentials,
					// counted against this document's own quota.
					const via = client.controlledClient();
					if (via && via !== client && that === global.navigator) {
						// (null for a payload the browser refuses: its own
						// TypeError, and nothing is sent). The relay is a
						// deferred part (../deferred.ts): most documents send no
						// beacon, and few of those are uncontrolled
						const sent = deferred('relayBeacon')({
							own: this.#beacons,
							relayed: relayedBytes,
							via,
							url: args[0],
							data: args[1],
							tagOf,
							fetch: (url, init) => client.routedFetch(url, init),
						});
						if (sent !== null) return sent;
					}

					return Reflect.apply(target, that, args);
				},
			);
	}
}
