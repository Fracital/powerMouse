// runtime.sendMessage, tabs.sendMessage and their ports between an
// extension's contexts, on its BroadcastChannel (docs/extensions.md
// "Messaging"): one post to the receivers, an ack from each that listens,
// the first sendResponse back. Nothing goes through the host page or the
// worker. A sender knows who listens from the contexts' presence posts, so
// "Receiving end does not exist" is told at once; a message to an
// extension whose background is not up yet wakes it through the hub first.
// A message is serialized once, as JSON (Chrome's own rule for messages),
// and read once in each receiving context; the channel delivers it as a
// task of its own, with no timer in between.
// Ported from STicks (messaging.ts), whose contexts shared one realm.
import {
	ApiError,
	NO_RECEIVER,
	type BusMessage,
	type Context,
	type Presence,
} from './context';
import { natives } from './natives';

/** a message as it travels: its JSON, as Chrome serializes messages */
const serialize = (value: unknown): string =>
	natives.JSON.stringify(value === undefined ? null : value) ?? 'null';
const deserialize = (json: unknown): unknown =>
	typeof json === 'string' ? natives.JSON.parse(json) : undefined;

/** whom a message is for */
export type Target =
	| { kind: 'ext'; external?: boolean }
	| { kind: 'tab'; tabId: number; frameId?: number };

/** how long a context's presence takes to come back when the sender knew of none */
const ROLL_WAIT_MS = 60;
/** how long a woken background has to listen */
const WAKE_WAIT_MS = 8000;
/** an expected receiver that does not ack in this long is gone */
const ACK_WAIT_MS = 3000;

function receives(presence: Presence, target: Target, port: boolean): boolean {
	if (!(port ? presence.c : presence.m)) return false;
	if (target.kind === 'ext') return presence.kind !== 'content';
	return (
		presence.kind === 'content' &&
		presence.tabId === target.tabId &&
		(target.frameId === undefined || presence.frameId === target.frameId)
	);
}

function selfReceives(ctx: Context, target: Target): boolean {
	if (target.kind === 'ext') return ctx.kind !== 'content';
	return (
		ctx.kind === 'content' &&
		ctx.place.tabId === target.tabId &&
		(target.frameId === undefined || ctx.place.frameId === target.frameId)
	);
}

const receivers = (ctx: Context, target: Target, port: boolean) =>
	[...ctx.peers.values()].filter((presence) =>
		receives(presence, target, port),
	);

function waitFor(
	ctx: Context,
	found: () => boolean,
	ms: number,
): Promise<boolean> {
	if (found()) return natives.Promise.resolve(true);
	return new natives.Promise((resolve) => {
		let done = false;
		const finish = (value: boolean) => {
			if (done) return;
			done = true;
			natives.clearInterval(poll);
			resolve(value);
		};
		const poll = natives.setInterval(() => {
			if (found()) finish(true);
		}, 15);
		natives.setTimeout(() => finish(found()), ms);
	});
}

/** the receivers there are, waking the background for a message to the extension */
async function reach(ctx: Context, target: Target, port: boolean) {
	if (receivers(ctx, target, port).length) return receivers(ctx, target, port);
	ctx.post({ t: 'roll' });
	await waitFor(
		ctx,
		() => receivers(ctx, target, port).length > 0,
		ROLL_WAIT_MS,
	);
	if (!receivers(ctx, target, port).length && target.kind === 'ext') {
		const woken = (await ctx.hub('wake').catch(() => false)) as boolean;
		if (woken)
			await waitFor(
				ctx,
				() => receivers(ctx, target, port).length > 0,
				WAKE_WAIT_MS,
			);
	}
	return receivers(ctx, target, port);
}

let ids = 0;
const nextId = (ctx: Context) => `${ctx.id}.${++ids}`;

type Waiting = { ack(m: BusMessage): void; res(m: BusMessage): void };
const waiting = new WeakMap<Context, Map<string, Waiting>>();
const ports = new WeakMap<Context, Map<string, Port>>();

const sends = (ctx: Context) => {
	let map = waiting.get(ctx);
	if (!map) waiting.set(ctx, (map = new Map()));
	return map;
};
const portsOf = (ctx: Context) => {
	let map = ports.get(ctx);
	if (!map) ports.set(ctx, (map = new Map()));
	return map;
};

