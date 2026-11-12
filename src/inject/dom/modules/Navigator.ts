import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { reportOnly } from '../../modules/Fetch';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

export default class NavigatorModule extends Module<DocumentClient> {
	apply() {
		// with emulated service workers the ServiceWorker module answers
		// instead (docs/service-workers.md); without, a page could register a
		// real worker on the proxy origin, which would serve every site
		if (
			!this.client.serviceWorkers &&
			'serviceWorker' in this.client.global.Navigator.prototype
		) {
			delete (this.client.global as any).ServiceWorkerContainer;
			delete (this.client.global as any).ServiceWorkerRegistration;
			delete (this.client.global.Navigator.prototype as any).serviceWorker;
		}

		const proxyModule = this.client.getModule(ProxyModule)!;

		// a protocol handler would be registered for the proxy origin, with the
		// browser's prompt naming it: accepted silently, like a denied prompt,
		// after the checks the browser makes first (the safelisted schemes and
		// `web+` names, a URL with `%s`)
		const SAFE_SCHEMES = new Set([
			'bitcoin',
			'ftp',
			'ftps',
			'geo',
			'im',
			'irc',
			'ircs',
			'magnet',
			'mailto',
			'matrix',
			'mms',
			'news',
			'nntp',
			'openpgp4fpr',
			'sftp',
			'sip',
			'sms',
			'smsto',
			'ssh',
			'tel',
			'urn',
			'webcal',
			'wtai',
			'xmpp',
		]);
		const navigator = this.client.global.Navigator.prototype as Record<
			string,
			any
		>;
		for (const name of ['registerProtocolHandler', 'unregisterProtocolHandler'])
			if (typeof navigator[name] === 'function')
				navigator[name] = proxyModule.wrapFunction(
					navigator[name],
					(target, that, args) => {
						if (args.length < 2) return Reflect.apply(target, that, args);
						const scheme = String(args[0]);
						if (!SAFE_SCHEMES.has(scheme) && !/^web\+[a-z]+$/.test(scheme))
							throw new this.client.global.DOMException(
								`Failed to execute '${name}' on 'Navigator': The scheme '${scheme}' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.`,
								'SecurityError',
							);
						if (!String(args[1]).includes('%s'))
							throw new this.client.global.DOMException(
								`Failed to execute '${name}' on 'Navigator': The url provided ('${String(args[1])}') does not contain '%s'.`,
								'SyntaxError',
							);
						return undefined;
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
		const Keyboard = (this.client.global as Record<string, any>).Keyboard;
		const nativeGetLayoutMap = Keyboard?.prototype?.getLayoutMap;
		if (typeof nativeGetLayoutMap === 'function') {
			const Mapp = this.client.global.Map;
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

		if (this.client.global.Navigator.prototype.sendBeacon)
			this.client.global.Navigator.prototype.sendBeacon =
				proxyModule.wrapFunction(
					this.client.global.Navigator.prototype.sendBeacon,
					(target, that, args) => {
						let url: URL;
						try {
							url = new URL(args[0], this.client.baseURL.toString());
						} catch (error) {
							// the browser's own TypeError for a URL that does not parse
							return Reflect.apply(target, that, args);
						}
						// mixed content: Chrome refuses an insecure beacon from an https
						// page at once (sendBeacon answers false) and upgrades it under
						// upgrade-insecure-requests
						const mixed = this.client
							.getModule(MixedContentModule)
							?.verdict(url, 'empty', 'Beacon endpoint');
						if (mixed?.action === 'block') {
							this.client.getModule(MixedContentModule)!.report(mixed.notices);
							return false;
						}
						if (mixed?.action === 'upgrade') url = mixed.url;
						reportOnly(this.client, url, 2);
						args[0] = routeXHR(new StompURL(url, this.client.url));

						return Reflect.apply(target, that, args);
					},
				);
	}
}
