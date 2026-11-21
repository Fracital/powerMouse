// The verbose mode's stage traces of WebTransport (transportLog.ts,
// docs/webtransport.md "Tracing a session"): a proxied page's session
// (webTransportHost.ts) and the wisp connection's own session to the relay
// (wispWebTransport.ts) each say, in one `[wt]` line once they are up or
// have failed, which stage they reached and which one failed:
//
// - carrier: what the wisp connection rides to the relay, and for the
//   relay's own session its discovery, handshake, Wisp stream and first
//   packet;
// - udp: the Wisp UDP stream to the server, and the relay's close reason
//   when it refused or closed it;
// - quic: the QUIC and TLS handshake (stomp-h3: QUIC v1, ALPN h3, TLS 1.3
//   are all it offers), a version, ALPN or certificate failure named;
// - h3: the server's SETTINGS (H3_DATAGRAM, ENABLE_WEBTRANSPORT) and the
//   extended CONNECT's answer;
// - page: what the page's session reads, in Chrome's words.
//
// Nothing of the page's goes in a line: the server's origin (never its
// path, query, headers or protocols), counts, times, codes and the
// transport's own error text, cut to printable ASCII. Each line is
// bounded, and so is how many a realm makes in a minute. While the mode is
// off no trace is made (a call site gets null).
import { logTransport, transportLog } from './transportLog';

/** the stages, in the order a session goes through them */
export type Stage = 'setup' | 'carrier' | 'udp' | 'quic' | 'h3' | 'page';

/** the most steps one trace keeps; one past it says how many were left out */
const MAX_STEPS = 12;
/** the most characters of one step */
const MAX_STEP = 240;
/** the most characters of one line */
const MAX_LINE = 2000;
/** the most traces a realm makes in TRACE_WINDOW_MS */
const TRACE_BUDGET = 32;
const TRACE_WINDOW_MS = 60_000;

let windowStart = 0;
let windowCount = 0;
let windowDropped = 0;
let made = 0;