/** send a message; resolves to the first response, rejects when nobody listens */
export async function sendMessage(
	ctx: Context,
	target: Target,
	message: unknown,
): Promise<unknown> {
	await ctx.placed;
	const expected = await reach(ctx, target, false);
	if (!expected.length) throw new ApiError(NO_RECEIVER);
	const id = nextId(ctx);
	const pending = new Set(expected.map((presence) => presence.ctx));
	return new natives.Promise((resolve) => {
		let settled = false;
		let kept = 0;
		const finish = (value: unknown) => {
			if (settled) return;
			settled = true;
			natives.clearTimeout(timer);
			off();
			resolve(value);
		};
		const check = () => {
			if (!pending.size && !kept) finish(undefined);
		};
		sends(ctx).set(id, {
			ack(m) {
				pending.delete(String(m.ctx));
				if (m.keep) kept++;
				check();
			},
			res(m) {
				if (m.has) finish(deserialize(m.json));
				else {
					kept = Math.max(0, kept - 1);
					check();
				}
			},
		});
		const off = () => sends(ctx).delete(id);
		// a receiver that went away without a word
		const timer = natives.setTimeout(() => {
			for (const gone of pending) ctx.peers.delete(gone);
			pending.clear();
			check();
		}, ACK_WAIT_MS);
		ctx.post({
			t: 'msg',
			id,
			from: ctx.id,
			to: target,
			json: serialize(message),
			sender: ctx.sender(),
			...(ctx.userScript ? { us: true } : {}),
		});
	});
}

/** hear the messages for this context */
export function receiveMessages(ctx: Context) {
	for (const type of ['ack', 'res'] as const)
		ctx.on(type, (m) => {
			if (m.to === ctx.id) sends(ctx).get(String(m.id))?.[type](m);
		});
	ctx.on('pm', (m) => portsOf(ctx).get(String(m.port))?.message(m));
	ctx.on('pd', (m) => portsOf(ctx).get(String(m.port))?.gone(m));
	ctx.on('connected', (m) => {
		if (m.to === ctx.id) portsOf(ctx).get(String(m.port))?.answered(m);
	});
	ctx.on('msg', (m) => {
		const target = m.to as Target;
		if (m.from === ctx.id || !selfReceives(ctx, target)) return;
		const external =
			target.kind === 'ext' &&
			(m.sender as { id?: string } | undefined)?.id !== ctx.ext.id;
		const event = ctx.events.get(
			m.us
				? 'runtime.onUserScriptMessage'
				: external
					? 'runtime.onMessageExternal'
					: 'runtime.onMessage',
		);
		if (!event?.listeners.length) return;
		let responded = false;
		const respond = (value: unknown) => {
			if (responded) return;
			responded = true;
			ctx.post({
				t: 'res',
				id: m.id,
				to: m.from,
				has: true,
				...(value === undefined ? {} : { json: serialize(value) }),
			});
		};
		let keep = false;
		for (const result of event.dispatch([
			deserialize(m.json),
			m.sender,
			respond,
		])) {
			if (result === true) keep = true;
			else if (
				result &&
				typeof (result as Promise<unknown>).then === 'function'
			) {
				keep = true;
				(result as Promise<unknown>).then(respond, (error) => {
					ctx.listenerError(error);
					if (!responded) {
						responded = true;
						ctx.post({ t: 'res', id: m.id, to: m.from, has: false });
					}
				});
			}
		}
		ctx.post({
			t: 'ack',
			id: m.id,
			to: m.from,
			ctx: ctx.id,
			keep: keep && !responded,
		});
	});
	ctx.on('connect', (m) => {
		const target = m.to as Target;
		if (m.from === ctx.id || !selfReceives(ctx, target)) return;
		const external =
			target.kind === 'ext' &&
			(m.sender as { id?: string } | undefined)?.id !== ctx.ext.id;
		const event = ctx.events.get(
			m.us
				? 'runtime.onUserScriptConnect'
				: external
					? 'runtime.onConnectExternal'
					: 'runtime.onConnect',
		);
		if (!event?.listeners.length) return;
		const end = new Port(
			ctx,
			String(m.port),
			String(m.name ?? ''),
			String(m.from),
			m.sender as Record<string, unknown>,
		);
		ctx.post({ t: 'connected', port: m.port, to: m.from, end: ctx.id });
		event.dispatch([end.object]);
	});
}

