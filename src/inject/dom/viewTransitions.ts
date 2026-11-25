// What document.startViewTransition() does in a frame past its hook
// (./modules/ViewTransition.ts says why a transition is skipped there), a
// deferred part of the document bundle (./deferredParts.ts), made at a
// page's first call: few pages start a transition, and fewer in a frame.

type Update = (...args: unknown[]) => unknown;

/** the browser's own functions the call reads with, taken before any page script */
export interface TransitionNatives {
	defaultViewGet: () => unknown;
	documentElementGet: () => unknown;
	bodyGet: () => unknown;
	getComputedStyle: typeof getComputedStyle;
	getPropertyValue: CSSStyleDeclaration['getPropertyValue'];
	NativePromise: PromiseConstructor;
	promiseResolve: PromiseConstructor['resolve'];
	promiseThen: Promise<unknown>['then'];
	/** whether `view` is a frame's window (no top to compare: true) */
	inFrame: (view: typeof globalThis) => boolean;
	/** the browser's skipTransition() of `transition` */
	skip: (transition: unknown) => unknown;
}

/** the hooked startViewTransition()'s call: `target` the browser's, on `that` with `args` */
export function viewTransitionCall(
	natives: TransitionNatives,
): (target: Function, that: Document, args: unknown[]) => unknown {
	const {
		defaultViewGet,
		documentElementGet,
		bodyGet,
		getComputedStyle,
		getPropertyValue,
		NativePromise,
		promiseResolve,
		promiseThen,
		inFrame,
		skip,
	} = natives;
	const style = (view: typeof globalThis, element: Element, name: string) =>
		Reflect.apply(
			getPropertyValue,
			Reflect.apply(getComputedStyle, view, [element]),
			[name],
		) as string;
	const forcedScrollbar = (view: typeof globalThis, element: Element) =>
		style(view, element, 'overflow-x') === 'scroll' ||
		style(view, element, 'overflow-y') === 'scroll';
	// whether a transition on `document` now could crash the renderer
	const hazard = (document: Document) => {
		const view = Reflect.apply(defaultViewGet, document, []) as
			typeof globalThis | null;
		if (!view || !inFrame(view)) return false;
		const root = Reflect.apply(
			documentElementGet,
			document,
			[],
		) as Element | null;
		if (!root) return false;
		// a root that is not captured does not crash
		if (style(view, root, 'view-transition-name') === 'none') return false;
		if (forcedScrollbar(view, root)) return true;
		// the body's overflow is the viewport's when the root's is visible
		const body = Reflect.apply(bodyGet, document, []) as Element | null;
		return (
			!!body &&
			style(view, root, 'overflow-x') === 'visible' &&
			style(view, root, 'overflow-y') === 'visible' &&
			forcedScrollbar(view, body)
		);
	};
	return (target, that, args) => {
		// set once the browser has made it; the update callback runs later
		const started: { transition?: unknown } = {};
		const check = () => {
			try {
				if (started.transition && hazard(that)) skip(started.transition);
			} catch (error) {
				// not a document the checks understand: leave it be
			}
		};
		// the new state is captured once the update callback is done
		const wrap = (update: unknown) =>
			typeof update === 'function'
				? function (this: unknown, ...a: unknown[]) {
						const result = Reflect.apply(update as Update, this, a);
						return Reflect.apply(
							promiseThen,
							Reflect.apply(promiseResolve, NativePromise, [result]),
							[
								(value: unknown) => {
									check();
									return value;
								},
							],
						);
					}
				: update;
		const next = [...args];
		if (typeof next[0] === 'function') next[0] = wrap(next[0]);
		else if (next[0] !== null && typeof next[0] === 'object') {
			// each member read once, in the browser's (dictionary) order
			const options = next[0] as { types?: unknown; update?: unknown };
			const types = options.types;
			const update = options.update;
			next[0] =
				types === undefined
					? { update: wrap(update) }
					: { types, update: wrap(update) };
		}
		started.transition = Reflect.apply(target, that, next);
		check();
		return started.transition;
	};
}
