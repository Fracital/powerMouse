// SDP as the page reads it (docs/webrtc-over-wisp.md, section 6): the
// stack negotiates and writes its own SDP, and what the page gets is that
// state rendered in Chrome's shape, line for line, with the identifiers the
// wire uses (ufrag, pwd, fingerprint, mids, SCTP port) and the candidates
// the worker chose to show. What the page hands over for the remote side
// goes to the stack as it is, minus what the stack cannot read (a candidate
// at a name instead of an address, which the worker maps itself).
//
// A media section is written the way this browser writes one: the lines
// its own offer has (the template), in its order, for what the stack
// negotiated. The stack's SDP says which payloads, header extensions and
// sources the section has; the template says how Chrome lists them, which
// feedback each codec names and which lines stand around them; the worker
// says what the transceiver wants and what its sender is called.
import type { CodecCapability, Direction } from './protocol';

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
	/** an answer to an offer that named no BUNDLE group names none either */
	ungrouped?: boolean;
	/** an answer to an offer of no section: the session's first lines alone */
	bare?: boolean;
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
	/** this browser's own offer: the shape of its media sections */
	template?: ParsedSdp | null;
	/** the description is an offer: it leaves the DTLS roles open, whatever they are */
	offer?: boolean;
	/** the offer this description answers */
	answers?: ParsedSdp | null;
	/** the name every source of the connection is listed under */
	cname?: string;
	/** how each media section is written, by mid */
	sections?: Map<string, SectionStyle>;
}

