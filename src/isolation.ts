// Cross-origin isolation, as Chrome decides it (docs/same-origin-policy.md,
// "Cross-origin isolation"; measured in Chrome 152 and 156). A document is
// cross-origin isolated when its top-level document sent
// `Cross-Origin-Opener-Policy: same-origin` and a Cross-Origin-Embedder-Policy
// (`require-corp` or `credentialless`), every document between it and the
// top sent an embedder policy too, and the `cross-origin-isolated`
// permission reaches it; or when it sent a Document-Isolation-Policy of its
// own. Every proxied document is a frame of the host's page, so none of that
// is the page's to decide: the host's page opts in with its own headers, the
// service worker gives every proxied document an embedder policy so it loads
// there, and the documents whose own headers do not isolate natively are
// served with `Permissions-Policy: cross-origin-isolated=()`, under which
// Chrome gives them what a page without isolation has.

export type EmbedderPolicy = 'unsafe-none' | 'require-corp' | 'credentialless';

/**
 * The token of a structured field item that is a token, with or without
 * parameters: the value of COOP, COEP and Document-Isolation-Policy.
 * Anything else (a quoted string, a list, another case) is no value at all,
 * as Chrome reads it (measured: `"require-corp"`, `require-corp,
 * require-corp` and `Require-Corp` do not isolate; `require-corp;
 * report-to="x"` and `require-corp;foo=bar` do).
 */
function tokenItem(header: string | null): string | null {
	if (header === null) return null;
	return (
		/^[ \t]*([A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*)(?:[ \t]*;[ \t]*[a-z*][a-z0-9_\-.*]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;, \t]*))?)*[ \t]*$/.exec(
			header,
		)?.[1] ?? null
	);
}

/** a response's Cross-Origin-Embedder-Policy (`header`: the header's value, or null) */
export function embedderPolicy(header: string | null): EmbedderPolicy {
	const token = tokenItem(header);
	return token === 'require-corp' || token === 'credentialless'
		? token
		: 'unsafe-none';
}

/** whether a Cross-Origin-Opener-Policy is `same-origin`, the one value that isolates with an embedder policy */
export function openerSameOrigin(header: string | null): boolean {
	return tokenItem(header) === 'same-origin';
}

/** whether a Document-Isolation-Policy isolates the document by itself */
export function documentIsolates(header: string | null): boolean {
	const token = tokenItem(header);
	return (
		token === 'isolate-and-require-corp' ||
		token === 'isolate-and-credentialless'
	);
}

/**
 * Whether a document's own Permissions-Policy (or the older Feature-Policy,
 * when there is no Permissions-Policy) lets the document itself, of
 * `origin`, be cross-origin isolated. Without either the default allowlist
 * (`self`) does.
 */
export function policyAllowsSelf(
	permissionsPolicy: string | null,
	featurePolicy: string | null,
	origin: string,
): boolean {
	if (permissionsPolicy !== null) {
		// a structured dictionary: `cross-origin-isolated=(self "https://a")`,
		// `=*`, `=()`, `=self`; the last member of the name wins
		let allowlist: string | null = null;
		for (const member of permissionsPolicy.split(',')) {
			const match = /^\s*cross-origin-isolated\s*(?:=\s*(.*?))?\s*$/.exec(
				member,
			);
			if (match) allowlist = match[1] ?? '*';
		}
		if (allowlist !== null) {
			const items = allowlist.replace(/^\(|\)$/g, '').trim();
			if (!items) return false;
			return items
				.split(/\s+/)
				.some(
					(item) =>
						item === '*' ||
						item === 'self' ||
						sameOriginItem(item.replace(/^"|"$/g, ''), origin),
				);
		}
	}
	if (featurePolicy !== null)
		for (const directive of featurePolicy.split(/[;,]/)) {
			const [name, ...items] = directive.trim().split(/\s+/);
			if (name !== 'cross-origin-isolated') continue;
			// a directive without an allowlist is 'self'
			if (!items.length) return true;
			return items.some(
				(item) =>
					item === '*' || item === "'self'" || sameOriginItem(item, origin),
			);
		}
	return true;
}

