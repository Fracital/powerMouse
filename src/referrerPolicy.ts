/** the policy a request gets when neither its document nor its initiator set one */
export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * The Referer a browser sends from `source` to `target` under `policy`
 * (Referrer Policy, "determine request's referrer"), for the real origins.
 * Null means no header. The same value is the `document.referrer` of the
 * document a navigation creates. The service worker applies it to every
 * request and the inject to a nested document whose initiator the worker
 * could not see: every proxied page shares the proxy origin, so the
 * browser's own reduction is wrong for the real ones.
 */
export function refererFor(
	source: URL,
	target: URL,
	policy: string,
): string | null {
	const sameOrigin = source.origin === target.origin;
	const downgrade =
		source.protocol === 'https:' && target.protocol !== 'https:';
	const full = () => {
		const stripped = new URL(source);
		stripped.hash = '';
		stripped.username = '';
		stripped.password = '';
		return stripped.toString();
	};
	const origin = () => `${source.origin}/`;
	switch (policy) {
		case 'no-referrer':
			return null;
		case 'unsafe-url':
			return full();
		case 'origin':
			return origin();
		case 'same-origin':
			return sameOrigin ? full() : null;
		case 'strict-origin':
			return downgrade ? null : origin();
		case 'no-referrer-when-downgrade':
			return downgrade ? null : full();
		case 'origin-when-cross-origin':
			return sameOrigin ? full() : origin();
		default:
			// strict-origin-when-cross-origin
			return sameOrigin ? full() : downgrade ? null : origin();
	}
}

/**
 * What the service worker tells a document's shell about its referrer:
 * the value it computed (empty for none), or, when the browser sent only
 * the proxy origin and the initiator is unknown to the worker, the policy
 * the inject applies to the parent document it can see.
 */
export type ReferrerInfo = { referrer: string } | { policy: string };
