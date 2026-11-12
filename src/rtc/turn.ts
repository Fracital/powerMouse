// A TURN client (RFC 8656) over UDP, for the relay candidate of each TURN
// server the page named: one stream to the server carries every peer's
// traffic. An allocation with the long-term credential flow (401, realm,
// nonce, MESSAGE-INTEGRITY keyed with MD5(username:realm:password)), kept
// alive by Refresh; a channel bound for each peer the agent sends to (the
// binding installs the permission too, and its ChannelData framing costs
// four bytes a packet where a Send indication costs thirty-six), rebound
// before it lapses. What arrives in ChannelData or a Data indication is
// handed on with the peer it came from.
import { md5 } from './md5';
import {
	ATTR_CHANNEL_NUMBER,
	ATTR_DATA,
	ATTR_LIFETIME,
	ATTR_MESSAGE_INTEGRITY,
	ATTR_NONCE,
	ATTR_REALM,
	ATTR_REQUESTED_TRANSPORT,
	ATTR_USERNAME,
	ATTR_XOR_MAPPED_ADDRESS,
	ATTR_XOR_PEER_ADDRESS,
	ATTR_XOR_RELAYED_ADDRESS,
	attributeOf,
	decodeAddress,
	encodeAddress,
	errorOf,
	joinAddress,
	parseStun,
	splitAddress,
	STUN_GIVE_UP_MS,
	STUN_SCHEDULE_MS,
	stunMessage,
	transactionId,
	type Address,
	type Attribute,
	type StunMessage,
} from './stun';

const ALLOCATE = 0x0003;
const REFRESH = 0x0004;
const CHANNEL_BIND = 0x0009;
const DATA_INDICATION = 0x0017;
const SUCCESS = 0x0100;
const ERROR = 0x0110;

const UNAUTHORIZED = 401;
const STALE_NONCE = 438;

/** channel numbers a client may bind (RFC 8656, section 12) */
const FIRST_CHANNEL = 0x4000;
const LAST_CHANNEL = 0x4fff;
/** a binding lasts ten minutes and its permission five: rebound well before either */
const REBIND_MS = 4 * 60 * 1000;
/** how many packets wait for a peer's channel */
const BINDING_QUEUE = 16;
const DEFAULT_LIFETIME_S = 600;

const encoder = new TextEncoder();

export interface TurnStream {
	send(bytes: Uint8Array): void;
	close(): void;
}

export interface TurnOptions {
	username: string;
	credential: string;
	/** the stream to the server; what it reads is given to `receive` */
	stream: TurnStream;
	/** the allocation is made: the relayed address, and this client's as the server saw it */
	onAllocated(relayed: Address, mapped: Address | null): void;
	/** the allocation could not be made (no answer, refused), or was lost */
	onFailed(reason: 'timeout' | 'refused'): void;
	/** a datagram a peer sent to the relayed address */
	onData(peer: string, bytes: Uint8Array): void;
}

interface Pending {
	resolve(message: StunMessage): void;
	reject(error: Error): void;
	timers: ReturnType<typeof setTimeout>[];
}

interface Binding {
	channel: number;
	bound: boolean;
	queue: Uint8Array[];
	timer: ReturnType<typeof setTimeout> | null;
}

export class TurnAllocation {
	#options: TurnOptions;
	#pending = new Map<string, Pending>();
	#realm: Uint8Array | null = null;
	#nonce: Uint8Array | null = null;
	#key: Promise<CryptoKey> | null = null;
	#bindings = new Map<string, Binding>();
	#channels = new Map<number, string>();
	#nextChannel = FIRST_CHANNEL;
	#refresh: ReturnType<typeof setTimeout> | null = null;
	#closed = false;
	#allocated = false;

	constructor(options: TurnOptions) {
		this.#options = options;
		this.#allocate();
	}