function sameOriginItem(item: string, origin: string): boolean {
	try {
		return new URL(item).origin === origin;
	} catch (error) {
		return false;
	}
}

/** the response headers isolation is decided by */
export interface IsolationHeaders {
	coop: string | null;
	coep: string | null;
	dip: string | null;
	permissionsPolicy: string | null;
	featurePolicy: string | null;
}

export function isolationHeaders(headers: Headers): IsolationHeaders {
	return {
		coop: headers.get('cross-origin-opener-policy'),
		coep: headers.get('cross-origin-embedder-policy'),
		dip: headers.get('document-isolation-policy'),
		permissionsPolicy: headers.get('permissions-policy'),
		featurePolicy: headers.get('feature-policy'),
	};
}

/**
 * What a nested document's route says of the document that embeds it
 * (src/partition.ts nestedMark)
 */
export interface Embedder {
	/** the embedding document's origin */
	origin: string;
	/** it has an embedder policy: a frame's document without one does not load */
	coep: boolean;
	/** its top-level document sent COOP same-origin and an embedder policy */
	group: boolean;
	/**
	 * whom the embedder's `cross-origin-isolated` permission reaches, by its
	 * own state and the frame's `allow`: a document of its own origin
	 * (`self`, the default allowlist), of any origin (`any`), or none; the
	 * origins the attribute names besides are in `origins`
	 */
	delegates: 'self' | 'any' | 'none';
	origins: string[];
	/**
	 * the frame is a credentialless one: its document loads without a policy
	 * of its own, and is isolated when the permission reaches it (measured)
	 */
	credentialless: boolean;
}

/**
 * What a document is by its own headers and its embedder, natively: whether
 * its top-level document made an isolated group, its own embedder policy,
 * whether the `cross-origin-isolated` permission reaches it
 * (`document.featurePolicy` says so, isolated or not), and whether it is
 * cross-origin isolated
 */
export interface DocumentIsolation {
	group: boolean;
	coep: EmbedderPolicy;
	policy: boolean;
	isolated: boolean;
}

/** a top-level document's: COOP `same-origin` with an embedder policy makes the group */
export function topLevelIsolation(
	headers: IsolationHeaders,
	origin: string,
): DocumentIsolation {
	const coep = embedderPolicy(headers.coep);
	const group = openerSameOrigin(headers.coop) && coep !== 'unsafe-none';
	const policy = policyAllowsSelf(
		headers.permissionsPolicy,
		headers.featurePolicy,
		origin,
	);
	return {
		group,
		coep,
		policy,
		// a Document-Isolation-Policy isolates the document whatever the rest
		// says (measured)
		isolated: (group && policy) || documentIsolates(headers.dip),
	};
}

/**
 * A frame's document of `origin`: the group is its top's, the permission
 * reaches it when its embedder's reaches its origin and its own policy does
 * not give it up, and it is isolated when both hold (it loaded there, so it
 * sent an embedder policy), or by a Document-Isolation-Policy of its own
 */
export function nestedIsolation(
	headers: IsolationHeaders,
	origin: string,
	embedder: Embedder,
): DocumentIsolation {
	const policy =
		delegatedTo(embedder, origin) &&
		policyAllowsSelf(headers.permissionsPolicy, headers.featurePolicy, origin);
	// a credentialless frame's document has that policy whatever it sent
	const coep = embedder.credentialless
		? 'credentialless'
		: embedderPolicy(headers.coep);
	return {
		group: embedder.group,
		coep,
		policy,
		isolated:
			(embedder.group && policy && coep !== 'unsafe-none') ||
			documentIsolates(headers.dip),
	};
}

/**
 * What the shell tells a document's client of it (src/rewriteHTML.ts): `g`
 * the group, `c` an embedder policy, `p` the permission. The client says it
 * on in the routes of the frames the document makes.
 */
export function isolationFacts(isolation: DocumentIsolation): string {
	return (
		(isolation.group ? 'g' : '') +
		(isolation.coep !== 'unsafe-none' ? 'c' : '') +
		(isolation.policy ? 'p' : '')
	);
}

