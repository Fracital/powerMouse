// Whether a document's real origin may claim a relying party id, decided as
// Chrome decides it (measured on 152 and 156 against its virtual
// authenticator, docs/passkeys.md): the id is the origin's host or a
// registrable suffix of it, or the id's own /.well-known/webauthn names the
// origin (WebAuthn Level 3, 5.11 "Using Web Authentication across related
// origins"). The service worker asks this of the sender's own routed URL,
// so the answer is never a page's word.

// Chrome's words for each refusal
const INVALID_DOMAIN = 'This is an invalid domain.';
const NOT_A_SUFFIX =
	'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.';
// the related origins request, each way it ends without naming the caller
const SUBSEQUENTLY = `${NOT_A_SUFFIX} Subsequently, `;
const FETCH_FAILED = `${SUBSEQUENTLY}an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.`;
const WRONG_TYPE = `${SUBSEQUENTLY}the .well-known/webauthn resource of the claimed RP ID had the wrong content-type. (It should be application/json.)`;
const NOT_JSON = `${SUBSEQUENTLY}fetching the .well-known/webauthn resource of the claimed RP ID resulted in a JSON parse error.`;
const NOT_LISTED = `${SUBSEQUENTLY}fetching the .well-known/webauthn resource of the claimed RP ID was successful, but no listed origin matched the caller.`;
const LABELS_FULL = `${NOT_LISTED} Note that a match may have been found but the limit on the number of eTLD+1 labels was reached, causing some entries to be ignored.`;

/** how many registrable labels a related origins list may name (5.11.1) */
const MAX_LABELS = 5;

export interface RpIdLookups {
	/** the registrable domain of a host, private suffixes counted; null for a suffix, an IP or a bare name */
	domainOf(host: string): string | null;
	/** the public suffix of a host, private suffixes counted */
	suffixOf(host: string): string | null;
	/**
	 * `https://<rpId>/.well-known/webauthn`, redirects followed: its body
	 * when it answers 200 as application/json, `type` when as anything else,
	 * `failed` when it does not answer 200
	 */
	wellKnown(url: URL): Promise<{ body: string } | 'type' | 'failed'>;
}

export type RpIdVerdict =
	{ rpId: string } | { error: [name: 'SecurityError', message: string] };

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** whether the browser has WebAuthn at `origin` at all (a secure context): https, or http on this machine */
export function mayUsePasskeys(origin: URL): boolean {
	const host = origin.hostname;
	return (
		origin.protocol === 'https:' ||
		(origin.protocol === 'http:' &&
			(host === 'localhost' ||
				host.endsWith('.localhost') ||
				host === '[::1]' ||
				/^127(\.\d+){3}$/.test(host)))
	);
}

/** 5.11.1's label of an origin: its registrable domain without the public suffix */
function labelOf(host: string, lookups: RpIdLookups): string | null {
	const domain = lookups.domainOf(host);
	const suffix = lookups.suffixOf(host);
	if (!domain || !suffix || !domain.endsWith(`.${suffix}`)) return null;
	return domain.slice(0, -suffix.length - 1);
}

/** the related origins request (5.11.1) of `rpId` for `origin`: null when its list names the origin, else Chrome's refusal */
async function relatedOrigin(
	origin: URL,
	rpId: string,
	lookups: RpIdLookups,
): Promise<string | null> {
	let answer: { body: string } | 'type' | 'failed';
	try {
		answer = await lookups.wellKnown(
			new URL(`https://${rpId}/.well-known/webauthn`),
		);
	} catch (error) {
		answer = 'failed';
	}
	if (answer === 'failed') return FETCH_FAILED;
	if (answer === 'type') return WRONG_TYPE;
	let listed: unknown;
	try {
		listed = (JSON.parse(answer.body) as { origins?: unknown }).origins;
	} catch (error) {
		return NOT_JSON;
	}
	if (!Array.isArray(listed)) return NOT_JSON;
	const labels = new Set<string>();
	let ignored = false;
	for (const entry of listed) {
		if (typeof entry !== 'string') continue;
		let url: URL;
		try {
			url = new URL(entry);
		} catch (error) {
			continue;
		}
		const label = labelOf(url.hostname, lookups);
		if (label === null) continue;
		if (!labels.has(label)) {
			if (labels.size >= MAX_LABELS) {
				ignored = true;
				continue;
			}
			labels.add(label);
		}
		if (url.origin === origin.origin) return null;
	}
	return ignored ? LABELS_FULL : NOT_LISTED;
}

/** whether `text` is a host name and nothing more (no port, no path, no address of a page) */
function isHostName(text: string): boolean {
	try {
		const url = new URL(`https://${text}`);
		return (
			text !== '' &&
			url.hostname === text.toLowerCase() &&
			url.pathname === '/' &&
			!text.includes('/')
		);
	} catch (error) {
		return false;
	}
}

/**
 * The relying party id a request from `origin` runs under: `claimed`, or the
 * origin's host when the page named none; or the SecurityError Chrome gives
 */
export async function relyingPartyOf(
	origin: URL,
	claimed: string | undefined,
	lookups: RpIdLookups,
): Promise<RpIdVerdict> {
	const host = origin.hostname;
	// an address is no domain: Chrome refuses before it looks at the id
	if (IPV4.test(host) || host.startsWith('['))
		return { error: ['SecurityError', INVALID_DOMAIN] };
	if (claimed === undefined || claimed === host) return { rpId: host };
	// a registrable suffix: a parent domain that is not itself a public suffix
	if (host.endsWith(`.${claimed}`) && lookups.domainOf(claimed) !== null)
		return { rpId: claimed };
	// anything that is not a host name at all, an address among them, is
	// refused at once; a host name that is not this origin's to claim may
	// still name it
	if (!isHostName(claimed) || IPV4.test(claimed) || claimed.startsWith('['))
		return { error: ['SecurityError', NOT_A_SUFFIX] };
	const refusal = await relatedOrigin(origin, claimed, lookups);
	return refusal === null
		? { rpId: claimed }
		: { error: ['SecurityError', refusal] };
}
