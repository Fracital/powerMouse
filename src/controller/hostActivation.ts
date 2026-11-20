/** what the host's input walks the frames for at most, in a burst of input */
const WALK_GAP = 100;

/**
 * The host page's own input (its address bar, its buttons, its keys). In
 * same-origin mode every proxied document is of the host's origin, so
 * Chrome's activation reaches all of them, where natively none has it (the
 * host is the browser's own window): each proxied document in the host's
 * frames is told it has one only through the proxy
 * (src/inject/dom/activation.ts). A frame of another origin (isolation
 * mode) is never reached, by Chrome or here. `also` hears of each input
 * walked for: the documents a Document-Isolation-Policy puts out of this
 * realm's reach are told by an agent that reaches them (./apart.ts).
 */
export function watchHostInput(name: string, also?: (now: number) => void) {
	let walked = -Infinity;
	const tell = (event: Event) => {
		if (!event.isTrusted) return;
		const type = event.type;
		// the keys and pointers that activate (as the inject's Navigate module)
		if (
			type === 'keydown' &&
			/^(Escape|Shift|Control|Alt|Meta|AltGraph|CapsLock|Fn)$/.test(
				(event as KeyboardEvent).key,
			)
		)
			return;
		if (
			(type === 'pointerdown' &&
				(event as PointerEvent).pointerType !== 'mouse') ||
			(type === 'pointerup' && (event as PointerEvent).pointerType === 'mouse')
		)
			return;
		const now = Date.now();
		if (now - walked < WALK_GAP) return;
		walked = now;
		markHostInput(window, name, now);
		also?.(now);
	};
	for (const type of [
		'keydown',
		'mousedown',
		'pointerdown',
		'pointerup',
		'touchend',
	])
		window.addEventListener(type, tell, true);
}

/**
 * Tell every proxied document in the frames of `root` that this realm
 * reaches that the host's input at `now` was not its own
 */
export function markHostInput(root: Window, name: string, now: number) {
	let budget = 2000;
	const visit = (win: Window) => {
		if (budget-- <= 0) return;
		try {
			const client = (win as unknown as Record<string, any>)[name];
			if (client?.global === win && typeof client.markActivation === 'function')
				client.markActivation(client, true, now);
		} catch (error) {
			// a window of another origin, or one going away
		}
		let length = 0;
		try {
			length = win.length;
		} catch (error) {
			// closing
		}
		for (let index = 0; index < length && budget > 0; index++) {
			let child: Window | undefined;
			try {
				child = (win as unknown as Record<number, Window>)[index];
			} catch (error) {
				// gone meanwhile
			}
			if (child) visit(child);
		}
	};
	for (let index = 0; index < root.length; index++) {
		const child = (root as unknown as Record<number, Window | undefined>)[
			index
		];
		if (child && child !== window) visit(child);
	}
}