/**
 * Whom an iframe's `allow` attribute lets have the `cross-origin-isolated`
 * permission, of a document that has it: `self` without a directive (the
 * default allowlist), else what the directive lists: `*`, 'self', 'src' (the
 * origin of `src`, which a directive without a value means too), 'none',
 * origins
 */
export function allowDelegates(
	allow: string | null,
	src: string | null,
): Pick<Embedder, 'delegates' | 'origins'> {
	let delegates: Embedder['delegates'] = 'self';
	const origins: string[] = [];
	for (const directive of (allow ?? '').split(';')) {
		const [name, ...items] = directive.trim().split(/\s+/);
		if (name.toLowerCase() !== 'cross-origin-isolated') continue;
		delegates = 'none';
		for (const item of items.length ? items : ["'src'"]) {
			if (item === '*') delegates = 'any';
			else if (item === "'self'") {
				if (delegates === 'none') delegates = 'self';
			} else if (item === "'src'") {
				if (src !== null) origins.push(src);
			} else if (item !== "'none'")
				try {
					origins.push(new URL(item).origin);
				} catch (error) {
					// not an origin: nobody
				}
		}
		break;
	}
	return { delegates, origins };
}

/** whether the embedder's permission reaches a frame's document of `origin` */
export function delegatedTo(embedder: Embedder, origin: string): boolean {
	return (
		embedder.delegates === 'any' ||
		(embedder.delegates === 'self' && embedder.origin === origin) ||
		embedder.origins.includes(origin)
	);
}

/**
 * Whether Chrome refuses to load a frame's document under an embedder with
 * an embedder policy: the document sent none, or it is of another origin
 * and its Cross-Origin-Resource-Policy does not let the embedder have it
 * (measured: `cross-origin`, or `same-site` for a same-site embedder; a
 * `credentialless` embedder asks the same of a frame). A redirect on the
 * way (`redirect`) needs no embedder policy, only that resource policy.
 */
export function embedderRefuses(
	headers: Headers,
	origin: string,
	embedder: Embedder,
	sameSite: boolean,
	redirect = false,
): boolean {
	if (!embedder.coep || embedder.credentialless) return false;
	if (
		!redirect &&
		embedderPolicy(headers.get('cross-origin-embedder-policy')) ===
			'unsafe-none'
	)
		return true;
	if (embedder.origin === origin) return false;
	const policy = headers.get('cross-origin-resource-policy')?.trim();
	return !(policy === 'cross-origin' || (policy === 'same-site' && sameSite));
}

/** what the service worker adds to a document it serves to a host whose page is cross-origin isolated */
export function isolationResponseHeaders(
	headers: Headers,
	{ isolated, topLevel }: { isolated: boolean; topLevel: boolean },
) {
	// without an embedder policy no frame loads in the host's page; with
	// credentialless a load that is not the proxy's own is not refused for
	// its missing Cross-Origin-Resource-Policy
	headers.set('cross-origin-embedder-policy', 'credentialless');
	// the host's page may be of another origin than the proxy's
	headers.set('cross-origin-resource-policy', 'cross-origin');
	// a window the page opens stays in the host's browsing context group
	// (its opener would be gone otherwise), and is isolated as the host is
	if (topLevel) headers.set('cross-origin-opener-policy', 'same-origin');
	// the page's own Permissions-Policy never reaches the browser
	// (src/server/filterHeaders.ts): this one is the proxy's, and under it
	// Chrome gives the document what one without isolation has
	if (!isolated) headers.set('permissions-policy', 'cross-origin-isolated=()');
}

/**
 * Whether a document's or worker's embedder policy refuses it a no-cors
 * response of another origin: under `require-corp` one without a
 * Cross-Origin-Resource-Policy that lets it be had (`cross-origin`, or
 * `same-site` from its own site). Under `credentialless` the request went
 * without credentials instead and the response passes.
 */
export function embedderPolicyBlocks(
	policy: EmbedderPolicy,
	headers: Headers,
	sameSite: boolean,
): boolean {
	if (policy !== 'require-corp') return false;
	const resource = headers.get('cross-origin-resource-policy')?.trim();
	return !(
		resource === 'cross-origin' ||
		(resource === 'same-site' && sameSite)
	);
}
