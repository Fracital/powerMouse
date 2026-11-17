// The referrer policy of the element that started a navigation in a fresh
// browsing context (src/inject/dom/modules/IFrame.ts): a deferred part
// (./deferred.ts), read only when a frame's navigation goes on in a fresh
// context. Its top level reads no global (./deferredParts.ts).

const REFERRER_POLICIES = [
	'no-referrer',
	'no-referrer-when-downgrade',
	'origin',
	'origin-when-cross-origin',
	'same-origin',
	'strict-origin',
	'strict-origin-when-cross-origin',
	'unsafe-url',
];

/**
 * The referrer policy the element that started a navigation asks for
 * itself: none at all for `rel=noreferrer` (a link's, a form's), else a
 * link's `referrerpolicy`; '' for the document's own. The hooked getters
 * answer with what the page wrote.
 */
export function sourcePolicy(
	source: Element | null | undefined,
): ReferrerPolicy {
	if (!source) return '';
	try {
		const link = source.nodeName === 'A' || source.nodeName === 'AREA';
		// a form's submitter: the form's own rel counts
		const owner = link
			? source
			: ((source as HTMLButtonElement).form ?? source);
		if (
			(owner.getAttribute('rel') ?? '')
				.toLowerCase()
				.split(/\s+/)
				.includes('noreferrer')
		)
			return 'no-referrer';
		const policy = link
			? (source.getAttribute('referrerpolicy') ?? '').toLowerCase()
			: '';
		if (REFERRER_POLICIES.includes(policy)) return policy as ReferrerPolicy;
	} catch (error) {
		// an element of another kind: the document's
	}
	return '';
}
