/**
 * What Chrome says to a bad RTCPeerConnection configuration, data channel
 * dictionary, remote description or candidate, without a connection of the
 * browser's to ask: its conversions of the dictionaries (members read in
 * name order), Blink's checks of the ICE servers, WebRTC's parsers of an
 * ICE server URL, a session description and a candidate line, and its
 * checks of a remote description. Every text here was measured on Chrome
 * 152 and 156 (webrtc suite: the same calls natively and proxied).
 */

/** an error of the browser's: `name` is TypeError or a DOMException name */
export class Refusal {
	constructor(
		public name: string,
		public message: string,
	) {}
}
const refuse = (message: string, name = 'TypeError'): never => {
	throw new Refusal(name, message);
};

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
	(typeof value === 'object' && value !== null) || typeof value === 'function';

/** a UTF-8 length, as the browser measures a label */
export const utf8Length = (text: string) => {
	let length = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) length += 1;
		else if (unit < 0x800) length += 2;
		else if (
			unit >= 0xd800 &&
			unit < 0xdc00 &&
			(text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
		) {
			length += 4;
			i++;
		} else length += 3;
	}
	return length;
};

// --- WebIDL ---

/** a USVString: a surrogate without its pair reads U+FFFD */
const wellFormed = (text: string) =>
	text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		'\uFFFD',
	);

/** an integer type with [EnforceRange] */
const enforced = (value: unknown, max: number, type: string): number => {
	const number = +(value as number);
	if (number !== number) refuse(`Value is not of type '${type}'.`);
	if (number === Infinity || number === -Infinity)
		refuse(`Value is infinite and not of type '${type}'.`);
	const whole = Math.trunc(number);
	if (whole < 0 || whole > max)
		refuse(`Value is outside the '${type}' value range.`);
	return whole + 0;
};
/** unsigned short without it: modulo 65536 */
const wrapped = (value: unknown) => (+(value as number) & 0xffff) >>> 0;
const enumerated = (value: unknown, values: string[], type: string) => {
	const text = `${value as string}`;
	if (!values.includes(text))
		refuse(
			`The provided value '${text}' is not a valid enum value of type ${type}.`,
		);
	return text;
};
const sequence = <T>(value: unknown, each: (item: unknown) => T): T[] => {
	if (!isObject(value))
		return refuse('The provided value cannot be converted to a sequence.');
	const method = value[Symbol.iterator];
	if (typeof method !== 'function')
		return refuse('The object must have a callable @@iterator property.');
	const iterator = Reflect.apply(method, value, []) as Iterator<unknown>;
	const next = iterator.next;
	const out: T[] = [];
	for (;;) {
		const step = Reflect.apply(next, iterator, []) as IteratorResult<unknown>;
		if (step.done) return out;
		out.push(each(step.value));
	}
};
/** the members of a dictionary, each read once, in the order asked */
const reader = (source: Record<PropertyKey, unknown>, dictionary: string) => {
	return <T>(name: string, convert: (value: unknown) => T): T | undefined => {
		const value = source[name];
		if (value === undefined) return undefined;
		try {
			return convert(value);
		} catch (error) {
			if (error instanceof Refusal)
				error.message = `Failed to read the '${name}' property from '${dictionary}': ${error.message}`;
			throw error;
		}
	};
};

// --- RTCConfiguration ---

export interface IceServer {
	credential: string;
	urls: string[];
	username: string;
}
export interface Configuration {
	alwaysNegotiateDataChannels: boolean;
	bundlePolicy: string;
	certificates: unknown[];
	encodedInsertableStreams: boolean;
	iceCandidatePoolSize: number;
	iceServers: IceServer[];
	iceTransportPolicy: string;
	rtcpMuxPolicy: string;
}
interface RawServer {
	credential?: string;
	url?: string;
	urls?: string[];
	username?: string;
}

const POLICIES = ['all', 'relay'];

/**
 * A page's configuration as the browser converts and checks it, before
 * WebRTC reads the servers (`serversRefusal`). `legacy`: the browser still
 * reads `iceTransports`. `expires`: an RTCCertificate's expiry, which
 * throws for anything else.
 */
