import type ProxyModule from './modules/Proxy';

/**
 * The listeners each XMLHttpRequestUpload stand-in has (the page's and the
 * worker's XMLHttpRequest modules). One registered when send() is called
 * sets the CORS-preflight flag: a cross-origin request with a body goes
 * after a preflight whatever its method and headers, as natively
 * (PREFLIGHT_HEADER). The browser does not say which listeners a target
 * has, so they are counted where they are added and removed, on the
 * realm's EventTarget, for upload objects only (an `on*` setter adds its
 * listener the same way). Every other target's call goes straight on.
 */
export function trackUploadListeners(
	global: typeof globalThis,
	proxyModule: ProxyModule,
	/**
	 * called before a listener is added that the browser may answer with a
	 * report naming the caller (a deprecated `unload` handler): the hook is
	 * the caller the browser sees, so the page's is taken here
	 * (Unroute's noteReportSite)
	 */
	reportProne?: () => void,
) {
	/** per upload object: its listeners, by type, capture and callback */
	const listeners = new WeakMap<object, Set<string>>();
	const callbackIds = new WeakMap<object, number>();
	let nextCallback = 0;
	const optionOf = (options: unknown, name: string): unknown =>
		typeof options === 'object' && options !== null
			? Reflect.get(options, name)
			: undefined;
	const keyOf = (args: unknown[]) => {
		const callback = args[1];
		if (
			callback === null ||
			(typeof callback !== 'function' && typeof callback !== 'object')
		)
			return null;
		let id = callbackIds.get(callback);
		if (id === undefined) callbackIds.set(callback, (id = nextCallback++));
		const options = args[2];
		const capture =
			typeof options === 'object' && options !== null
				? !!optionOf(options, 'capture')
				: !!options;
		return `${String(args[0])}|${capture}|${id}`;
	};
	const proto = global.EventTarget.prototype;
	const nativeAdd = proto.addEventListener;
	const signalAborted = Reflect.getOwnPropertyDescriptor(
		global.AbortSignal?.prototype ?? {},
		'aborted',
	)?.get;
	for (const [method, add] of [
		['addEventListener', true],
		['removeEventListener', false],
	] as const)
		proto[method] = proxyModule.wrapFunction(
			proto[method],
			(target, self, args) => {
				const own =
					self !== null && typeof self === 'object'
						? listeners.get(self)
						: undefined;
				if (!own) {
					if (add && reportProne && args[0] === 'unload') reportProne();
					return Reflect.apply(target, self, args);
				}
				const key = keyOf(args);
				if (key === null) return Reflect.apply(target, self, args);
				if (!add) {
					const result = Reflect.apply(target, self, args);
					own.delete(key);
					return result;
				}
				// a listener added with a signal goes when the signal aborts,
				// and one added with an aborted signal is never added
				let signal: unknown;
				let aborted = false;
				try {
					signal = optionOf(args[2], 'signal');
					aborted =
						!!signal &&
						!!signalAborted &&
						!!Reflect.apply(signalAborted, signal, []);
				} catch (error) {
					// not a signal: the native call below says so
					signal = undefined;
				}
				const result = Reflect.apply(target, self, args);
				if (aborted) return result;
				own.add(key);
				if (signal)
					try {
						Reflect.apply(nativeAdd, signal, [
							'abort',
							() => own.delete(key),
							{ once: true },
						]);
					} catch (error) {
						// counted until it is removed by hand
					}
				return result;
			},
		);
	return {
		/** `upload` is an upload object: its listeners are counted from here on */
		track(upload: object) {
			listeners.set(upload, new Set());
		},
		/** whether `upload` has a listener registered now */
		listening(upload: object): boolean {
			return !!listeners.get(upload)?.size;
		},
	};
}
