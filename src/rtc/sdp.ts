// SDP as the page reads it (docs/webrtc-over-wisp.md, section 6): the
// stack negotiates and writes its own SDP, and what the page gets is that
// state rendered in Chrome's shape, line for line, with the identifiers the
// wire uses (ufrag, pwd, fingerprint, mids, SCTP port) and the candidates
// the worker chose to show. What the page hands over for the remote side
// goes to the stack as it is, minus what the stack cannot read (a candidate
// at a name instead of an address, which the worker maps itself).

export interface Media {
	kind: string;
	port: string;
	protocol: string;
	formats: string[];
	connection: string | null;
	attributes: [name: string, value: string | null][];
}

export interface ParsedSdp {
	origin: string | null;
	session: [name: string, value: string | null][];
	medias: Media[];
}

function attribute(line: string): [string, string | null] {
	const at = line.indexOf(':');
	return at === -1 ? [line, null] : [line.slice(0, at), line.slice(at + 1)];
}

export function parseSdp(text: string): ParsedSdp {
	const parsed: ParsedSdp = { origin: null, session: [], medias: [] };
	let media: Media | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line.length < 2 || line[1] !== '=') continue;
		const type = line[0];
		const value = line.slice(2);
		if (type === 'm') {
			const [kind, port, protocol, ...formats] = value.split(' ');
			media = {
				kind,
				port,
				protocol,
				formats,
				connection: null,
				attributes: [],
			};
			parsed.medias.push(media);
		} else if (type === 'o' && !media) parsed.origin = value;
		else if (type === 'c') {
			if (media) media.connection = value;
		} else if (type === 'a') {
			(media ? media.attributes : parsed.session).push(attribute(value));
		}
	}
	return parsed;
}

export function first(
	attributes: [string, string | null][],
	name: string,
): string | null {
	for (const [key, value] of attributes) if (key === name) return value;
	return null;
}
export function all(
	attributes: [string, string | null][],
	name: string,
): string[] {
	const out: string[] = [];
	for (const [key, value] of attributes)
		if (key === name && value !== null) out.push(value);
	return out;
}

/** the fields of a `candidate:` value: foundation, component, protocol, priority, address, port, type */
export interface CandidateFields {
	foundation: string;
	component: string;
	protocol: string;
	priority: string;
	address: string;
	port: string;
	type: string;
	rest: string[];
}
export function candidateFields(value: string): CandidateFields | null {
	const text = value.startsWith('candidate:') ? value.slice(10) : value;
	const parts = text.split(' ');
	if (parts.length < 8 || parts[6] !== 'typ') return null;
	return {
		foundation: parts[0],
		component: parts[1],
		protocol: parts[2],
		priority: parts[3],
		address: parts[4],
		port: parts[5],
		type: parts[7],
		rest: parts.slice(8),
	};
}
export function candidateLine(fields: CandidateFields): string {
	return [
		`candidate:${fields.foundation}`,
		fields.component,
		fields.protocol,
		fields.priority,
		fields.address,
		fields.port,
		'typ',
		fields.type,
		...fields.rest,
	].join(' ');
}

export function isIPv4(host: string): boolean {
	const parts = host.split('.');
	return (
		parts.length === 4 &&
		parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256)
	);
}
export const isAddress = (host: string) =>
	isIPv4(host) || (host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host));

/** what the renderer takes besides the stack's SDP */
export interface RenderOptions {
	sessionId: string;
	version: number;
	/** `candidate:...` values to show, in the order they were gathered */
	candidates: string[];
	/** the stack's ICE and DTLS parameters, when the SDP does not carry them per section */
	ufrag: string;
	pwd: string;
	fingerprint: string;
}

const CRLF = '\r\n';

/**
 * The stack's SDP in Chrome's shape. The m-sections keep the stack's order
 * and content; the session header, the attribute order within a section
 * and the candidate lines are Chrome's.
 */
export function renderChrome(
	parsed: ParsedSdp,
	options: RenderOptions,
): string {
	const lines: string[] = [];
	lines.push('v=0');
	lines.push(`o=- ${options.sessionId} ${options.version} IN IP4 127.0.0.1`);
	lines.push('s=-');
	lines.push('t=0 0');
	const mids = parsed.medias.map(
		(media) => first(media.attributes, 'mid') ?? '',
	);
	const group = first(parsed.session, 'group');
	lines.push(`a=group:${group ?? `BUNDLE ${mids.join(' ')}`}`);
	lines.push('a=extmap-allow-mixed');
	lines.push('a=msid-semantic: WMS');
	for (const media of parsed.medias) {
		// the port and the connection address are the default candidate's
		const preferred = defaultCandidate(options.candidates);
		lines.push(
			`m=${media.kind} ${preferred?.port ?? media.port} ${media.protocol} ${media.formats.join(' ')}`,
		);
		lines.push(
			preferred
				? `c=IN IP${preferred.address.includes(':') ? 6 : 4} ${preferred.address}`
				: 'c=IN IP4 0.0.0.0',
		);
		if (media.kind !== 'application') lines.push('a=rtcp:9 IN IP4 0.0.0.0');
		// a candidate in a description carries no ufrag: the section's is its
		for (const candidate of options.candidates)
			lines.push(`a=${candidate.replace(/ ufrag \S+/, '')}`);
		const own = (name: string) =>
			first(media.attributes, name) ?? first(parsed.session, name);
		lines.push(`a=ice-ufrag:${own('ice-ufrag') ?? options.ufrag}`);
		lines.push(`a=ice-pwd:${own('ice-pwd') ?? options.pwd}`);
		lines.push('a=ice-options:trickle');
		lines.push(`a=fingerprint:${own('fingerprint') ?? options.fingerprint}`);
		lines.push(`a=setup:${own('setup') ?? 'actpass'}`);
		lines.push(`a=mid:${first(media.attributes, 'mid') ?? ''}`);
		if (media.kind === 'application') {
			lines.push(
				`a=sctp-port:${first(media.attributes, 'sctp-port') ?? '5000'}`,
			);
			lines.push(
				`a=max-message-size:${first(media.attributes, 'max-message-size') ?? '262144'}`,
			);
		} else {
			// the stack's own order for what Chrome lists next (extmaps,
			// direction, msid, rtcp-mux, rtpmap, rtcp-fb, fmtp, ssrc)
			for (const [name, value] of media.attributes) {
				if (RENDERED.has(name)) continue;
				lines.push(value === null ? `a=${name}` : `a=${name}:${value}`);
			}
		}
	}
	return lines.join(CRLF) + CRLF;
}

