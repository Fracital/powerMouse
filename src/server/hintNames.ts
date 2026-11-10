// The client hints Chrome knows, as the worker builds them (clientHints.ts)
// and orders them (headerOrder.ts): a leaf module, so the field order needs
// none of the worker's state.

/** every hint Chrome knows, by header name, with the feature that gates it */
export const HINT_FEATURES: Record<string, string> = {
	'device-memory': 'ch-device-memory',
	'sec-ch-device-memory': 'ch-device-memory',
	dpr: 'ch-dpr',
	'sec-ch-dpr': 'ch-dpr',
	'viewport-width': 'ch-viewport-width',
	'sec-ch-viewport-width': 'ch-viewport-width',
	'sec-ch-viewport-height': 'ch-viewport-height',
	width: 'ch-width',
	'sec-ch-width': 'ch-width',
	rtt: 'ch-rtt',
	downlink: 'ch-downlink',
	ect: 'ch-ect',
	'sec-ch-ua': 'ch-ua',
	'sec-ch-ua-arch': 'ch-ua-arch',
	'sec-ch-ua-platform': 'ch-ua-platform',
	'sec-ch-ua-model': 'ch-ua-model',
	'sec-ch-ua-mobile': 'ch-ua-mobile',
	'sec-ch-ua-full-version': 'ch-ua-full-version',
	'sec-ch-ua-platform-version': 'ch-ua-platform-version',
	'sec-ch-ua-bitness': 'ch-ua-bitness',
	'sec-ch-ua-full-version-list': 'ch-ua-full-version-list',
	'sec-ch-ua-wow64': 'ch-ua-wow64',
	'sec-ch-ua-form-factors': 'ch-ua-form-factors',
	'sec-ch-prefers-color-scheme': 'ch-prefers-color-scheme',
	'sec-ch-prefers-reduced-motion': 'ch-prefers-reduced-motion',
	'sec-ch-prefers-reduced-transparency': 'ch-prefers-reduced-transparency',
	'save-data': 'ch-save-data',
};

/** the hints every request carries unless a policy forbids them */
export const SENT_BY_DEFAULT = new Set([
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-platform',
	'save-data',
]);
/** features whose default allowlist is `*` (Chrome's permissions_policy_features.json5) */
export const ENABLED_FOR_ALL = new Set([
	'ch-ua',
	'ch-ua-mobile',
	'ch-ua-platform',
	'ch-save-data',
]);
/** the hints the browser builds for a navigation, in the order it adds them */
export const NAVIGATION_HINT_ORDER = [
	'device-memory',
	'sec-ch-device-memory',
	'dpr',
	'sec-ch-dpr',
	'viewport-width',
	'sec-ch-viewport-width',
	'sec-ch-viewport-height',
	'rtt',
	'downlink',
	'ect',
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-full-version',
	'sec-ch-ua-arch',
	'sec-ch-ua-platform',
	'sec-ch-ua-platform-version',
	'sec-ch-ua-model',
	'sec-ch-ua-bitness',
	'sec-ch-ua-wow64',
	'sec-ch-ua-full-version-list',
	'sec-ch-ua-form-factors',
	'sec-ch-prefers-color-scheme',
	'sec-ch-prefers-reduced-motion',
	'sec-ch-prefers-reduced-transparency',
	'save-data',
];
/** the hints Blink adds to a subresource, in the order it adds them */
export const SUBRESOURCE_HINT_ORDER = [
	'device-memory',
	'sec-ch-device-memory',
	'rtt',
	'downlink',
	'ect',
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-arch',
	'sec-ch-ua-platform',
	'sec-ch-ua-platform-version',
	'sec-ch-ua-model',
	'sec-ch-ua-full-version',
	'sec-ch-ua-full-version-list',
	'sec-ch-ua-bitness',
	'sec-ch-ua-wow64',
	'sec-ch-ua-form-factors',
	'save-data',
	'sec-ch-prefers-reduced-transparency',
	'sec-ch-prefers-reduced-motion',
	'sec-ch-prefers-color-scheme',
	'dpr',
	'sec-ch-dpr',
	'viewport-width',
	'sec-ch-viewport-width',
	'sec-ch-viewport-height',
	'width',
	'sec-ch-width',
];

export const isHintName = (name: string) =>
	Object.prototype.hasOwnProperty.call(HINT_FEATURES, name);

/**
 * An Accept-CH value (or a meta's content): a structured list of tokens,
 * the hints Chrome knows of them; null when the value is no such list (the
 * header is then ignored). Unknown tokens are skipped.
 */
export function parseAcceptCH(value: string): string[] | null {
	const hints: string[] = [];
	const trimmed = value.trim();
	if (!trimmed) return hints;
	for (const member of trimmed.split(',')) {
		const item = member.trim().split(';')[0].trim().toLowerCase();
		if (!/^[a-z*][a-z0-9_\-.:%*/!#$&'^`|~+]*$/.test(item)) return null;
		if (isHintName(item) && !hints.includes(item)) hints.push(item);
	}
	return hints;
}
