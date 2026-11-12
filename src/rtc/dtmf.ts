// DTMF on the wire (RFC 4733 telephone events), as Chrome's sender puts it
// there (docs/webrtc-over-wisp.md, section 16): a tone the page's
// RTCDTMFSender plays is an event on the section's telephone-event
// payload, and its packets go out in place of the audio frames of its
// time, one for each frame the encoder makes, all stamped with the time of
// the frame it started at and counting its duration up, then the last one
// three times with the end bit. WebRTC's RTPSenderAudio does exactly this,
// and so its arithmetic is kept here as it is (durations counted on the
// audio's clock, the length on the event payload's, which differ for Opus
// on telephone-event/8000, the payload Chrome picks when it is there).

/** the event code of each tone a page can play (RFC 4733, 3.2) */
export const TONES = '0123456789*#ABCD';

/** Chrome's events say they are 10 dB below the reference level */
const VOLUME = 10;
/** a tone starts no sooner than this many ms after the last one ended */
const PAUSE_MS = 50;
/** the largest duration one report holds (RFC 4733, 2.5.2.3) */
const MAX_UNITS = 0xffff;
/** the end report is sent this many times */
const END_REPEATS = 3;

/** a telephone-event packet to send in place of an audio frame */
export interface TonePacket {
	/** the RTP time the event (or its segment) started at, on the wire's clock */
	time: number;
	marker: boolean;
	payload: Uint8Array;
}

/**
 * The telephone-event payload a sender's events go on: the first of the
 * lowest clock the section negotiated, whatever the send codec's clock
 * (measured: Chrome 152 and 156 send Opus's events on telephone-event/8000
 * when the peer lists /48000 too, and count their durations at 48 kHz)
 */
export function eventPayload<T extends { name: string; clock: number }>(
	payloads: T[],
): T | null {
	let chosen: T | null = null;
	for (const payload of payloads)
		if (
			payload.name.toLowerCase() === 'telephone-event' &&
			(!chosen || payload.clock < chosen.clock)
		)
			chosen = payload;
	return chosen;
}

export class ToneSender {
	#queue: { code: number; ms: number }[] = [];
	/** the event under way: its start, its length in the event clock's units */
	#event: {
		code: number;
		start: number;
		length: number;
		firstSent: boolean;
	} | null = null;
	/** when the last event ended, on the caller's clock */
	#endedAt = -Infinity;

	/** a tone to play: its event code and how long, in ms */
	add(code: number, ms: number) {
		this.#queue.push({ code, ms });
	}

	/** events not started are dropped, and one under way ends */
	clear() {
		this.#queue = [];
		this.#event = null;
	}

	/**
	 * An audio frame is about to go out at `time` (on the wire's clock):
	 * the packets to send instead of it, or null when the frame goes out.
	 * `rate` is the event payload's clock, `now` the caller's ms.
	 */
	frame(time: number, rate: number, now: number): TonePacket[] | null {
		if (!this.#event && this.#queue.length && now - this.#endedAt > PAUSE_MS) {
			const next = this.#queue.shift()!;
			this.#event = {
				code: next.code,
				start: time,
				length: next.ms * (rate / 1000),
				firstSent: false,
			};
		}
		const event = this.#event;
		if (!event) return null;
		let duration = (time - event.start) >>> 0;
		let ended = false;
		if (event.length <= duration) {
			ended = true;
			this.#event = null;
			this.#endedAt = now;
		} else if (duration <= 0) return [];
		const out: TonePacket[] = [];
		const report = (start: number, units: number, marker: boolean) => {
			for (let sent = 0; sent < (ended ? END_REPEATS : 1); sent++)
				out.push({
					time: start,
					marker,
					payload: Uint8Array.of(
						event.code,
						(ended ? 0x80 : 0) | VOLUME,
						units >> 8,
						units & 0xff,
					),
				});
		};
		if (duration > MAX_UNITS) {
			// a long event goes on in a segment of its own
			report(event.start, MAX_UNITS, false);
			event.start = time;
			duration -= MAX_UNITS;
			event.length -= MAX_UNITS;
			report(event.start, duration, false);
		} else {
			report(event.start, duration, !event.firstSent);
			event.firstSent = true;
		}
		return out;
	}
}
