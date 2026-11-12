// Opus in-band FEC on receive (docs/webrtc-over-wisp.md, section 16). A
// sender with `useinbandfec=1` that hears of loss puts a second, coarser
// copy of each SILK frame (LBRR, RFC 6716 4.2.4) into the next packet.
// Chrome's NetEq decodes that copy when a packet is lost; WebCodecs has no
// way to ask libopus for it, so the copy is rewritten here as a packet of
// its own: an LBRR frame is coded with the syntax of a first frame coded
// independently (with the signal type table of a voiced frame), so its
// symbols are read with their iCDFs and written again with the same ones
// after a header that says "voice, no LBRR". libopus decodes the result as
// it decodes the copy (measured: the same output as libopus's
// `decode_fec` and as Chrome's FEC, for SILK and hybrid streams).
// Mono, 20 ms frames: what Chrome sends. Anything else is left to the
// concealment.

// The iCDF tables of libopus's SILK decoder (silk/tables_*.c, libopus
// 1.5.2, BSD-3-Clause, Copyright (c) 2006-2011 Skype Limited), each a
// base64 string of its bytes, two-dimensional ones row after row.
const SOURCES = {
	typeOffset: '6J4KAA==',
	gain: '4HAsDwMCAQD+7cCERhcEAP/84ps9CwIA',
	uniform8: '4MCggGBAIAA=',
	uniform6: '1auAVSsA',
	uniform4: 'wIBAAA==',
	deltaGain: '+vXqy0cyKiYjIR8dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=',
	cb1Wide:
		'4czJuLevnpqZh3dzcW5tY2JfT0Q0MjAtKyAfGxIKAwD/++vm1MnEtqemo5eKfG5oWk5MRkU5LSIYFQsGBQQDAA==',
	selectWide:
		'AAAAAAAAAAFkZmZERCQiYKRrnrm0uYtmQEIkIiIAASDQi42/mLmbaGCraKZmZmaEAQAAAAAQEABQbU5ruYtnZdDUjYutmXtnJAAAAAAAAAEwAAAAAAAAIESHe3d3Z0ViRGd4dnZmR2KGiJ24tpmLhtCo+Eu9j3lrIDEiIiIAEQLS64t7uYlphmKHaLZkt6uGZEZERkJCIoNApmZEJAIBAIamZkQiIkKE1Paei2trV2Zk2316iXZnhHKHiWmrajIipNaNj7mXeWfAIgAAAAAAAdBtSruG+Z+JZm6adldld2UAAgAkJEJEI2CkZmQkAAIhp4quZmRUAgJka3h3JMUYAA==',
	cb2Wide:
		'//799AwDAgEA//784CYDAgEA//770TkEAgEA//70w0UEAgEA//vouFQHAgEA//7wulYOAgEA//7vslseBQEA//jjsWQTAgEA',
	cb1Narrow:
		'1LKUgWxgVVJPTT07OTgzMTAtKikoJiQiHx4VDAoDAQD/9fTs6eHZy76wr6GViH1yZltRRzw0KyMcFBMSDAsFAA==',
	selectNarrow:
		'EAAAAABjQiQkIiQiIiIiU0UkNCJ0ZkZERLBmREQiQVVEVCR0jZiLqoS7uNiJhPmouYtoZmRERLLaubmq9Ni7u6r0u7vbimebuLmJdLebmIiE2bi4qqTZq5uL9Km4uaqk2N/aitaPvNqo9I2Im6qoitzbi6TbytiJqLr2uYt0udu5imRkhmRmIkREZESoy93aqKeaiGhGpPariYuJm9rbiw==',
	cb2Narrow:
		'//797g4DAgEA//782iMDAgEA//760DsEAgEA//72wkcKAgEA//zst1IIAgEA//zrtFoRAgEA//jgq2EeBAEA//7srV8lBwEA',
	nlsfExt: 'ZCgQBwMBAA==',
	interpolation: '893AtQA=',
	pitchLag: '/fr06dS2loN4bmJVSDwxKCAZEw8NCwkIBwYFBAMCAQA=',
	contour: '38m3p5iKfG9iWE9GPjgyLCcjHxsYFRIQDgwKCAYEAwIBAA==',
	contourNarrow: 'vLCbindhQysaCgA=',
	ltpPeriodicity: 's2MA',
	ltpGain0: 'RzgrHhUMBgA=',
	ltpGain1: 'x6WQfG1gVEc9MyogFw8IAA==',
	ltpGain2: '8eHTx7uvpJmOhHtyaWBYUEhAOTIsJiEdGBQQDAkFAgA=',
	ltpScale: 'gEAA',
	rateLevels: '8b6yhFdKKQ4A38GdjGo5JxIA',
	pulsesPerBlock:
		'fTMaEg8MCwoJCAcGBQQDAgEAxmktFg8MCwoJCAcGBQQDAgEA1aJ0UzsrIBgSDwwJBwYFAwIA77t0OxwQCwoJCAcGBQQDAgEA+uW8h1YzHhMNCggGBQQDAgEA+evVuZyAZ1NCNSohGhURDQoA/vnrzqR2TS4bEAoHBQQDAgEA//3579y/nHdVOSUXDwoGBAIA//379u3fy7OYfGJLNygdFQ8A//7999yiakMqHBIMCQYEAwIA',
	shell0:
		'gADWKgDrgBUA9LhICwD41oAqBwD44apQGQUA++zGfjYSAwD67tOfUiMPBQD658uogFg1GQYA/O7YuZRsRygSBAD98+HHpoBaOR8NAwD+9unUt5NtSSwXCgIA//rw38amgFo6IRAGAQD/+/Tn0rWSbksuGQwFAQD//fju3cSkgFw8IxIIAwEA//358uXQtJJuTDAbDgcDAQA=',
	shell1:
		'gQDPMgDsgRQA9blICgD51YEqBgD64qlXGwQA++nCgj4UBAD67M+gYy8RAwD/8Nm2g1EpCwEA//7pyZ9rPRQCAQD/+enOqoBWMhcHAQD/+u7ZupRsRicSBgEA//zz4simgFo4Hg0EAQD//PXn0bSSbkwvGQsEAQD//fjt28KjgF0+JRMIAwEA//768eLNsZFvTzMeDwYCAQA=',
	shell2:
		'gQDLNgDqgRcA9bhJCgD614EpBQD86K1WGAMA/fDIgTgPAgD99NmkXiYKAQD99eK9hEcbBwEA/fbny59pOBcGAQD/+OvVs4VVLxMFAQD//vPdwp91RiUMAgEA//746tCrgFUwFggCAQD//vrw3L2Va0MkEAYCAQD//vvz48mmgFo3HQ0FAgEA//789urVt5NtSSsWCgQCAQA=',
	shell3:
		'ggDIOgDnghoA9LhMDAD51oIrBgD86K1XGAMA/fHLgzgOAgD+9t2nXiMIAQD++ejBgkEXBQEA//vv06JjLQ8EAQD/+/PfuoNKIQsDAQD//PXmyp5pORgIAgEA//3369azhFQsEwcCAQD//vrw38SfcEUkDwYCAQD//v3159GwiF03GwsDAgEA//79/O/dwp51TCoSBAMCAQA=',
	shellOffsets: 'AAACBQkOFBsjLDZBTVpod4c=',
	lsb: 'eAA=',
	sign: '/jFDTVJdY8YLEhgfJC3/LkJOV15o0A4VICozQv9eaG1wc3b4NUVQWF9m',
};
type Tables = { [Key in keyof typeof SOURCES]: Uint8Array };
let tables: Tables | null = null;
function silk(): Tables {
	if (!tables) {
		const out: Record<string, Uint8Array> = {};
		for (const [name, text] of Object.entries(SOURCES))
			out[name] = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
		tables = out as Tables;
	}
	return tables;
}