/**
 * The candidate Chrome writes into the `m=` and `c=` lines: the first UDP
 * one of the most indirect type (relay, then reflexive, then host), IPv4
 * before IPv6; one at a name gives none (port 9 at 0.0.0.0)
 */
function defaultCandidate(
	candidates: string[],
): { address: string; port: string } | null {
	const RANK: Record<string, number> = {
		host: 1,
		srflx: 2,
		prflx: 2,
		relay: 3,
	};
	let best: CandidateFields | null = null;
	for (const candidate of candidates) {
		const fields = candidateFields(candidate);
		if (!fields || fields.protocol.toLowerCase() !== 'udp') continue;
		if (fields.component !== '1') continue;
		const rank = RANK[fields.type] ?? 0;
		const bestRank = best ? (RANK[best.type] ?? 0) : -1;
		if (
			rank > bestRank ||
			(rank === bestRank &&
				best!.address.includes(':') &&
				!fields.address.includes(':'))
		)
			best = fields;
	}
	if (!best || !isAddress(best.address)) return null;
	return { address: best.address, port: best.port };
}

/** the attributes the renderer writes itself */
const RENDERED = new Set([
	'ice-ufrag',
	'ice-pwd',
	'ice-options',
	'fingerprint',
	'setup',
	'mid',
	'candidate',
	'end-of-candidates',
	'sctp-port',
	'max-message-size',
]);

/**
 * A remote description without its candidate lines, and those lines: the
 * worker adds each one itself, when the connection may check it (a browser
 * checks nothing before it has a local description) and by its own mapping
 * when it is at a name (an mDNS name of another browser, or one of a
 * proxied document of this browser), which the stack cannot read.
 */
export function stripCandidates(sdp: string): {
	sdp: string;
	candidates: string[];
} {
	const candidates: string[] = [];
	const out: string[] = [];
	for (const raw of sdp.split(/\r?\n/)) {
		if (raw.startsWith('a=candidate:')) candidates.push(raw.slice(2).trim());
		else out.push(raw);
	}
	return { sdp: out.join(CRLF), candidates };
}

/** the first m-section's index whose mid is `mid` */
export function midIndex(sdp: string, mid: string): number {
	let index = -1;
	for (const raw of sdp.split(/\r?\n/)) {
		if (raw.startsWith('m=')) index++;
		else if (raw.startsWith('a=mid:') && raw.slice(6).trim() === mid)
			return index;
	}
	return -1;
}

/**
 * The names of the m-sections. The stack names one it creates at random
 * (three letters); Chrome names them by position ("0", "1", ...) and pages
 * lean on that (a hard-coded `sdpMid: '0'`). So a section the stack named
 * is shown under Chrome's name, and what the page hands back is turned
 * around; a section the remote side named keeps its name both ways.
 */
export class MidNames {
	#shown = new Map<string, string>();
	#stack = new Map<string, string>();
	#rewrite(sdp: string, name: (mid: string, index: number) => string): string {
		const lines = sdp.split(/\r?\n/);
		// the names first (the group line comes before the sections)
		let index = -1;
		for (const line of lines) {
			if (line.startsWith('m=')) index++;
			else if (line.startsWith('a=mid:')) name(line.slice(6).trim(), index);
		}
		index = -1;
		for (let at = 0; at < lines.length; at++) {
			const line = lines[at];
			if (line.startsWith('m=')) index++;
			else if (line.startsWith('a=mid:'))
				lines[at] = `a=mid:${name(line.slice(6).trim(), index)}`;
			else if (line.startsWith('a=group:BUNDLE '))
				lines[at] = `a=group:BUNDLE ${line
					.slice(15)
					.trim()
					.split(' ')
					.map((mid) => name(mid, -1))
					.join(' ')}`;
		}
		return lines.join(CRLF);
	}
	/** the stack's SDP with the names the page reads */
	toShown(sdp: string): string {
		return this.#rewrite(sdp, (mid, index) => {
			let shown = this.#shown.get(mid);
			if (shown === undefined) {
				let next = Math.max(index, 0);
				while (this.#stack.has(String(next))) next++;
				shown = String(next);
				this.#shown.set(mid, shown);
				this.#stack.set(shown, mid);
			}
			return shown;
		});
	}
	/** the page's SDP (a remote description) with the names the stack knows */
	toStack(sdp: string): string {
		return this.#rewrite(sdp, (mid) => {
			const stack = this.#stack.get(mid);
			if (stack !== undefined) return stack;
			this.#shown.set(mid, mid);
			this.#stack.set(mid, mid);
			return mid;
		});
	}
}
