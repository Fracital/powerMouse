// What Chrome keeps in HttpServerProperties for HTTP/3: the alternative
// services each origin advertised (Alt-Svc, RFC 7838, or an HTTPS DNS
// record), until their max-age, and the ones that failed, which are left
// alone for 5 minutes, doubling on each consecutive failure up to 2 days
// (net/http/broken_alternative_services.cc).

/** one advertised HTTP/3 endpoint for an origin */
export interface AltService {
	/** the host QUIC connects to; always the origin's own (see parseAltSvc) */
	host: string;
	port: number;
	/** ms since the epoch after which the entry is stale */
	expires: number;
	/** where it was learned */
	source: 'alt-svc' | 'dns' | 'force';
}

/** `clear`, or the h3 alternatives of one Alt-Svc field value */
export type AltSvcValue = 'clear' | { port: number; maxAge: number }[];

const DEFAULT_MAX_AGE_S = 24 * 60 * 60;
const BROKEN_BASE_MS = 5 * 60 * 1000;
const BROKEN_MAX_MS = 2 * 24 * 60 * 60 * 1000;

/** split on `sep` outside double quotes */
function splitOutsideQuotes(value: string, sep: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === '\\' && quoted && i + 1 < value.length) {
			current += c + value[++i];
			continue;
		}
		if (c === '"') quoted = !quoted;
		if (c === sep && !quoted) {
			parts.push(current);
			current = '';
		} else current += c;
	}
	parts.push(current);
	return parts;
}

function unquote(value: string): string {
	value = value.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
		return value.slice(1, -1).replace(/\\(.)/g, '$1');
	return value;
}

/**
 * The HTTP/3 alternatives an Alt-Svc field value names for `originHost`.
 * Only `h3` counts (Chrome dropped the drafts, `h3-29` and the like), and
 * only an alternative on the origin's own host: an alt-authority naming
 * another host would send the origin's requests to a server the page never
 * named, so it is ignored, as is anything malformed. `null` when the value
 * names nothing usable.
 */
export function parseAltSvc(
	value: string,
	originHost: string,
): AltSvcValue | null {
	if (value.trim().toLowerCase() === 'clear') return 'clear';
	const found: { port: number; maxAge: number }[] = [];
	for (const alternative of splitOutsideQuotes(value, ',')) {
		const [first, ...params] = splitOutsideQuotes(alternative, ';');
		const eq = first.indexOf('=');
		if (eq < 0) continue;
		let protocol: string;
		try {
			protocol = decodeURIComponent(first.slice(0, eq).trim());
		} catch {
			continue;
		}
		if (protocol !== 'h3') continue;
		const authority = unquote(first.slice(eq + 1));
		const colon = authority.lastIndexOf(':');
		if (colon < 0) continue;
		const host = authority.slice(0, colon).replace(/^\[|\]$/g, '');
		const port = Number(authority.slice(colon + 1));
		if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
		if (
			host &&
			host.toLowerCase() !== originHost.replace(/^\[|\]$/g, '').toLowerCase()
		)
			continue;
		let maxAge = DEFAULT_MAX_AGE_S;
		for (const param of params) {
			const at = param.indexOf('=');
			if (at < 0) continue;
			if (param.slice(0, at).trim().toLowerCase() !== 'ma') continue;
			const ma = Number(unquote(param.slice(at + 1)));
			if (Number.isFinite(ma) && ma >= 0) maxAge = ma;
		}
		found.push({ port, maxAge });
	}
	return found.length ? found : null;
}

interface Broken {
	until: number;
	/** consecutive failures, for the backoff */
	count: number;
}

/** per-origin alternative services and the broken ones, keyed by `URL.origin` */
export class AltSvcCache {
	#entries = new Map<string, AltService>();
	#broken = new Map<string, Broken>();
	#now: () => number;
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** the usable HTTP/3 alternative for `origin`, if any */
	lookup(origin: string): AltService | null {
		const entry = this.#entries.get(origin);
		if (!entry) return null;
		const now = this.#now();
		if (entry.expires <= now) {
			this.#entries.delete(origin);
			return null;
		}
		const broken = this.#broken.get(origin);
		if (broken && broken.until > now) return null;
		return entry;
	}

	/** whether `origin` has an entry at all (fresh or broken), so DNS is not asked again */
	known(origin: string): boolean {
		const entry = this.#entries.get(origin);
		return !!entry && entry.expires > this.#now();
	}

	/**
	 * A response's Alt-Svc for `origin` replaces what the origin advertised
	 * before; `clear` forgets it. A response without the field changes
	 * nothing.
	 */
	learn(origin: string, hostname: string, values: string[]): void {
		if (!values.length) return;
		const parsed = parseAltSvc(values.join(', '), hostname);
		if (parsed === 'clear') {
			this.#entries.delete(origin);
			return;
		}
		if (!parsed) {
			// an origin that stopped advertising h3 (only other protocols now)
			if (this.#entries.get(origin)?.source === 'alt-svc')
				this.#entries.delete(origin);
			return;
		}
		// the first h3 alternative is the preferred one (RFC 7838 section 3)
		const best = parsed[0];
		this.#entries.set(origin, {
			host: hostname,
			port: best.port,
			expires: this.#now() + best.maxAge * 1000,
			source: 'alt-svc',
		});
	}

	/** an entry from somewhere other than Alt-Svc (an HTTPS record, `force`); never replaces one the server sent */
	add(origin: string, entry: AltService): void {
		const current = this.#entries.get(origin);
		if (
			current &&
			current.source === 'alt-svc' &&
			current.expires > entry.expires
		)
			return;
		this.#entries.set(origin, entry);
	}

	/** QUIC to `origin` failed: leave it alone for a while, longer each time */
	markBroken(origin: string): number {
		const previous = this.#broken.get(origin);
		const count = (previous?.count ?? 0) + 1;
		const delay = Math.min(BROKEN_BASE_MS * 2 ** (count - 1), BROKEN_MAX_MS);
		this.#broken.set(origin, { until: this.#now() + delay, count });
		return delay;
	}

	/** QUIC to `origin` worked: the backoff starts over */
	confirm(origin: string): void {
		this.#broken.delete(origin);
	}

	/** a snapshot for `Http3Transport.info()` */
	entries(): {
		origin: string;
		entry: AltService;
		brokenUntil: number | null;
	}[] {
		return [...this.#entries].map(([origin, entry]) => ({
			origin,
			entry,
			brokenUntil: this.#broken.get(origin)?.until ?? null,
		}));
	}
}