/** EC_CODE_TOP and EC_CODE_BOT of libopus's range coder (celt/mfrngcod.h) */
const TOP = 2 ** 31;
const BOTTOM = 2 ** 23;

/** libopus's range decoder (celt/entdec.c), as far as SILK reads it */
class RangeDecoder {
	#bytes: Uint8Array;
	#at: number;
	#range = 128;
	#rest: number;
	#value: number;

	constructor(bytes: Uint8Array, at: number) {
		this.#bytes = bytes;
		this.#at = at;
		this.#rest = this.#byte();
		this.#value = this.#range - 1 - (this.#rest >> 1);
		this.#normalize();
	}

	#byte(): number {
		// past the end it reads zeros, as libopus does
		return this.#at < this.#bytes.length ? this.#bytes[this.#at++] : 0;
	}

	#normalize() {
		while (this.#range <= BOTTOM) {
			this.#range *= 256;
			const last = this.#rest;
			this.#rest = this.#byte();
			const symbol = ((last << 8) | this.#rest) >> 1;
			this.#value = (this.#value * 256 + (255 & ~symbol)) % TOP;
		}
	}

	bit(logp: number): number {
		const share = Math.floor(this.#range / 2 ** logp);
		const one = this.#value < share;
		if (!one) this.#value -= share;
		this.#range = one ? share : this.#range - share;
		this.#normalize();
		return one ? 1 : 0;
	}

	icdf(table: Uint8Array, offset: number): number {
		const step = Math.floor(this.#range / 256);
		let symbol = -1;
		let top: number;
		let low = this.#range;
		do {
			top = low;
			low = step * table[offset + ++symbol];
		} while (this.#value < low);
		this.#value -= low;
		this.#range = top - low;
		this.#normalize();
		return symbol;
	}
}

/** libopus's range encoder (celt/entenc.c), as far as SILK writes it */
class RangeEncoder {
	#range = TOP;
	#low = 0;
	#rest = -1;
	#extra = 0;
	#out: number[] = [];

	#carry(value: number) {
		if (value === 255) {
			this.#extra++;
			return;
		}
		const carry = value >> 8;
		if (this.#rest >= 0) this.#out.push((this.#rest + carry) & 255);
		for (; this.#extra > 0; this.#extra--) this.#out.push((255 + carry) & 255);
		this.#rest = value & 255;
	}

	#normalize() {
		while (this.#range <= BOTTOM) {
			this.#carry(Math.floor(this.#low / BOTTOM));
			this.#low = (this.#low % BOTTOM) * 256;
			this.#range *= 256;
		}
	}

	bit(value: number, logp: number) {
		const share = Math.floor(this.#range / 2 ** logp);
		const rest = this.#range - share;
		if (value) this.#low += rest;
		this.#range = value ? share : rest;
		this.#normalize();
	}

	icdf(symbol: number, table: Uint8Array, offset: number) {
		const step = Math.floor(this.#range / 256);
		if (symbol > 0) {
			this.#low += this.#range - step * table[offset + symbol - 1];
			this.#range =
				step * (table[offset + symbol - 1] - table[offset + symbol]);
		} else this.#range -= step * table[offset + symbol];
		this.#normalize();
	}

	/** the bytes, with the fewest bits that still decode to the same symbols */
	done(): Uint8Array {
		let bits = Math.clz32(this.#range);
		let mask = Math.floor((TOP - 1) / 2 ** bits);
		let end = Math.floor((this.#low + mask) / (mask + 1)) * (mask + 1);
		if (end + mask >= this.#low + this.#range) {
			bits++;
			mask = Math.floor(mask / 2);
			end = Math.floor((this.#low + mask) / (mask + 1)) * (mask + 1);
		}
		for (; bits > 0; bits -= 8) {
			this.#carry(Math.floor(end / BOTTOM));
			end = (end % BOTTOM) * 256;
		}
		if (this.#rest >= 0 || this.#extra > 0) this.#carry(0);
		const out = this.#out;
		// the decoder reads zeros past the end: trailing ones are left out
		let length = out.length;
		while (length > 1 && out[length - 1] === 0) length--;
		return Uint8Array.from(out.slice(0, length));
	}
}

/** a symbol read: its table, where its distribution starts there, and its value */
type Symbol = [Uint8Array, number, number];

/**
 * The symbols of one SILK frame coded independently (silk/decode_indices.c,
 * silk/decode_pulses.c, silk/shell_coder.c, silk/decode_signs.c), at
 * `rate` kHz, 20 ms long
 */
function readFrame(decoder: RangeDecoder, rate: number): Symbol[] {
	const t = silk();
	const read: Symbol[] = [];
	const take = (table: Uint8Array, offset = 0) => {
		const value = decoder.icdf(table, offset);
		read.push([table, offset, value]);
		return value;
	};
	const kind = take(t.typeOffset) + 2;
	const signalType = kind >> 1;
	const quantOffset = kind & 1;
	take(t.gain, signalType * 8);
	take(t.uniform8);
	for (let sub = 1; sub < 4; sub++) take(t.deltaGain);
	const wide = rate === 16;
	const order = wide ? 16 : 10;
	const select = wide ? t.selectWide : t.selectNarrow;
	const second = wide ? t.cb2Wide : t.cb2Narrow;
	const first = take(wide ? t.cb1Wide : t.cb1Narrow, (signalType >> 1) * 32);
	for (let at = 0; at < order; at += 2) {
		const entry = select[(first * order) / 2 + at / 2];
		for (const offset of [((entry >> 1) & 7) * 9, ((entry >> 5) & 7) * 9]) {
			const value = take(second, offset);
			if (value === 0 || value === 8) take(t.nlsfExt);
		}
	}
	take(t.interpolation);
	if (signalType === 2) {
		take(t.pitchLag);
		take(rate === 8 ? t.uniform4 : rate === 12 ? t.uniform6 : t.uniform8);
		take(rate === 8 ? t.contourNarrow : t.contour);
		const periodicity = take(t.ltpPeriodicity);
		const gains = [t.ltpGain0, t.ltpGain1, t.ltpGain2][periodicity];
		for (let sub = 0; sub < 4; sub++) take(gains);
		take(t.ltpScale);
	}
	take(t.uniform4);
	// the excitation: pulse counts per block of 16, their split, the low
	// bits and the signs
	const blocks = (20 * rate) >> 4;
	const level = take(t.rateLevels, (signalType >> 1) * 9);
	const sums = new Int32Array(blocks);
	const shifts = new Int32Array(blocks);
	for (let block = 0; block < blocks; block++) {
		sums[block] = take(t.pulsesPerBlock, level * 18);
		while (sums[block] === 17) {
			shifts[block]++;
			sums[block] = take(
				t.pulsesPerBlock,
				9 * 18 + (shifts[block] === 10 ? 1 : 0),
			);
		}
	}
	const shells = [t.shell0, t.shell1, t.shell2, t.shell3];
	const split = (count: number, table: number): [number, number] => {
		if (count <= 0) return [0, 0];
		const left = take(shells[table], t.shellOffsets[count]);
		return [left, count - left];
	};
	const pulses = new Int32Array(blocks * 16);
	for (let block = 0; block < blocks; block++) {
		if (sums[block] <= 0) continue;
		// silk_shell_decoder: halves of 16, 8, 4 and 2, depth first
		const out: number[] = [];
		const halve = (count: number, table: number) => {
			const [left, right] = split(count, table);
			if (table === 0) out.push(left, right);
			else {
				halve(left, table - 1);
				halve(right, table - 1);
			}
		};
		halve(sums[block], 3);
		pulses.set(out, block * 16);
	}
	for (let block = 0; block < blocks; block++) {
		if (!shifts[block]) continue;
		for (let at = block * 16; at < block * 16 + 16; at++)
			for (let bit = 0; bit < shifts[block]; bit++)
				pulses[at] = pulses[at] * 2 + take(t.lsb);
		sums[block] |= shifts[block] << 5;
	}
	const signs = 7 * (quantOffset + 2 * signalType);
	for (let block = 0; block < blocks; block++) {
		if (sums[block] <= 0) continue;
		const table = Uint8Array.of(
			t.sign[signs + Math.min(sums[block] & 31, 6)],
			0,
		);
		for (let at = block * 16; at < block * 16 + 16; at++)
			if (pulses[at] > 0) take(table);
	}
	return read;
}

/**
 * The SILK rate in kHz of a mono 20 ms packet of one frame, SILK-only or
 * hybrid (RFC 6716, 3.1), and the first byte its copy goes out with: a
 * hybrid packet's SILK layer is wideband, so its copy is a wideband
 * SILK-only packet
 */
function layout(toc: number): { rate: number; toc: number } | null {
	// stereo, or more than one frame
	if ((toc & 7) !== 0) return null;
	const config = toc >> 3;
	if (config < 12)
		return (config & 3) === 1 ? { rate: [8, 12, 16][config >> 2], toc } : null;
	if (config < 16) return config & 1 ? { rate: 16, toc: 9 << 3 } : null;
	return null;
}

/** whether a packet carries an LBRR copy of the packet before it */
export function hasLbrr(packet: Uint8Array): boolean {
	if (packet.length < 2 || !layout(packet[0])) return false;
	const decoder = new RangeDecoder(packet, 1);
	// the frame's VAD flag, then its LBRR flag
	decoder.bit(1);
	return decoder.bit(1) === 1;
}

/**
 * The LBRR copy a packet carries of the packet before it, as an Opus
 * packet of its own, or null when it carries none (or is not mono 20 ms
 * SILK or hybrid)
 */
export function repackLbrr(packet: Uint8Array): Uint8Array | null {
	if (packet.length < 2) return null;
	const shape = layout(packet[0]);
	if (!shape) return null;
	const decoder = new RangeDecoder(packet, 1);
	decoder.bit(1);
	if (!decoder.bit(1)) return null;
	const symbols = readFrame(decoder, shape.rate);
	const encoder = new RangeEncoder();
	// a voiced frame with no copy of its own
	encoder.bit(1, 1);
	encoder.bit(0, 1);
	for (const [table, offset, value] of symbols)
		encoder.icdf(value, table, offset);
	const body = encoder.done();
	const out = new Uint8Array(body.length + 1);
	out[0] = shape.toc;
	out.set(body, 1);
	return out;
}

/** the symbols of a packet's first frame, or of its LBRR copy (for tests) */
export function silkSymbols(packet: Uint8Array, copy: boolean): number[] {
	const shape = layout(packet[0]);
	if (!shape) return [];
	const decoder = new RangeDecoder(packet, 1);
	decoder.bit(1);
	const lbrr = decoder.bit(1);
	if (copy && !lbrr) return [];
	return readFrame(decoder, shape.rate).map((symbol) => symbol[2]);
}
