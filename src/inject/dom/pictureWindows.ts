// Document Picture-in-Picture (dom/modules/IFrame.ts): a deferred part of
// the document bundle (./deferredParts.ts), made for a top-level document
// that has the API, which a proxied page is only as a popup the browser
// opened. Its top level reads no global (./deferredParts.ts).
//
// The window is an about:blank of the proxy origin whose opener is the
// page: it is injected as the page's about:blank popup is, before the page
// gets it from the promise, the `window` getter or the enter event (its own
// code read the proxy origin's storage and cookies, every site's).

type Wrap = (
	target: Function,
	handler: (target: any, that: unknown, args: unknown[]) => unknown,
) => any;

export function pictureWindows(
	realm: Record<string, any>,
	wrap: Wrap,
	inject: (context: typeof globalThis) => void,
	clientName: string,
): void {
	const adopt = (context: unknown) => {
		if (context && typeof context === 'object')
			try {
				inject(context as typeof globalThis);
				const client = (context as Record<string, any>)[clientName];
				if (!client.applied) client.apply();
			} catch (error) {
				// gone already, or not this page's
			}
		return context;
	};
	const proto = realm.DocumentPictureInPicture.prototype as Record<
		string,
		Function
	>;
	if (typeof proto.requestWindow === 'function')
		proto.requestWindow = wrap(
			proto.requestWindow,
			async (target, that, args) =>
				adopt(await Reflect.apply(target, that, args)),
		);
	for (const owner of [proto, realm.DocumentPictureInPictureEvent?.prototype]) {
		if (!owner) continue;
		const descriptor = Reflect.getOwnPropertyDescriptor(owner, 'window');
		if (descriptor?.get)
			Reflect.defineProperty(owner, 'window', {
				...descriptor,
				get: wrap(descriptor.get, (target, that) =>
					adopt(Reflect.apply(target, that, [])),
				),
			});
	}
}
