// What a proxied document in a frame reads for prefers-color-scheme, for the
// Sec-CH-Prefers-Color-Scheme of the navigation the controller makes there.
// A host sets a page's light or dark preference as Chrome's own mode is set
// for every tab: with `color-scheme` on the frame element. Chrome 157
// (measured, same-origin and cross-origin, nested too) gives a frame's
// document the used color-scheme of its element when the element's names
// one of light and dark only, and its parent document's preference when it
// is `normal` or names both; a change fires the media query's change event.

const QUERY = '(prefers-color-scheme: dark)';

/** the preference a document of the frame `element` reads */
export function frameColorScheme(element: Element): 'light' | 'dark' {
	const view = element.ownerDocument.defaultView ?? window;
	// the frame's own document when this page can read it: an emulated
	// preference (DevTools) moves it as it moves the page's
	try {
		const inner = (element as HTMLIFrameElement).contentWindow;
		if (inner)
			return Reflect.apply(view.matchMedia, inner, [QUERY]).matches
				? 'dark'
				: 'light';
	} catch (error) {
		// another origin's document (the site pool, isolation mode)
	}
	let names: string[] = [];
	try {
		names = view.getComputedStyle(element).colorScheme.split(/\s+/);
	} catch (error) {
		// not in a document
	}
	const dark = names.includes('dark');
	if (dark !== names.includes('light')) return dark ? 'dark' : 'light';
	try {
		return view.matchMedia(QUERY).matches ? 'dark' : 'light';
	} catch (error) {
		return 'light';
	}
}

/** a preference another window passed on, when it is one */
export function schemeOf(value: unknown): 'light' | 'dark' | undefined {
	return value === 'light' || value === 'dark' ? value : undefined;
}
