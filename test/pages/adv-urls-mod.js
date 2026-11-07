// Fetched module for adv-urls.html: import.meta in a module file.
export const metaUrl = import.meta.url;
export const sibling = new URL('./adv-urls.js', import.meta.url).href;
export const resolved = import.meta.resolve
	? import.meta.resolve('./adv-urls.js')
	: 'no import.meta.resolve';
export const stack = new Error('mod').stack;