/** one end of a port */
class Port {
	readonly object: Record<string, unknown>;
	connected = true;
	/** the other ends: the opener's receivers, or the opener */
	readonly others = new Set<string>();
	#queue: string[] | null;
	readonly #message;
	readonly #disconnect;

	constructor(
		readonly ctx: Context,
		readonly id: string,
		name: string,
		/** the opener's context, for a receiver's end; none for the opener's own */
		readonly opener: string | null,
		sender?: Record<string, unknown>,
	) {
		this.#queue = opener ? null : [];
		if (opener) this.others.add(opener);
		this.#message = ctx.event(`port:${id}.onMessage`);
		this.#disconnect = ctx.event(`port:${id}.onDisconnect`);
		this.object = {
			name,
			...(sender ? { sender } : {}),
			onMessage: this.#message.api,
			onDisconnect: this.#disconnect.api,
			postMessage: (message: unknown) => this.post(message),
			disconnect: () => this.disconnect(),
		};
		portsOf(ctx).set(id, this);
	}

	message(m: BusMessage) {
		if (m.from === this.ctx.id || !this.connected) return;
		if (m.to !== undefined && m.to !== this.ctx.id) return;
		if (!this.others.has(String(m.from))) return;
		this.#message.dispatch([deserialize(m.json), this.object]);
	}

	gone(m: BusMessage) {
		if (m.from === this.ctx.id || !this.connected) return;
		if (!this.others.delete(String(m.from))) return;
		if (!this.others.size) this.#closed();
	}

	/** a receiver took the opener's connect */
	answered(m: BusMessage) {
		if (this.opener || !this.connected) return;
		const first = !this.others.size;
		this.others.add(String(m.end));
		if (first) this.linked();
	}

	post(message: unknown) {
		if (!this.connected)
			throw new natives.Error('Attempting to use a disconnected port object');
		const value = serialize(message);
		if (this.#queue) {
			this.#queue.push(value);
			return;
		}
		this.ctx.post({
			t: 'pm',
			port: this.id,
			from: this.ctx.id,
			...(this.opener ? { to: this.opener } : {}),
			json: value,
		});
	}

	/** the opener's end: its receivers answered */
	linked() {
		const queued = this.#queue ?? [];
		this.#queue = null;
		for (const message of queued)
			this.ctx.post({
				t: 'pm',
				port: this.id,
				from: this.ctx.id,
				json: message,
			});
	}

	disconnect() {
		if (!this.connected) return;
		this.connected = false;
		portsOf(this.ctx).delete(this.id);
		this.ctx.post({ t: 'pd', port: this.id, from: this.ctx.id });
	}

	#closed() {
		if (!this.connected) return;
		this.connected = false;
		portsOf(this.ctx).delete(this.id);
		this.#disconnect.dispatch([this.object]);
	}

	fail(message: string) {
		if (!this.connected) return;
		this.connected = false;
		portsOf(this.ctx).delete(this.id);
		this.ctx.lastError = { message };
		this.#disconnect.dispatch([this.object]);
		this.ctx.lastError = undefined;
	}
}

/** runtime.connect / tabs.connect: the opener's end, linked once receivers answer */
export function connect(
	ctx: Context,
	target: Target,
	name: string,
): Record<string, unknown> {
	const id = nextId(ctx);
	const port = new Port(ctx, id, name, null);
	(async () => {
		await ctx.placed;
		const expected = await reach(ctx, target, true);
		if (!port.connected) return;
		if (!expected.length) {
			port.fail(NO_RECEIVER);
			return;
		}
		ctx.post({
			t: 'connect',
			port: id,
			from: ctx.id,
			to: target,
			name,
			sender: ctx.sender(),
			...(ctx.userScript ? { us: true } : {}),
		});
		await waitFor(ctx, () => port.others.size > 0, ACK_WAIT_MS);
		if (!port.others.size) port.fail(NO_RECEIVER);
	})();
	return port.object;
}