/** what the worker knows of a media section that the stack's SDP does not say */
export interface SectionStyle {
	/** the direction the description states */
	direction: Direction;
	/**
	 * What the section's sender is called (`a=msid`): Chrome names it once
	 * the transceiver wants to send, and from then on whatever the
	 * direction; null for one that never has
	 */
	sender: { streams: string[]; track: string } | null;
	/** the sources the sender sends from, and their `a=ssrc-group` values */
	ssrcs: string[];
	groups: string[];
	/** the header extensions the section last agreed on, by URI; null before it has */
	exts: Set<string> | null;
	/** the transceiver's codec preferences (setCodecPreferences), empty for none */
	codecs?: CodecCapability[];
	/** an answer rejects the section: none of the codecs preferred was offered */
	rejected?: boolean;
	/** Chrome 152's way with them (protocol.ts, codecPreferences) */
	legacy?: boolean;
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
	let group = first(parsed.session, 'group') ?? `BUNDLE ${mids.join(' ')}`;
	// an answer that rejects a section takes it out of the group, and
	// writes the group when that leaves it empty
	const rejected = mids.filter((mid) => options.sections?.get(mid)?.rejected);
	if (rejected.length)
		group = group
			.split(' ')
			.filter((word) => !rejected.includes(word))
			.join(' ');
	// no section left in the bundle (none at all, or each one stopped), or
	// an answer to an offer that had no group: no line
	if (!parsed.ungrouped && (group.trim() !== 'BUNDLE' || rejected.length))
		lines.push(`a=group:${group}`);
	if (!parsed.bare) lines.push('a=extmap-allow-mixed');
	// the streams the description's senders are in, in name order
	const streams = new Set<string>();
	for (const media of parsed.medias) {
		const style = options.sections?.get(first(media.attributes, 'mid') ?? '');
		if (style?.sender && media.port !== '0')
			for (const stream of style.sender.streams) streams.add(stream);
	}
	lines.push(['a=msid-semantic: WMS', ...[...streams].sort()].join(' '));
	// How the answered offer names what it sends: Chrome answers `a=msid`
	// lines with `a=msid` lines alone, and an offer that has the names
	// only on its `a=ssrc` lines the same way; its own offers have both.
	const theirs = options.answers?.medias ?? [];
	const onLines = theirs.some((media) => first(media.attributes, 'msid'));
	const onSources = theirs.some((media) =>
		all(media.attributes, 'ssrc').some((value) => value.includes(' msid:')),
	);
	const names = options.answers
		? { line: onLines || !onSources, source: !onLines && onSources }
		: { line: true, source: true };
	for (const media of parsed.medias) {
		// the port and the connection address are the default candidate's;
		// a stopped section has no port
		const preferred = defaultCandidate(options.candidates);
		const mid = first(media.attributes, 'mid') ?? '';
		const style = options.sections?.get(mid);
		const model = options.template?.medias.find(
			(section) => section.kind === media.kind,
		);
		const shape =
			style && model
				? shaped(
						media,
						model,
						style,
						theirs.find(
							(section) => first(section.attributes, 'mid') === mid,
						) ?? null,
						names,
						options.cname ?? '',
					)
				: null;
		lines.push(
			`m=${media.kind} ${media.port === '0' || style?.rejected ? '0' : (preferred?.port ?? media.port)} ${media.protocol} ${(shape?.formats ?? media.formats).join(' ')}`,
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
		lines.push(
			`a=setup:${options.offer ? 'actpass' : (own('setup') ?? 'actpass')}`,
		);
		lines.push(`a=mid:${first(media.attributes, 'mid') ?? ''}`);
		if (media.kind === 'application') {
			lines.push(
				`a=sctp-port:${first(media.attributes, 'sctp-port') ?? '5000'}`,
			);
			lines.push(
				`a=max-message-size:${first(media.attributes, 'max-message-size') ?? '262144'}`,
			);
		} else if (shape) lines.push(...shape.lines);
		else {
			// no template (a browser that would not make one): the stack's
			// own lines for what Chrome lists next
			for (const [name, value] of media.attributes) {
				if (RENDERED.has(name)) continue;
				lines.push(value === null ? `a=${name}` : `a=${name}:${value}`);
			}
		}
	}
	return lines.join(CRLF) + CRLF;
}

/** a section's payloads: each one's `a=rtpmap`, `a=fmtp` and `a=rtcp-fb` values */
interface Payloads {
	map: Map<string, string>;
	fmtp: Map<string, string>;
	/** the feedback listed with the payload, after its `a=rtpmap` */
	fb: Map<string, string[]>;
	/** the feedback listed before any payload (Chrome 152 lists `rrtr` there) */
	lead: Map<string, string[]>;
}
function payloadsOf(media: Media): Payloads {
	const out: Payloads = {
		map: new Map(),
		fmtp: new Map(),
		fb: new Map(),
		lead: new Map(),
	};
	let mapped = false;
	for (const [name, value] of media.attributes) {
		const at = value?.indexOf(' ') ?? -1;
		if (value === null || at === -1) continue;
		const pt = value.slice(0, at);
		const rest = value.slice(at + 1);
		if (name === 'rtpmap') {
			out.map.set(pt, rest);
			mapped = true;
		} else if (name === 'fmtp') out.fmtp.set(pt, rest);
		else if (name === 'rtcp-fb') {
			const into = mapped ? out.fb : out.lead;
			const list = into.get(pt);
			if (list) list.push(rest);
			else into.set(pt, [rest]);
		}
	}
	return out;
}

/** the attributes of a media section that `shaped` and the renderer write by rule */
const SHAPED = new Set([
	'ice-ufrag',
	'ice-pwd',
	'ice-options',
	'fingerprint',
	'setup',
	'mid',
	'candidate',
	'end-of-candidates',
	'rtcp',
	'extmap',
	'sendrecv',
	'sendonly',
	'recvonly',
	'inactive',
	'msid',
	'rtcp-mux',
	'rtpmap',
	'rtcp-fb',
	'fmtp',
	'ssrc',
	'ssrc-group',
]);

/**
 * The template's payload for a payload of the stack's: the same number
 * where the peer did not renumber it, else one of the same codec
 */
function twinOf(own: Payloads, browser: Payloads) {
	const twins = new Map<string, string | undefined>();
	return (pt: string) => {
		if (twins.has(pt)) return twins.get(pt);
		const map = own.map.get(pt)?.toLowerCase();
		let found: string | undefined;
		for (const [candidate, value] of browser.map) {
			if (value.toLowerCase() !== map) continue;
			if (candidate === pt) {
				found = candidate;
				break;
			}
			if (
				found === undefined ||
				browser.fmtp.get(candidate) === own.fmtp.get(pt)
			)
				found = candidate;
		}
		twins.set(pt, found);
		return found;
	};
}

/** two format lines' parameters are the same, whatever their order */
function sameParameters(a: string | undefined, b: string | undefined) {
	const read = (line = '') =>
		line
			.split(';')
			.filter(Boolean)
			.map((part) => part.trim())
			.sort()
			.join(';');
	return read(a) === read(b);
}

/**
 * The payloads of `formats` a transceiver's codec preferences keep, in
 * their order, as Chrome writes them (measured on 152 and 156): a codec
 * where its preference is, retransmission only when one is preferred and
 * then right after each codec it repeats, redundant audio (in Chrome 156)
 * only with the codec it carries. Empty when nothing is kept. A payload is matched by
 * its lines, which the stack took from the template, as the capabilities
 * were.
 */
function preferredFormats(
	formats: string[],
	own: Payloads,
	fmtpOf: (pt: string) => string | undefined,
	kind: string,
	codecs: CodecCapability[],
	legacy = false,
): string[] {
	const nameOf = (pt: string) =>
		(own.map.get(pt) ?? '').split('/')[0].toLowerCase();
	const subtype = (codec: CodecCapability) =>
		codec.mimeType.slice(codec.mimeType.indexOf('/') + 1).toLowerCase();
	const describes = (pt: string, codec: CodecCapability) => {
		const [name, clock, channels] = (own.map.get(pt) ?? '').split('/');
		const lower = name.toLowerCase();
		if (lower !== subtype(codec) || Number(clock) !== codec.clockRate)
			return false;
		if (
			(kind === 'audio' ? Number(channels || 1) : undefined) !== codec.channels
		)
			return false;
		// the capabilities give these no format line: theirs names a payload
		if (lower === 'rtx' || lower === 'red') return true;
		return sameParameters(fmtpOf(pt), codec.sdpFmtpLine);
	};
	const kept: string[] = [];
	for (const codec of codecs)
		for (const pt of formats)
			if (nameOf(pt) !== 'rtx' && !kept.includes(pt) && describes(pt, codec))
				kept.push(pt);
	// Chrome 152 keeps redundant audio whatever it carries; 156 drops it
	// with the codec it carries
	const chosen = kept.filter((pt) => {
		const carried =
			nameOf(pt) === 'red' ? own.fmtp.get(pt)?.split('/')[0] : undefined;
		return legacy || carried === undefined || kept.includes(carried);
	});
	if (!codecs.some((codec) => subtype(codec) === 'rtx')) return chosen;
	return chosen.flatMap((pt) => [
		pt,
		...formats.filter(
			(repair) =>
				nameOf(repair) === 'rtx' &&
				/(?:^|;)\s*apt=(\d+)/.exec(own.fmtp.get(repair) ?? '')?.[1] === pt,
		),
	]);
}

/**
 * An answer with these preferences rejects the stack's section: none of
 * them was offered. `model` is the template's section of its kind.
 */
export function rejects(
	media: Media,
	model: Media | undefined,
	codecs: CodecCapability[] | undefined,
): boolean {
	if (!codecs?.length) return false;
	const own = payloadsOf(media);
	const browser = model ? payloadsOf(model) : own;
	const twin = twinOf(own, browser);
	const fmtpOf = (pt: string) => {
		const like = twin(pt);
		return like === undefined ? own.fmtp.get(pt) : browser.fmtp.get(like);
	};
	return !preferredFormats(media.formats, own, fmtpOf, media.kind, codecs)
		.length;
}

/**
 * A media section's payload list and the lines after `a=mid`, as Chrome
 * writes them. `media` is the stack's section, `model` the template's of
 * the same kind, `offered` the section of the offer this one answers.
 *
 * - Header extensions: the template's, in its order, under the ids the
 *   stack has them at (an answer uses the offer's ids), and after a
 *   negotiation only the ones it agreed on.
 * - Payloads: an offer lists them in the stack's order with redundant
 *   audio after the codec it carries (the stack lists it before), an answer
 *   in the offer's order. Each one's feedback is what the template names
 *   for that codec, and in an answer what the offer names too; a format
 *   line is written where the template has one.
 * - The lines the template has besides (`a=rtcp-rsize`, `a=rtcp-xr`): all
 *   of them in an offer, the ones the offer has in an answer.
 * - The sender: its `a=msid` and `a=ssrc` lines, under the connection's
 *   cname.
 */
function shaped(
	media: Media,
	model: Media,
	style: SectionStyle,
	offered: Media | null,
	names: { line: boolean; source: boolean },
	cname: string,
): { formats: string[]; lines: string[] } {
	const lines: string[] = [];
	const own = payloadsOf(media);
	const browser = payloadsOf(model);
	const theirs = offered && payloadsOf(offered);
	const ids = new Map<string, string>();
	for (const value of all(media.attributes, 'extmap')) {
		const [id, uri] = value.split(' ');
		if (uri) ids.set(uri, id.split('/')[0]);
	}
	for (const value of all(model.attributes, 'extmap')) {
		const uri = value.split(' ')[1];
		const id = ids.get(uri);
		if (id !== undefined && (!style.exts || style.exts.has(uri)))
			lines.push(`a=extmap:${id} ${uri}`);
	}
	lines.push(`a=${style.direction}`);
	const sender = style.sender;
	if (sender && names.line)
		for (const stream of sender.streams.length ? sender.streams : ['-'])
			lines.push(`a=msid:${stream} ${sender.track}`);
	lines.push('a=rtcp-mux');
	for (const [name, value] of model.attributes) {
		if (SHAPED.has(name)) continue;
		if (
			offered &&
			!offered.attributes.some(([key, said]) => key === name && said === value)
		)
			continue;
		lines.push(value === null ? `a=${name}` : `a=${name}:${value}`);
	}

	// the payloads, in Chrome's order
	const isRed = (pt: string) => /^red\//i.test(own.map.get(pt) ?? '');
	let formats: string[];
	if (offered) {
		const taken = new Set(media.formats);
		formats = offered.formats.filter((pt) => taken.has(pt));
		for (const pt of media.formats) if (!formats.includes(pt)) formats.push(pt);
	} else {
		const after = new Map<string, string>();
		for (const pt of media.formats) {
			const carried = isRed(pt) ? own.fmtp.get(pt)?.split('/')[0] : undefined;
			if (carried !== undefined && media.formats.includes(carried))
				after.set(carried, pt);
		}
		const moved = new Set(after.values());
		formats = [];
		for (const pt of media.formats) {
			if (moved.has(pt)) continue;
			formats.push(pt);
			const red = after.get(pt);
			if (red !== undefined) formats.push(red);
		}
	}
	const twin = twinOf(own, browser);
	// What the transceiver prefers, in its order. An answer that has none
	// of it rejects the section: its m= line lists the preferred codecs as
	// this browser numbers them, and no line says more of them.
	let listed = true;
	// a stopped section is offered with every codec, whatever is preferred
	if (style.codecs?.length && (media.port !== '0' || style.rejected)) {
		const chosen = preferredFormats(
			formats,
			own,
			(pt) => {
				const like = twin(pt);
				return like === undefined ? own.fmtp.get(pt) : browser.fmtp.get(like);
			},
			media.kind,
			style.codecs,
			style.legacy,
		);
		if (chosen.length) formats = chosen;
		else if (style.rejected) {
			formats = preferredFormats(
				model.formats,
				browser,
				(pt) => browser.fmtp.get(pt),
				media.kind,
				style.codecs,
				style.legacy,
			);
			listed = false;
		}
	}
	const named = (pt: string, value: string) =>
		!theirs ||
		[pt, '*'].some(
			(key) =>
				theirs.lead.get(key)?.includes(value) ||
				theirs.fb.get(key)?.includes(value),
		);
	for (const pt of listed ? formats : [])
		for (const value of browser.lead.get(twin(pt) ?? '') ?? [])
			if (named(pt, value)) lines.push(`a=rtcp-fb:${pt} ${value}`);
	for (const pt of listed ? formats : []) {
		const like = twin(pt);
		const map = like === pt ? browser.map.get(pt) : own.map.get(pt);
		if (map === undefined) continue;
		lines.push(`a=rtpmap:${pt} ${map}`);
		const feedback =
			like === undefined
				? (own.fb.get(pt) ?? [])
				: (browser.fb.get(like) ?? []).filter((value) => named(pt, value));
		for (const value of feedback) lines.push(`a=rtcp-fb:${pt} ${value}`);
		const fmtp = like === pt ? browser.fmtp.get(pt) : own.fmtp.get(pt);
		if (fmtp !== undefined && (like === undefined || browser.fmtp.has(like)))
			lines.push(`a=fmtp:${pt} ${fmtp}`);
	}
	if (sender) {
		for (const group of style.groups) lines.push(`a=ssrc-group:${group}`);
		for (const ssrc of style.ssrcs) {
			lines.push(`a=ssrc:${ssrc} cname:${cname}`);
			if (names.source)
				lines.push(
					`a=ssrc:${ssrc} msid:${sender.streams[0] ?? '-'} ${sender.track}`,
				);
		}
	}
	return { formats, lines };
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

/**
 * A remote offer as the stack reads it. Chrome takes an offer whose
 * sections have no name (each is named by its position), one that names no
 * BUNDLE group, and a data section over TCP/DTLS/SCTP, and its answer
 * mirrors the last two; the stack reads none of the three. Null for an
 * offer of no section at all, which is not the stack's to answer.
 */
export function offerForStack(
	offer: string,
): { sdp: string; grouped: boolean; protocols: (string | null)[] } | null {
	const lines = offer.split(/\r?\n/);
	const starts: number[] = [];
	for (let at = 0; at < lines.length; at++)
		if (lines[at].startsWith('m=')) starts.push(at);
	if (!starts.length) return null;
	const protocols: (string | null)[] = [];
	const mids: string[] = [];
	const rejected: boolean[] = [];
	// from the last section to the first: an inserted line moves none before it
	for (let index = starts.length - 1; index >= 0; index--) {
		const start = starts[index];
		const end = starts[index + 1] ?? lines.length;
		const fields = lines[start].split(' ');
		rejected[index] = fields[1] === '0';
		protocols[index] = null;
		if (fields[0] === 'm=application' && fields[2] === 'TCP/DTLS/SCTP') {
			protocols[index] = fields[2];
			fields[2] = 'UDP/DTLS/SCTP';
			lines[start] = fields.join(' ');
		}
		let named = -1;
		let last = start;
		for (let at = start + 1; at < end; at++) {
			if (lines[at].startsWith('a=mid:')) named = at;
			if (lines[at].startsWith('a=')) last = at;
		}
		const mid = named < 0 ? '' : lines[named].slice(6).trim();
		mids[index] = mid || String(index);
		// among the section's attributes: the stack reads none after a c= line
		if (named < 0) lines.splice(last + 1, 0, `a=mid:${mids[index]}`);
		else if (!mid) lines[named] = `a=mid:${mids[index]}`;
	}
	const grouped = lines
		.slice(0, starts[0])
		.some((line) => line.startsWith('a=group:BUNDLE'));
	// a rejected section (port 0) is in no bundle
	const bundled = mids.filter((_, index) => !rejected[index]);
	if (!grouped)
		lines.splice(starts[0], 0, `a=group:BUNDLE ${bundled.join(' ')}`.trim());
	return { sdp: lines.join(CRLF), grouped, protocols };
}

/**
 * A remote description for the stack: one whose sections are all stopped
 * has no bundle left and Chrome writes no `a=group` line, which the stack
 * insists on; it reads an empty one.
 */
export function withGroup(sdp: string): string {
	if (/^a=group:/m.test(sdp) || /^m=\S+ (?!0 )/m.test(sdp)) return sdp;
	const at = sdp.search(/^m=/m);
	return at === -1
		? sdp
		: `${sdp.slice(0, at)}a=group:BUNDLE${CRLF}${sdp.slice(at)}`;
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
 * The names of the m-sections this side creates. A section's name is what
 * its packets carry (the MID header extension), so the stack's name for a
 * section is the one both ends read, and for one this side offers first it
 * is the name Chrome would give: Chrome counts up from "0" and passes over
 * every number a description has used, its own or the peer's, and never
 * goes back (a section whose offer was rolled back gets the next number
 * when it is offered again). Pages lean on the names (a hard-coded
 * `sdpMid: '0'`).
 */
export class MidNames {
	#known = new Set<number>();
	/** the names of the next `count` sections this side creates */
	next(count: number): string[] {
		const names: string[] = [];
		for (let number = 0; names.length < count; number++)
			if (!this.#known.has(number)) names.push(String(number));
		return names;
	}
	/** a description, made here or set: the numbers among its names are used */
	saw(sdp: string) {
		for (const raw of sdp.split(/\r?\n/)) {
			if (!raw.startsWith('a=mid:')) continue;
			const name = raw.slice(6).trim();
			if (/^\d{1,9}$/.test(name)) this.#known.add(Number(name));
		}
	}
}