export function configuration(
	config: unknown,
	legacy: boolean,
	expires: (certificate: unknown) => number,
): Configuration {
	if (config !== undefined && config !== null && !isObject(config))
		refuse("The provided value is not of type 'RTCConfiguration'.");
	const read = reader(
		(config ?? {}) as Record<string, unknown>,
		'RTCConfiguration',
	);
	const alwaysNegotiateDataChannels = read(
		'alwaysNegotiateDataChannels',
		Boolean,
	);
	const bundlePolicy = read('bundlePolicy', (value) =>
		enumerated(
			value,
			['balanced', 'max-compat', 'max-bundle'],
			'RTCBundlePolicy',
		),
	);
	const certificates = read('certificates', (value) =>
		sequence(value, (certificate) => {
			try {
				expires(certificate);
			} catch (error) {
				refuse("Failed to convert value to 'RTCCertificate'.");
			}
			return certificate;
		}),
	);
	const encodedInsertableStreams = read('encodedInsertableStreams', Boolean);
	const iceCandidatePoolSize = read('iceCandidatePoolSize', (value) =>
		enforced(value, 255, 'octet'),
	);
	const raw = read('iceServers', (value) =>
		sequence(value, (server): RawServer => {
			if (server === undefined || server === null) return {};
			if (!isObject(server))
				return refuse("The provided value is not of type 'RTCIceServer'.");
			const member = reader(server, 'RTCIceServer');
			const text = (value: unknown) => `${value as string}`;
			const credential = member('credential', text);
			const url = member('url', text);
			const urls = member('urls', (value) =>
				isObject(value) &&
				value[Symbol.iterator] !== undefined &&
				value[Symbol.iterator] !== null
					? sequence(value, text)
					: [text(value)],
			);
			const username = member('username', text);
			return { credential, url, urls, username };
		}),
	);
	const policy = read('iceTransportPolicy', (value) =>
		enumerated(value, POLICIES, 'RTCIceTransportPolicy'),
	);
	const transports = legacy
		? read('iceTransports', (value) =>
				enumerated(value, POLICIES, 'RTCIceTransportPolicy'),
			)
		: undefined;
	const rtcpMuxPolicy = read('rtcpMuxPolicy', (value) =>
		enumerated(value, ['require', 'negotiate'], 'RTCRtcpMuxPolicy'),
	);

	const iceServers: IceServer[] = [];
	for (const server of raw ?? []) {
		const list =
			server.urls ?? (server.url !== undefined ? [server.url] : null);
		if (!list) return refuse('Malformed RTCIceServer');
		const urls: string[] = [];
		for (const text of list) {
			let url: URL;
			try {
				url = new URL(text);
			} catch (error) {
				return refuse(`'${text}' is not a valid URL.`, 'SyntaxError');
			}
			const query = url.search.slice(1);
			const turn = url.protocol === 'turn:' || url.protocol === 'turns:';
			let valid = query === '';
			if (turn && !valid) {
				const parts = query.split('=').filter((part) => part !== '');
				valid = parts.length >= 2 && parts[0] === 'transport';
			}
			if (!turn && url.protocol !== 'stun:' && url.protocol !== 'stuns:')
				valid = false;
			if (!valid)
				refuse(`'${text}' is not a valid stun or turn URL.`, 'SyntaxError');
			if (
				turn &&
				(server.username === undefined || server.credential === undefined)
			)
				refuse(
					'Both username and credential are required when the URL scheme is "turn" or "turns".',
					'InvalidAccessError',
				);
			urls.push(url.href);
		}
		iceServers.push({
			credential: server.credential ?? '',
			urls,
			username: server.username ?? '',
		});
	}
	const now = Date.now();
	for (const certificate of certificates ?? [])
		if (expires(certificate) <= now)
			refuse('Expired certificate(s).', 'InvalidAccessError');
	return {
		alwaysNegotiateDataChannels: alwaysNegotiateDataChannels ?? false,
		bundlePolicy: bundlePolicy ?? 'balanced',
		certificates: certificates ?? [],
		encodedInsertableStreams: encodedInsertableStreams ?? false,
		iceCandidatePoolSize: iceCandidatePoolSize ?? 0,
		iceServers,
		iceTransportPolicy: policy ?? transports ?? 'all',
		rtcpMuxPolicy: rtcpMuxPolicy ?? 'require',
	};
}

