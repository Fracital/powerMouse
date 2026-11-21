/**
 * A frame's real allow for focus-without-user-activation. Chrome 158 turns
 * the feature off in a frame under any sandbox, and in every frame below
 * it, unless the frame's own allow names it (no sandbox token lifts it, nor
 * any header). Every proxied document is under the controller's sandbox,
 * so a frame of a proxied page that natively has the feature has it only
 * when its real allow names it. What the page wrote (or that it wrote none)
 * stays in the marker, and the browser is given the page's directives with
 * the feature's decided as natively for the frame's document (measured on
 * 158):
 * - no directive for it: on, unless the page's sandbox is on the frame
 * - the first directive for it decides (its name is case-sensitive; an
 *   upper-case one is no feature, and warns)
 * - no allowlist is `'src'`; `*` and `'src'` match any document, an opaque
 *   one too (data:, a sandbox without allow-same-origin); `'self'` the
 *   parent's origin; an origin itself; `'none'` with others is nothing
 * - a frame's document is of its src's origin, of the parent's for a
 *   srcdoc, about:blank, javascript: or none, opaque for data: and under a
 *   sandbox without allow-same-origin
 * The parent's own policy is the browser's to apply (the real allow cannot
 * give more than the real parent has), and a document the worker serves
 * gets the Permissions-Policy header the container policy makes of the
 * page's allow on top (src/server/clientHints.ts).
 */

export const FOCUS_FEATURE = 'focus-without-user-activation';

// Chrome splits an allow attribute's directives on ASCII whitespace
const SPACE = /[\t\n\f\r ]+/;

/** the allowlist of the first directive of `allow` naming the feature, or null */
function focusAllowlist(allow: string): string[] | null {
	for (const directive of allow.split(';')) {
		const [name, ...tokens] = directive.trim().split(SPACE);
		if (name === FOCUS_FEATURE) return tokens.filter(Boolean);
	}
	return null;
}

/**
 * Whether Chrome takes `token` for no origin and warns of it (`Unrecognized
 * origin`): kept as it is, the browser warns as natively and it matches no
 * document. A token it would take for an origin is dropped, as it names a
 * document of the page's world, never the proxy's (a wildcard, a blob:
 * URL and an IPv6 host are none to Chrome 158's allow attribute, measured)
 */
function unrecognized(token: string): boolean {
	const lower = token.toLowerCase();
	if (
		token === '*' ||
		lower === "'self'" ||
		lower === "'src'" ||
		lower === "'none'"
	)
		return false;
	if (token.includes('*') || token.includes('[') || lower.startsWith('blob:'))
		return true;
	try {
		return new URL(token).origin === 'null';
	} catch (error) {
		return true;
	}
}

/** whether `allowlist` lets a document of origin `target` (null: opaque) under a parent of `self` have the feature */
function matches(
	allowlist: string[],
	target: string | null,
	self: string,
): boolean {
	if (!allowlist.length) return true;
	return allowlist.some((token) => {
		const lower = token.toLowerCase();
		if (token === '*' || lower === "'src'") return true;
		if (target === null || lower === "'none'") return false;
		if (lower === "'self'") return target === self && self !== 'null';
		if (unrecognized(token)) return false;
		try {
			return new URL(token).origin === target;
		} catch (error) {
			return false;
		}
	});
}

export interface FrameFocus {
	/** the page's sandbox on the frame, null for none */
	sandbox: string | null;
	/** the origin of the frame's document, null for an opaque one */
	target: string | null;
	/** the parent document's origin (the page's) */
	self: string;
	/** a frame of the site pool, whose documents are of other real origins */
	pool: boolean;
	/** the real allow of the page's other directives (`allow` itself when null) */
	base?: string;
	/** the hidden allow (MutationObserver hiddenAllow) */
	hidden: (granted: boolean) => string;
}

/** the real allow of a frame whose page allow is `allow` (null: none) */
export function focusAllow(allow: string | null, frame: FrameFocus): string {
	if (allow === null) return frame.hidden(frame.sandbox === null);
	const base = frame.base ?? allow;
	const allowlist = focusAllowlist(allow);
	if (allowlist === null)
		return frame.sandbox !== null
			? base
			: `${base.trim() ? `${base}; ` : ''}${FOCUS_FEATURE} *`;
	const granted = matches(allowlist, frame.target, frame.self);
	// (a pool's slot policy names no origin at all)
	const kept = frame.pool ? [] : allowlist.filter(unrecognized);
	// `*` lets any document the frame shows have it, as natively; the
	// others the document of the frame's src: `'src'` is its real one
	if (granted) kept.push(frame.pool || allowlist.includes('*') ? '*' : "'src'");
	const directive = `${FOCUS_FEATURE} ${kept.length ? kept.join(' ') : "'none'"}`;
	const directives = base.split(';');
	const at = directives.findIndex(
		(entry) => entry.trim().split(SPACE)[0] === FOCUS_FEATURE,
	);
	if (at === -1) return `${base.trim() ? `${base}; ` : ''}${directive}`;
	directives[at] = at > 0 ? ` ${directive}` : directive;
	return directives.join(';');
}
