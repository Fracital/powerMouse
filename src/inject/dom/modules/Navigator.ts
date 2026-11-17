import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { reportOnly } from '../../modules/Fetch';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import DocumentClient from '../Client';

/** the beacon bytes Chrome lets a document have in flight at once */
const BEACON_QUOTA = 65536;
// the body types that keep a beacon a no-cors request (the CORS-safelisted
// Content-Types); any other makes it a cors request with a preflight
const SAFELISTED_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
];
const nativeToString = Object.prototype.toString;
const tagOf = (value: unknown) =>
	(Reflect.apply(nativeToString, value, []) as string).slice(8, -1);
const utf8Length = (text: string) =>
	text.length > BEACON_QUOTA
		? text.length
		: new TextEncoder().encode(text).length;

/**
 * About what a FormData weighs once the browser has written it as
 * multipart/form-data (Chrome's 38-character boundary): the quota counts
 * the encoded body, which only the browser makes
 */
function formDataLength(data: FormData): number {
	// "--" + boundary + CRLF, the Content-Disposition line with its quotes,
	// the blank line, and the CRLF after the value
	const perPart = 40 + 2 + 38 + 1 + 4 + 2;
	// the closing "--" + boundary + "--" + CRLF
	let length = 44;
	data.forEach((value, name) => {
		length +=
			perPart + utf8Length(name) + 2 * (name.match(/[\r\n"]/g)?.length ?? 0);
		if (typeof value === 'string')
			length += utf8Length(value.replace(/\r\n|\r|\n/g, '\r\n'));
		else
			length +=
				// `; filename=""`, CRLF, `Content-Type: `
				13 +
				utf8Length(value.name) +
				2 +
				14 +
				(value.type || 'application/octet-stream').length +
				value.size;
	});
	return length;
}

/**
 * A beacon's payload as the browser would send it: the body, the bytes it
 * counts against the quota and the Content-Type it gets. Null for a payload
 * the browser refuses (a stream, a shared buffer), which is left to it.
 */
function beaconPayload(
	data: unknown,
): { body: BodyInit | null; size: number; type: string | null } | null {
	if (data === undefined || data === null)
		return { body: null, size: 0, type: null };
	if (typeof data === 'object') {
		const tag = tagOf(data);
		if (tag === 'ReadableStream' || tag === 'SharedArrayBuffer') return null;
		if (ArrayBuffer.isView(data) || tag === 'ArrayBuffer')
			return {
				body: data as BodyInit,
				size: (data as ArrayBuffer).byteLength,
				type: null,
			};
		if (tag === 'Blob' || tag === 'File')
			return {
				body: data as Blob,
				size: (data as Blob).size,
				type: (data as Blob).type || null,
			};
		if (tag === 'FormData')
			return {
				body: data as FormData,
				size: formDataLength(data as FormData),
				type: 'multipart/form-data',
			};
		if (tag === 'URLSearchParams')
			return {
				body: data as URLSearchParams,
				size: utf8Length(String(data)),
				type: 'application/x-www-form-urlencoded;charset=UTF-8',
			};
	}
	const text = String(data);
	return {
		body: text,
		size: utf8Length(text),
		type: 'text/plain;charset=UTF-8',
	};
}

/**
 * The beacon bytes this bundle has in flight through each controlled
 * document, for the documents under it that no service worker controls:
 * their beacons go out as that document's keepalive requests, which share
 * its quota
 */
const relayedBytes = new WeakMap<object, number>();

export default class NavigatorModule extends Module<DocumentClient> {
	/** the beacon bytes this document has in flight through an ancestor */
	#beaconBytes = 0;

	/**
	 * Send a beacon of a document no service worker controls through `via`,
	 * its nearest controlled ancestor; what sendBeacon answers
	 */
	#relayBeacon(
		via: object,
		url: string,
		payload: NonNullable<ReturnType<typeof beaconPayload>>,
	): boolean {
		const { body, size, type } = payload;
		// the quota is the document's own, as natively
		if (this.#beaconBytes + size > BEACON_QUOTA) return false;
		// the request outlives both documents while the ancestor's quota has
		// room for it; past that it lives as long as the ancestor does
		const shared = relayedBytes.get(via) ?? 0;
		const keepalive = shared + size <= BEACON_QUOTA;
		this.#beaconBytes += size;
		if (keepalive) relayedBytes.set(via, shared + size);
		const settled = () => {
			this.#beaconBytes -= size;
			if (keepalive)
				relayedBytes.set(via, (relayedBytes.get(via) ?? size) - size);
		};
		this.client
			.routedFetch(url, {
				method: 'POST',
				body,
				mode:
					type === null ||
					SAFELISTED_TYPES.includes(type.split(';')[0].trim().toLowerCase())
						? 'no-cors'
						: 'cors',
				credentials: 'include',
				keepalive,
			})
			.then((response) => {
				settled();
				// (a beacon's answer is no one's)
				response.body?.cancel().catch(() => {});
			}, settled);
		return true;
	}

	apply() {
		const global = this.client.global;
		// with emulated service workers the ServiceWorker module answers
		// instead (docs/service-workers.md); without, a page could register a
		// real worker on the proxy origin, which would serve every site
		if (
			!this.client.serviceWorkers &&
			'serviceWorker' in global.Navigator.prototype
		) {
			delete (global as any).ServiceWorkerContainer;
			delete (global as any).ServiceWorkerRegistration;
			delete (global.Navigator.prototype as any).serviceWorker;
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
						const scheme = String(args[0]);
						if (!SAFE_SCHEMES.has(scheme) && !/^web\+[a-z]+$/.test(scheme))
							throw withStack(
								new global.DOMException(
									`Failed to execute '${name}' on 'Navigator': The scheme '${scheme}' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.`,
									'SecurityError',
								),
							);
						if (!String(args[1]).includes('%s'))
							throw withStack(
								new global.DOMException(
									`Failed to execute '${name}' on 'Navigator': The url provided ('${String(args[1])}') does not contain '%s'.`,
									'SyntaxError',
								),
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

					// A document no service worker controls (an about:blank
					// frame the page built, a document it wrote): Chrome hands
					// its beacon to no worker, so the routed request went to
					// the proxy origin's own server, a 404 there, and the site
					// never heard. It goes out as a request of the nearest
					// controlled document instead (as this document's fetches
					// do), a POST with the beacon's body, mode and credentials,
					// counted against this document's own quota.
					const via = this.client.controlledClient();
					if (via && via !== this.client && that === global.navigator) {
						const payload = beaconPayload(args[1]);
						// (a payload the browser refuses: its own TypeError, and
						// nothing is sent)
						if (payload !== null)
							return this.#relayBeacon(via, args[0], payload);
					}

					return Reflect.apply(target, that, args);
				},
			);
	}
}
