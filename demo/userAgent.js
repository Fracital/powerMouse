// Chrome's stable versions for the identities the demo hands its controller.
// Only this backend contacts Google; /config.js visitors get the last good
// answer immediately, or the fixed fallback before the first answer arrives.

export const FALLBACK_VERSION = '158.0.0.0';
export const DEFAULT_VERSION_API =
	'https://versionhistory.googleapis.com/v1/chrome/platforms';
const VERSION = /^\d+(?:\.\d+){3}$/;

export function chromeUserAgent(platform, version) {
	return platform === 'android'
		? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`
		: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * A non-blocking, one-hour cache of both channels. A fixed override needs no
 * feed: its own form factor uses it exactly, the other uses the same version.
 */
export function createUserAgents({
	enabled = true,
	override = '',
	api = DEFAULT_VERSION_API,
	ttl = 60 * 60 * 1000,
	timeout = 5000,
	fetchImpl = fetch,
	warm = true,
} = {}) {
	if (!enabled) return { current: () => null, refresh: async () => {} };
	const fixed = override ? /Chrome\/(\d+(?:\.\d+){3})/.exec(override) : null;
	if (override && !fixed)
		throw new Error('STOMP_USER_AGENT must contain Chrome/<full version>');
	const fixedMobile = override && /\bAndroid\b/.test(override);
	let versions = { linux: FALLBACK_VERSION, android: FALLBACK_VERSION };
	let checkedAt = 0;
	let refreshing = null;

	async function refresh() {
		if (fixed) return;
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), timeout);
			try {
				const base = api.replace(/\/+$/, '');
				await Promise.all(
					['linux', 'android'].map(async (platform) => {
						try {
							const answer = await fetchImpl(
								`${base}/${platform}/channels/stable/versions?page_size=1`,
								{ signal: abort.signal },
							);
							if (!answer.ok) return;
							const body = await answer.json();
							const version = body?.versions?.[0]?.version;
							if (typeof version === 'string' && VERSION.test(version))
								versions = { ...versions, [platform]: version };
						} catch {
							// Keep this platform's last good version.
						}
					}),
				);
				// A failed attempt is cached too, so visitors cannot stampede it.
				checkedAt = Date.now();
			} finally {
				clearTimeout(timer);
				refreshing = null;
			}
		})();
		return refreshing;
	}

	function current() {
		if (!fixed && Date.now() - checkedAt >= ttl) void refresh();
		if (fixed) {
			return {
				desktop: fixedMobile ? chromeUserAgent('linux', fixed[1]) : override,
				mobile: fixedMobile ? override : chromeUserAgent('android', fixed[1]),
			};
		}
		return {
			desktop: chromeUserAgent('linux', versions.linux),
			mobile: chromeUserAgent('android', versions.android),
		};
	}

	if (warm) void refresh();
	return { current, refresh };
}