	async #allocate() {
		const transport: Attribute = [
			ATTR_REQUESTED_TRANSPORT,
			new Uint8Array([17, 0, 0, 0]),
		];
		try {
			const answer = await this.#request(ALLOCATE, () => [transport]);
			if (this.#closed) return;
			const relayed = attributeOf(answer, ATTR_XOR_RELAYED_ADDRESS);
			const address = relayed ? decodeAddress(relayed, answer.id) : null;
			if (!address) throw new Error('refused');
			const mapped = attributeOf(answer, ATTR_XOR_MAPPED_ADDRESS);
			this.#allocated = true;
			this.#scheduleRefresh(answer);
			this.#options.onAllocated(
				address,
				mapped ? decodeAddress(mapped, answer.id) : null,
			);
		} catch (error) {
			if (this.#closed) return;
			this.#options.onFailed(
				(error as Error).message === 'timeout' ? 'timeout' : 'refused',
			);
		}
	}

	#scheduleRefresh(answer: StunMessage) {
		const lifetime = attributeOf(answer, ATTR_LIFETIME);
		const seconds =
			lifetime && lifetime.length >= 4
				? new DataView(
						lifetime.buffer,
						lifetime.byteOffset,
						lifetime.byteLength,
					).getUint32(0)
				: DEFAULT_LIFETIME_S;
		if (this.#refresh !== null) clearTimeout(this.#refresh);
		// a minute before it lapses, and never in a tight loop
		this.#refresh = setTimeout(
			async () => {
				try {
					this.#scheduleRefresh(await this.#request(REFRESH, () => []));
				} catch {
					if (!this.#closed) this.#options.onFailed('refused');
				}
			},
			Math.max(seconds - 60, 30) * 1000,
		);
	}

	/**
	 * A request with the credentials the server asked for, retransmitted on
	 * the STUN schedule; answers 401 (the first, without credentials) and 438
	 * (a nonce that lapsed) by asking again with what the answer carried.
	 * `attributes` builds them for a transaction id (an XOR address is folded
	 * with it, and asking again is a new transaction).
	 */
	async #request(
		method: number,
		attributes: (id: Uint8Array) => Attribute[],
		retried = 0,
	): Promise<StunMessage> {
		const id = transactionId();
		const bytes = await this.#sign(method, id, attributes(id));
		if (this.#closed) throw new Error('closed');
		const answer = await new Promise<StunMessage>((resolve, reject) => {
			const timers = STUN_SCHEDULE_MS.map((ms) =>
				setTimeout(() => this.#options.stream.send(bytes), ms),
			);
			timers.push(
				setTimeout(() => {
					this.#pending.delete(String(id));
					reject(new Error('timeout'));
				}, STUN_GIVE_UP_MS),
			);
			this.#pending.set(String(id), { resolve, reject, timers });
		});
		if ((answer.type & ERROR) !== ERROR) return answer;
		const code = errorOf(answer);
		const realm = attributeOf(answer, ATTR_REALM);
		const nonce = attributeOf(answer, ATTR_NONCE);
		if (
			nonce &&
			retried < 2 &&
			(code === STALE_NONCE || (code === UNAUTHORIZED && !this.#nonce))
		) {
			this.#nonce = nonce.slice();
			if (realm && !this.#realm) this.#realm = realm.slice();
			return this.#request(method, attributes, retried + 1);
		}
		throw new Error('refused');
	}

	/** the message, with the credentials and their integrity once the server gave a realm */
	async #sign(
		method: number,
		id: Uint8Array,
		attributes: Attribute[],
	): Promise<Uint8Array> {
		if (!this.#realm || !this.#nonce)
			return stunMessage(method, id, attributes);
		const { username, credential } = this.#options;
		const realm = this.#realm;
		this.#key ??= crypto.subtle.importKey(
			'raw',
			md5(
				encoder.encode(
					`${username}:${new TextDecoder().decode(realm)}:${credential}`,
				),
			) as BufferSource,
			{ name: 'HMAC', hash: 'SHA-1' },
			false,
			['sign'],
		);
		const all: Attribute[] = [
			...attributes,
			[ATTR_USERNAME, encoder.encode(username)],
			[ATTR_REALM, realm],
			[ATTR_NONCE, this.#nonce],
			[ATTR_MESSAGE_INTEGRITY, new Uint8Array(20)],
		];
		// the integrity covers the message up to its own attribute, with the
		// header's length already counting it
		const message = stunMessage(method, id, all);
		const mac = new Uint8Array(
			await crypto.subtle.sign(
				'HMAC',
				await this.#key,
				message.subarray(0, message.length - 24) as BufferSource,
			),
		);
		message.set(mac, message.length - 20);
		return message;
	}

	/** what the stream to the server read */
	receive(bytes: Uint8Array) {
		if (this.#closed || bytes.length < 4) return;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// ChannelData: the channel, the length, the datagram
		if ((bytes[0] & 0xc0) === 0x40) {
			const peer = this.#channels.get(view.getUint16(0));
			const length = view.getUint16(2);
			if (peer && 4 + length <= bytes.length)
				this.#options.onData(peer, bytes.subarray(4, 4 + length));
			return;
		}
		const message = parseStun(bytes);
		if (!message) return;
		if (message.type === DATA_INDICATION) {
			const peer = attributeOf(message, ATTR_XOR_PEER_ADDRESS);
			const data = attributeOf(message, ATTR_DATA);
			const address = peer ? decodeAddress(peer, message.id) : null;
			if (address && data)
				this.#options.onData(joinAddress(address.address, address.port), data);
			return;
		}
		if (!(message.type & SUCCESS)) return;
		const pending = this.#pending.get(String(message.id));
		if (!pending) return;
		this.#pending.delete(String(message.id));
		for (const timer of pending.timers) clearTimeout(timer);
		pending.resolve(message);
	}

	/** a datagram to `peer` (`host:port`) from the relayed address */
	send(peer: string, bytes: Uint8Array) {
		if (this.#closed || !this.#allocated) return;
		let binding = this.#bindings.get(peer);
		if (!binding) {
			if (this.#nextChannel > LAST_CHANNEL) return;
			binding = {
				channel: this.#nextChannel++,
				bound: false,
				queue: [],
				timer: null,
			};
			this.#bindings.set(peer, binding);
			this.#channels.set(binding.channel, peer);
			this.#bind(peer, binding);
		}
		if (!binding.bound) {
			if (binding.queue.length < BINDING_QUEUE)
				binding.queue.push(bytes.slice());
			return;
		}
		const framed = new Uint8Array(4 + bytes.length);
		const view = new DataView(framed.buffer);
		view.setUint16(0, binding.channel);
		view.setUint16(2, bytes.length);
		framed.set(bytes, 4);
		this.#options.stream.send(framed);
	}

	async #bind(peer: string, binding: Binding) {
		const { host, port } = splitAddress(peer);
		const number = new Uint8Array(4);
		new DataView(number.buffer).setUint16(0, binding.channel);
		try {
			if (!encodeAddress(host, port, new Uint8Array(12)))
				throw new Error('refused');
			await this.#request(CHANNEL_BIND, (id) => [
				[ATTR_CHANNEL_NUMBER, number],
				[ATTR_XOR_PEER_ADDRESS, encodeAddress(host, port, id)!],
			]);
			if (this.#closed) return;
			binding.bound = true;
			for (const bytes of binding.queue.splice(0)) this.send(peer, bytes);
			binding.timer = setTimeout(() => this.#bind(peer, binding), REBIND_MS);
		} catch {
			// a peer the server refuses (or a server that went away): the
			// agent's checks through this candidate time out
			if (!binding.bound) {
				this.#bindings.delete(peer);
				this.#channels.delete(binding.channel);
			}
		}
	}

	close() {
		if (this.#closed) return;
		// the allocation is given back (a Refresh with lifetime 0), best effort
		if (this.#allocated)
			this.#sign(REFRESH, transactionId(), [
				[ATTR_LIFETIME, new Uint8Array(4)],
			]).then(
				(bytes) => {
					this.#options.stream.send(bytes);
					this.#options.stream.close();
				},
				() => this.#options.stream.close(),
			);
		else this.#options.stream.close();
		this.#closed = true;
		if (this.#refresh !== null) clearTimeout(this.#refresh);
		for (const binding of this.#bindings.values())
			if (binding.timer !== null) clearTimeout(binding.timer);
		for (const pending of this.#pending.values()) {
			for (const timer of pending.timers) clearTimeout(timer);
			pending.reject(new Error('closed'));
		}
		this.#pending.clear();
	}
}