/** printable ASCII only, cut to `max` */
export function clean(text: unknown, max = MAX_STEP): string {
	const flat = String(text)
		.replace(/[^\x20-\x7e]+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** a URL as a line may name it: its origin only */
export function originOf(url: string | URL): string {
	try {
		return new URL(String(url)).origin;
	} catch {
		return '(not a URL)';
	}
}

/** whether one more trace fits this minute's budget (a note says how many did not) */
function admit(): boolean {
	const now = performance.now();
	if (now - windowStart >= TRACE_WINDOW_MS) {
		if (windowDropped)
			logTransport(
				`[wt] ${windowDropped} more WebTransport traces were left out in the last minute (at most ${TRACE_BUDGET} a minute)`,
			);
		windowStart = now;
		windowCount = 0;
		windowDropped = 0;
	}
	if (windowCount >= TRACE_BUDGET) {
		windowDropped++;
		return false;
	}
	windowCount++;
	return true;
}

/** one session's stages, told once it is up or has failed */
export class StageTrace {
	readonly id = ++made;
	readonly #title: string;
	readonly #start = performance.now();
	readonly #steps: string[] = [];
	#left = 0;
	#failed: { stage: Stage; why: string } | null = null;
	#told = false;

	constructor(title: string) {
		this.#title = clean(title);
	}

	/** milliseconds since the trace began */
	get ms() {
		return Math.round(performance.now() - this.#start);
	}

	/** a stage that went as it should, or what it found */
	step(stage: Stage, text: string) {
		if (this.#steps.length >= MAX_STEPS) {
			this.#left++;
			return;
		}
		this.#steps.push(`${stage} +${this.ms} ms: ${clean(text)}`);
	}

	/** the stage that failed (the first one told is the one named) */
	fail(stage: Stage, why: string) {
		this.#failed ??= { stage, why: clean(why, 160) };
		this.step(stage, why);
	}

	get failed(): Stage | null {
		return this.#failed?.stage ?? null;
	}

	/** the line, once: `up` (the session is up) or failed at the stage told */
	tell(outcome?: string) {
		if (this.#told) return;
		this.#told = true;
		if (!transportLog.on) return;
		const head = this.#failed
			? `failed at ${this.#failed.stage} (${this.#failed.why}) after ${this.ms} ms`
			: `up in ${this.ms} ms${outcome ? ` (${clean(outcome, 120)})` : ''}`;
		const steps = this.#left
			? [...this.#steps, `(${this.#left} more steps left out)`]
			: this.#steps;
		const line = `[wt] #${this.id} ${this.#title} ${head}: ${steps.join(' | ')}`;
		logTransport(
			line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 3)}...` : line,
		);
	}
}

/** a trace when the verbose mode is on and the minute's budget allows one, else null */
export function startTrace(title: string): StageTrace | null {
	if (!transportLog.on || !admit()) return null;
	return new StageTrace(title);
}

/**
 * The wisp close reasons (Wisp 2.0's table), as a line names them: what
 * the relay said when it closed or refused a stream
 */
const WISP_REASONS: Record<number, string> = {
	0x01: 'unspecified',
	0x02: 'closed voluntarily',
	0x03: 'network error',
	0x04: 'incompatible extensions',
	0x41: 'invalid destination (the CONNECT was refused as malformed)',
	0x42: 'destination unreachable',
	0x43: 'destination timed out',
	0x44: 'destination refused the connection',
	0x47: 'TCP data transfer timed out',
	0x48: 'destination blocked by the relay (or the relay relays no UDP)',
	0x49: 'throttled by the relay (too many streams or connects)',
	0x81: 'client error',
	0xc0: 'authentication failed (password)',
	0xc1: 'authentication failed (key)',
	0xc2: 'authentication required',
	0xc3: 'authentication method unsupported',
};

/** `0x48 (destination blocked ...)` */
export function wispReason(reason: number): string {
	const hex = `0x${reason.toString(16).padStart(2, '0')}`;
	return `${hex} (${WISP_REASONS[reason] ?? 'a reason Wisp does not define'})`;
}

/** TLS alerts a QUIC handshake names (RFC 8446 6, RFC 7301) */
const TLS_ALERTS: Record<number, string> = {
	40: 'handshake_failure',
	42: 'bad_certificate',
	43: 'unsupported_certificate',
	44: 'certificate_revoked',
	45: 'certificate_expired',
	46: 'certificate_unknown',
	47: 'illegal_parameter',
	48: 'unknown_ca',
	50: 'decode_error',
	51: 'decrypt_error',
	70: 'protocol_version',
	80: 'internal_error',
	109: 'missing_extension',
	110: 'unsupported_extension',
	112: 'unrecognized_name',
	116: 'certificate_required',
	120: 'no_application_protocol',
};

/** the stage a stomp-h3 handshake rejection names, and what it says of it */
export function handshakeStage(error: string): { stage: Stage; why: string } {
	const text = error.replace(/^handshake:\s*/, '');
	if (/datagram channel closed/.test(text))
		return {
			stage: 'udp',
			why: 'the Wisp UDP stream closed during the handshake',
		};
	if (/^timed out$/.test(text))
		return {
			stage: 'quic',
			why: 'no QUIC answer from the server within the handshake timeout',
		};
	if (/supported version/i.test(text))
		return {
			stage: 'quic',
			why: `QUIC version: the server takes no version stomp-h3 offers (v1) (${text})`,
		};
	if (
		/invalid peer certificate|certificate|UnknownIssuer|NotValidFor/i.test(text)
	)
		return { stage: 'quic', why: `TLS certificate: ${text}` };
	const alert = /cryptographic handshake failed: error (\d+)/.exec(text);
	if (alert) {
		const code = Number(alert[1]);
		const name = TLS_ALERTS[code] ?? `alert ${code}`;
		const why =
			code === 120
				? 'ALPN: the server takes no h3 (no_application_protocol)'
				: code === 42 || (code >= 43 && code <= 46) || code === 48
					? `TLS certificate: ${name}`
					: `TLS: ${name}`;
		return { stage: 'quic', why: `${why} (${text})` };
	}
	if (/SETTINGS lack|before SETTINGS/.test(text))
		return { stage: 'h3', why: `SETTINGS: ${text}` };
	const status = /^status (\S+)/.exec(text);
	if (status)
		return {
			stage: 'h3',
			why: `extended CONNECT answered :status ${status[1]} (only 200 is a session)`,
		};
	if (
		/control stream|QPACK|CONNECT|response|frame|field section|stream reset|truncated/.test(
			text,
		)
	)
		return { stage: 'h3', why: text };
	if (/no host|URL/.test(text)) return { stage: 'setup', why: text };
	// quinn's other ends of a connection (the peer's close, a reset, the
	// connection lost) come before HTTP/3 begins only in the handshake
	return { stage: 'quic', why: text };
}