// a host of an ICE server URL: RFC 3986's reg-name
const HOST = /^[A-Za-z0-9!$%&'()*+,\-.;=_~]+$/;

/** what WebRTC says to the servers of a converted configuration, or null */
export function serversRefusal(servers: IceServer[]): Refusal | null {
	const syntax = (what: string) =>
		new Refusal('SyntaxError', `ICE server parsing failed: ${what}`);
	const invalid = (what: string) =>
		new Refusal('InvalidAccessError', `ICE server parsing failed: ${what}`);
	for (const server of servers) {
		if (!server.urls.length) return syntax('Empty uri.');
		for (const url of server.urls) {
			const tokens = url.split('?');
			if (tokens.length === 2) {
				const pair = tokens[1].split('=');
				if (pair[0] !== 'transport')
					return syntax('Invalid transport parameter key.');
				if (!/^(?:udp|tcp)$/i.test(pair[1] ?? ''))
					return syntax('Transport parameter should always be udp or tcp.');
			}
			const colon = tokens[0].indexOf(':');
			const scheme = tokens[0].slice(0, colon);
			const rest = tokens[0].slice(colon + 1);
			if (!rest) return syntax('Invalid transport parameter in ICE URI');
			if (rest.includes('@'))
				return syntax('Invalid url with long deprecated user@host syntax');
			const format = syntax('Invalid hostname format');
			let host: string;
			let port: string | null = null;
			if (rest[0] === '[') {
				const close = rest.lastIndexOf(']');
				if (close < 0) return format;
				if (rest.indexOf(':', close) >= 0) port = rest.slice(close + 2);
				host = rest.slice(1, close);
				if (!host) return format;
			} else {
				const at = rest.indexOf(':');
				host = at < 0 ? rest : rest.slice(0, at);
				if (at >= 0) port = rest.slice(at + 1);
				if (!host) return format;
			}
			if (port !== null) {
				if (port === '') return format;
				if (!/^\d+$/.test(port)) return syntax('Invalid port');
				if (port.length > 10 || +port > 0x7fffffff) return format;
			}
			if (rest[0] !== '[' && !HOST.test(host)) return format;
			if (port !== null && (+port < 1 || +port > 65535))
				return syntax('Invalid port');
			if (scheme === 'turn' || scheme === 'turns') {
				if (!server.username || !server.credential)
					return invalid('TURN server with empty username or password');
				if (utf8Length(server.username) > 509)
					return invalid('TURN server username is too long');
			}
		}
	}
	return null;
}

// --- RTCDataChannelInit ---

export interface ChannelInit {
	label: string;
	ordered: boolean;
	maxPacketLifeTime: number | null;
	maxRetransmits: number | null;
	protocol: string;
	negotiated: boolean;
	id: number | null;
}

/** the dictionary alone: what is wrong with it is said before a closed connection is */
export function channelInit(
	label: unknown,
	init: unknown,
	enforce: boolean,
): ChannelInit {
	const name = wellFormed(`${label as string}`);
	if (init !== undefined && init !== null && !isObject(init))
		refuse("The provided value is not of type 'RTCDataChannelInit'.");
	const read = reader(
		(init ?? {}) as Record<string, unknown>,
		'RTCDataChannelInit',
	);
	const short = (value: unknown) =>
		enforce ? enforced(value, 65535, 'unsigned short') : wrapped(value);
	const id = read('id', (value) => enforced(value, 65535, 'unsigned short'));
	const maxPacketLifeTime = read('maxPacketLifeTime', short);
	const maxRetransmits = read('maxRetransmits', short);
	const negotiated = read('negotiated', Boolean) ?? false;
	const ordered = read('ordered', Boolean) ?? true;
	const protocol =
		read('protocol', (value) => wellFormed(`${value as string}`)) ?? '';
	return {
		label: name,
		ordered,
		maxPacketLifeTime: maxPacketLifeTime ?? null,
		maxRetransmits: maxRetransmits ?? null,
		protocol,
		negotiated,
		id: id ?? null,
	};
}
/** the checks of createDataChannel itself, on an open connection */
export function channelChecked(init: ChannelInit): ChannelInit {
	if (utf8Length(init.label) > 65535) refuse('RTCDataChannel label too long');
	if (utf8Length(init.protocol) > 65535)
		refuse('RTCDataChannel protocol too long');
	if (init.negotiated && init.id === null)
		refuse('RTCDataChannel must have id set if negotiated is true');
	if (init.maxPacketLifeTime !== null && init.maxRetransmits !== null)
		refuse('RTCDataChannel cannot have both max retransmits and max lifetime');
	if (init.id !== null && init.id > 65534)
		refuse('RTCDataChannel cannot have id > 65534');
	return init.negotiated ? init : { ...init, id: null };
}

// --- session descriptions ---

export interface Section {
	kind: 'data' | 'audio' | 'video' | 'unsupported';
	mid: string;
	rejected: boolean;
	rtp: boolean;
	mux: boolean;
	ufrag: string;
	pwd: string;
	fingerprint: boolean;
	/** a=setup, lower case, or '' */
	setup: string;
}
export interface Description {
	sections: Section[];
	/** the mids of each BUNDLE group */
	bundles: string[][];
}
/** where WebRTC's parser stopped: the line, and what it says of it */
export interface ParseFailure {
	line: string;
	description: string;
}

/** a decimal integer as WebRTC reads one (an int), or null */
const integer = (text: string): number | null =>
	/^-?\d+$/.test(text) && Math.abs(+text) <= 0x7fffffff ? +text : null;
const unsigned = (text: string, max: number): number | null =>
	/^\d+$/.test(text) && +text <= max ? +text : null;
/** the value of `a=name:value`, or null without a colon */
const valueOf = (line: string): string | null => {
	const colon = line.indexOf(':');
	return colon < 0 ? null : line.slice(colon + 1);
};

/**
 * A candidate line (with or without `a=`) as the browser writes it back in
 * a description, or what its parser says is wrong with it.
 */
export function candidateLine(text: string): string | ParseFailure {
	let line = text;
	const end = line.indexOf('\n');
	if (end >= 0) line = line.slice(0, end);
	if (line.endsWith('\r')) line = line.slice(0, -1);
	const fail = (description: string) => ({ line, description });
	const body = line.startsWith('a=') ? line.slice(2) : line;
	if (!body.startsWith('candidate:'))
		return fail('Expect line: candidate:<candidate-str>');
	const fields = body.slice(10).split(' ');
	if (fields.length < 8 || fields[6] !== 'typ')
		return fail('Expect at least 8 fields.');
	const number = (field: string, max = 0) =>
		max ? unsigned(field, max) : integer(field);
	const bad = (field: string) => fail(`Invalid value: ${field}.`);
	const component = number(fields[1]);
	if (component === null) return bad(fields[1]);
	const priority = number(fields[3], 0xffffffff);
	if (priority === null) return bad(fields[3]);
	let port = number(fields[5]);
	if (port === null) return bad(fields[5]);
	if (port < 0 || port > 65535) return fail('Invalid port');
	const protocol = fields[2].toLowerCase();
	if (protocol !== 'udp' && protocol !== 'tcp' && protocol !== 'ssltcp')
		return fail('Unsupported transport type');
	const type = fields[7];
	if (
		type !== 'host' &&
		type !== 'srflx' &&
		type !== 'relay' &&
		type !== 'prflx'
	)
		return fail('Unsupported candidate type');
	let at = 8;
	let related = '';
	const follows = (name: string) =>
		fields.length >= at + 2 && fields[at] === name;
	if (follows('raddr')) {
		related = ` raddr ${fields[at + 1]} rport 0`;
		at += 2;
	}
	if (follows('rport')) {
		const rport = number(fields[at + 1]);
		if (rport === null) return bad(fields[at + 1]);
		if (rport < 0 || rport > 65535) return fail('Invalid port');
		related = `${related ? related.slice(0, -8) : ' raddr '} rport ${rport}`;
		at += 2;
	}
	let tcptype = '';
	if (follows('tcptype')) {
		tcptype = fields[at + 1];
		at += 2;
		if (tcptype !== 'active' && tcptype !== 'passive' && tcptype !== 'so')
			return fail('Invalid TCP candidate type');
		if (protocol === 'udp') return fail('Invalid non-TCP candidate');
	} else if (protocol !== 'udp') tcptype = 'passive';
	let generation = 0;
	let extensions = '';
	for (let i = at; i + 1 < fields.length; i += 2) {
		const name = fields[i];
		const value = fields[i + 1];
		if (name === 'generation') {
			const read = number(value, 0xffffffff);
			if (read === null) return bad(value);
			generation = read;
		} else if (name === 'network-id' || name === 'network-cost') {
			const read = number(value, 0xffff);
			if (read === null) return bad(value);
			if (read > 0)
				extensions += ` ${name} ${name === 'network-cost' ? Math.min(read, 999) : read}`;
		}
	}
	// an active TCP candidate has no port to connect to
	if (tcptype === 'active' && protocol === 'tcp') port = 9;
	return (
		`candidate:${fields[0]} ${component} ${protocol} ${priority} ${fields[4]} ${port} typ ${type}${related}` +
		`${protocol === 'tcp' ? ` tcptype ${tcptype}` : ''} generation ${generation}${extensions}`
	);
}

const DIGESTS = ['sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512'];
const ROLES = ['active', 'passive', 'actpass', 'holdconn'];

/** a description's text through WebRTC's parser: what the checks need of it, or where it stopped */
export function parseDescription(sdp: string): Description | ParseFailure {
	let pos = 0;
	const lineAt = (from: number) => {
		let end = sdp.indexOf('\n', from);
		if (end < 0) return sdp.slice(from);
		if (end > 0 && sdp[end - 1] === '\r') end--;
		return sdp.slice(from, Math.max(end, from));
	};
	const failHere = (description: string): ParseFailure => ({
		line: lineAt(pos),
		description,
	});
	/** the next line when it is one (`x=...`, no space after the sign but for s=) */
	const next = (type?: string): string | null => {
		const end = sdp.indexOf('\n', pos);
		if (end < 0) return null;
		const line = lineAt(pos);
		if (
			line.length < 2 ||
			line[0] < 'a' ||
			line[0] > 'z' ||
			line[1] !== '=' ||
			(line[0] !== 's' && line[2] === ' ') ||
			(type && line[0] !== type)
		)
			return null;
		pos = end + 1;
		return line;
	};
	const has = (line: string, name: string) => line.startsWith(name, 2);
	const connection = (line: string): string | null => {
		const fields = line.slice(2).split(/ +/);
		if (fields[0] !== 'IN')
			return 'Failed to parse the connection data. The network type is not currently supported.';
		if (fields.length < 3) return 'Failed to parse the address type.';
		if (fields[2].includes('/'))
			return 'Failed to parse the connection data. Multicast is not currently supported.';
		return null;
	};
	interface Transport {
		ufrag: string;
		pwd: string;
		fingerprint: boolean;
		setup: string;
	}
	/** an attribute both levels have: what is wrong with it, null, or undefined when it is none of them */
	const transport = (
		line: string,
		into: Transport,
	): string | null | undefined => {
		const value = valueOf(line);
		const missing = (name: string) =>
			`Failed to get the value of attribute: ${name}`;
		if (has(line, 'ice-ufrag')) {
			if (value === null) return missing('ice-ufrag');
			into.ufrag = value;
		} else if (has(line, 'ice-pwd')) {
			if (value === null) return missing('ice-pwd');
			into.pwd = value;
		} else if (has(line, 'ice-options')) {
			if (value === null) return missing('ice-options');
		} else if (has(line, 'fingerprint')) {
			const fields = line.slice(2).split(' ');
			if (fields.length !== 2) return 'Expects 2 fields.';
			const digest = fields[1];
			if (
				!DIGESTS.includes((valueOf(fields[0]) ?? '').toLowerCase()) ||
				!/^[0-9a-f]{2}(?::[0-9a-f]{2}){0,63}$/i.test(digest)
			)
				return 'Failed to create fingerprint from the digest.';
			into.fingerprint = true;
		} else if (has(line, 'setup')) {
			if (value === null) return missing('setup');
			if (!ROLES.includes(value.toLowerCase()))
				return 'Invalid attribute value.';
			into.setup = value.toLowerCase();
		} else return undefined;
		return null;
	};

	if (next('v') === null) return failHere('Expect line: v=');
	let line = next('o');
	if (line === null) return failHere('Expect line: o=');
	if (line.slice(2).split(' ').length !== 6)
		return { line, description: 'Expects 6 fields.' };
	if (next('s') === null) return failHere('Expect line: s=');
	for (const type of 'iuep') next(type);
	if ((line = next('c')) !== null) {
		const wrong = connection(line);
		if (wrong) return { line, description: wrong };
	}
	while (next('b') !== null);
	if (next('t') === null) return failHere('Expect line: t=');
	while (next('r') !== null);
	while (next('t') !== null) while (next('r') !== null);
	next('z');
	next('k');
	const session: Transport = {
		ufrag: '',
		pwd: '',
		fingerprint: false,
		setup: '',
	};
	const bundles: string[][] = [];
	while ((line = next('a')) !== null) {
		if (has(line, 'group')) {
			const fields = line.slice(2).split(' ');
			if (valueOf(fields[0]) === 'BUNDLE') bundles.push(fields.slice(1));
			continue;
		}
		if (has(line, 'fingerprint') && session.fingerprint)
			return {
				line,
				description:
					"Can't have multiple fingerprint attributes at the same level.",
			};
		const wrong = transport(line, session);
		if (wrong) return { line, description: wrong };
	}

	const sections: Section[] = [];
	while ((line = next('m')) !== null) {
		const fields = line.slice(2).split(' ');
		const fail = (description: string): ParseFailure => ({
			line: line!,
			description,
		});
		if (fields.length < 4) return fail('Expects at least 4 fields.');
		const port = integer(fields[1]);
		if (port === null || port < 0 || port > 65535)
			return fail('The port number is invalid');
		const protocol = fields[2];
		const at = protocol.indexOf('RTP/');
		const rtp =
			protocol === '' ||
			at === 0 ||
			(at > 0 && !/[A-Za-z]/.test(protocol[at - 1]));
		if (rtp)
			for (const format of fields.slice(3))
				if (integer(format) === null) return fail(`Invalid value: ${format}.`);
		const media = fields[0] === 'audio' || fields[0] === 'video';
		if (media && !rtp) return fail('Unsupported protocol for media type');
		const data =
			fields[0] === 'application' &&
			/^(?:(?:UDP|TCP)\/)?DTLS\/SCTP$/.test(protocol);
		// the old form names the port in the m= line and an a=sctpmap
		const sctpmap =
			integer(fields[3]) !== null || fields[3] !== 'webrtc-datachannel';
		const section: Section & { bundleOnly: boolean } = {
			kind: data ? 'data' : media ? (fields[0] as 'audio') : 'unsupported',
			mid: '',
			rejected: false,
			rtp,
			mux: false,
			bundleOnly: false,
			...session,
		};
		while (!(sdp[pos] === 'm' && sdp[pos + 1] === '=')) {
			const inner = next();
			if (inner === null) {
				if (pos >= sdp.length) break;
				return failHere('Invalid SDP line.');
			}
			const here = (description: string): ParseFailure => ({
				line: inner,
				description,
			});
			if (inner[0] === 'c') {
				const wrong = connection(inner);
				if (wrong) return here(wrong);
			}
			if (inner[0] !== 'a') continue;
			const value = valueOf(inner);
			if (has(inner, 'mid')) {
				if (value === null)
					return here('Failed to get the value of attribute: mid');
				section.mid = value;
			} else if (has(inner, 'bundle-only')) section.bundleOnly = true;
			else if (has(inner, 'candidate')) {
				const read = candidateLine(inner);
				if (typeof read !== 'string') return here(read.description);
			} else {
				const wrong = transport(inner, section);
				if (wrong) return here(wrong);
				if (wrong === null) continue;
				if (data && has(inner, 'sctp-port')) {
					if (sctpmap)
						return here("sctp-port attribute can't be used with sctpmap.");
					const read = integer(value ?? '');
					if (read === null || read < 0 || read > 65535)
						return here('Invalid sctp port value.');
				} else if (data && has(inner, 'max-message-size')) {
					if (integer(value ?? '') === null)
						return here('Invalid SCTP max message size.');
				} else if (rtp && has(inner, 'rtcp-mux')) section.mux = true;
			}
		}
		// a port of zero rejects the section, unless it is only bundled
		section.rejected =
			section.kind === 'unsupported' || (port === 0 && !section.bundleOnly);
		// one without a name, or with an empty one, is named by its position
		if (!section.mid) section.mid = String(sections.length);
		sections.push(section);
	}
	if (!sections.length && pos !== sdp.length)
		return failHere('Expects m line.');
	return { sections, bundles };
}

const iceRefusal = (section: Section): string | null => {
	const chars = /^[A-Za-z0-9+/\-=#_]*$/;
	const sized = (text: string, least: number) =>
		text.length >= least && text.length <= 256;
	if (!sized(section.ufrag, 4))
		return 'ICE ufrag must be between 4 and 256 characters long.';
	if (!sized(section.pwd, 22))
		return 'ICE pwd must be between 22 and 256 characters long.';
	for (const [name, text] of [
		['ufrag', section.ufrag],
		['pwd', section.pwd],
	])
		if (!chars.test(text))
			return `ICE ${name} must contain only alphanumeric characters, '+', and '/'.`;
	return null;
};

/**
 * What WebRTC says to a parsed remote description once the signaling
 * state allows it (after "Failed to set remote <type> sdp: "), or null.
 * `local` and `remote` are the descriptions in force (pending over
 * current); an answer is read against `local`, the offer it answers.
 */
export function remoteRefusal(
	description: Description,
	offer: boolean,
	local: Description | null,
	remote: Description | null,
): string | null {
	const { sections, bundles } = description;
	const mids = new Set<string>();
	for (const { mid } of sections) {
		if (mid && mids.has(mid)) return `Duplicate a=mid value '${mid}'.`;
		mids.add(mid);
	}
	const group = (mid: string) => bundles.find((names) => names.includes(mid));
	/** a section with a transport of its own */
	const carries = (section: Section) => {
		const names = group(section.mid);
		return !section.rejected && (!names || names[0] === section.mid);
	};
	for (const section of sections)
		if (carries(section) && !section.fingerprint)
			return 'Called with SDP without DTLS fingerprint.';
	for (const section of sections)
		if (carries(section) && (!section.ufrag || !section.pwd))
			return 'Called with SDP without ice-ufrag and ice-pwd.';
	for (const section of sections)
		if (
			group(section.mid) &&
			!section.rejected &&
			section.rtp &&
			section.kind !== 'unsupported' &&
			!section.mux
		)
			return 'rtcp-mux must be enabled when BUNDLE is enabled.';
	const ordered = (existing: Description, other: Description | null) => {
		if (sections.length < existing.sections.length) return false;
		return existing.sections.every((known, index) => {
			const now = sections[index];
			const recycled =
				offer &&
				!now.rejected &&
				(known.rejected || other?.sections[index]?.rejected);
			return recycled || (now.mid === known.mid && now.kind === known.kind);
		});
	};
	if (!offer) {
		if (
			!local ||
			local.sections.length !== sections.length ||
			!ordered(local, null)
		)
			return "The order of m-lines in answer doesn't match order in offer. Rejecting answer.";
	} else {
		const current = local ?? remote;
		if (current && !ordered(current, local ? remote : null))
			return "The order of m-lines in subsequent offer doesn't match order from previous offer/answer.";
	}
	for (const names of bundles)
		for (const mid of names)
			if (!sections.some((section) => section.mid === mid))
				return `A BUNDLE group contains a MID='${mid}' matching no m= section.`;
	for (const section of sections) {
		if (!carries(section)) continue;
		const applying = `Failed to apply the description for m= section with mid='${section.mid}': `;
		if (section.rtp && section.kind !== 'unsupported' && !section.mux)
			return `The m= section with mid='${section.mid}' is invalid. RTCP-MUX is not enabled when it is required.`;
		const ice = iceRefusal(section);
		if (ice) return `${applying}Invalid ICE parameters: ${ice}`;
		if (!offer && section.setup !== 'active' && section.setup !== 'passive')
			return `${applying}Answerer must use either active or passive value for setup attribute.`;
	}
	return null;
}
