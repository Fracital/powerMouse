// What the proxy's worker targets hold, over CDP (a browser session, each
// worker through its own session): the service worker of the proxy's
// origin (`sw`) and each transport worker (`transport`). Suites about
// memory the page cannot see use it (abandoned-bodies, cache-walks,
// paused-bodies). A count of objects Blink backs (a Request, a port) can
// include some no full collection has taken yet: compare it with a margin.
import { PROXY } from './lib.mjs';

/**
 * Run in a worker, for `keptChunks`: the `enqueue` of a stream's controller
 * (a default stream's, as epoxy's response bodies and every stream the
 * worker passes them through are, or a transform's) notes the buffer of
 * each chunk enqueued, and holds it: what the worker did with it is still
 * there to see whenever the collector ran. Installed once; run again, it
 * notes afresh.
 */
const WATCH_CHUNKS = `(() => {
	const key = Symbol.for('stomp.test.chunks');
	if (globalThis[key]) return void (globalThis[key].noted = new Map());
	const watch = { noted: new Map() };
	for (const name of [
		'ReadableStreamDefaultController',
		'TransformStreamDefaultController',
	]) {
		const prototype = globalThis[name]?.prototype;
		const enqueue = prototype?.enqueue;
		if (!enqueue) continue;
		prototype.enqueue = function (chunk) {
			const buffer = ArrayBuffer.isView(chunk) ? chunk.buffer : chunk;
			if (watch.noted && buffer instanceof ArrayBuffer && !watch.noted.has(buffer))
				watch.noted.set(buffer, buffer.byteLength);
			return Reflect.apply(enqueue, this, arguments);
		};
	}
	globalThis[key] = watch;
})()`;

/**
 * in a worker: the bytes the noted buffers held when enqueued, and those
 * they hold now; the watch ends (nothing more is noted or held)
 */
const KEPT_CHUNKS = `(() => {
	const watch = globalThis[Symbol.for('stomp.test.chunks')];
	let enqueued = 0;
	let kept = 0;
	for (const [buffer, bytes] of watch?.noted ?? []) {
		enqueued += bytes;
		kept += buffer.byteLength;
	}
	if (watch) watch.noted = null;
	return { enqueued, kept };
})()`;

export async function workerMemory(browser) {
	const cdp = await browser.newBrowserCDPSession();
	let messageId = 0;
	const replies = new Map();
	cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
		const { id, result, error } = JSON.parse(message);
		replies.get(id)?.(error ? null : result);
		replies.delete(id);
	});
	const attached = new Map();
	const inTarget = async (sessionId, method, params = {}) => {
		const id = ++messageId;
		const reply = new Promise((resolve) => {
			replies.set(id, resolve);
			setTimeout(() => resolve(null), 60000);
		});
		await cdp.send('Target.sendMessageToTarget', {
			sessionId,
			message: JSON.stringify({ id, method, params }),
		});
		return reply;
	};
	/** a session on each live target of the kind `label` names */
	const sessions = async (label) => {
		const { targetInfos } = await cdp.send('Target.getTargets');
		const out = [];
		for (const target of targetInfos) {
			const kind =
				target.type === 'service_worker' &&
				target.url.startsWith(new URL(PROXY).origin)
					? 'sw'
					: target.type === 'worker' && /transportWorker/.test(target.url)
						? 'transport'
						: null;
			if (kind !== label) continue;
			let sessionId = attached.get(target.targetId);
			if (!sessionId) {
				({ sessionId } = await cdp.send('Target.attachToTarget', {
					targetId: target.targetId,
					flatten: false,
				}));
				attached.set(target.targetId, sessionId);
			}
			out.push(sessionId);
		}
		return out;
	};
	/** the live objects whose prototype is `constructor`'s, in `sessionId`, reduced by `fn` */
	const objects = async (sessionId, constructor, fn) => {
		const prototype = await inTarget(sessionId, 'Runtime.evaluate', {
			expression: `${constructor}.prototype`,
			objectGroup: 'memory',
		});
		const found = prototype?.result?.objectId
			? await inTarget(sessionId, 'Runtime.queryObjects', {
					prototypeObjectId: prototype.result.objectId,
					objectGroup: 'memory',
				})
			: null;
		const value = found?.objects?.objectId
			? await inTarget(sessionId, 'Runtime.callFunctionOn', {
					objectId: found.objects.objectId,
					functionDeclaration: fn,
					returnByValue: true,
				})
			: null;
		await inTarget(sessionId, 'Runtime.releaseObjectGroup', {
			objectGroup: 'memory',
		});
		return value?.result?.value ?? null;
	};
	return {
		/**
		 * Each kind's memory after a collection, summed over its targets (a
		 * closed tab's may linger): JS heap, ArrayBuffer backing stores, wasm
		 * memories (epoxy's, the rewriter's: the heap's figures leave them out)
		 */
		async memory() {
			const out = {};
			for (const label of ['sw', 'transport'])
				for (const sessionId of await sessions(label)) {
					await inTarget(sessionId, 'HeapProfiler.collectGarbage');
					const usage = await inTarget(sessionId, 'Runtime.getHeapUsage');
					if (!usage) continue;
					const wasm = await objects(
						sessionId,
						'WebAssembly.Memory',
						'function () { return this.reduce((sum, memory) => sum + memory.buffer.byteLength, 0); }',
					);
					out[label] ??= { heap: 0, buffers: 0, wasm: 0 };
					out[label].heap += usage.usedSize;
					out[label].buffers += usage.backingStorageSize;
					out[label].wasm += wasm ?? 0;
				}
			return out;
		},
		/**
		 * The ArrayBuffer backing stores the targets of `label` hold as they
		 * stand, summed: live and dead, with no collection first (after a
		 * `memory()`, what grows is what the work since left to the
		 * collector, or kept); null when there is no such target
		 */
		async uncollected(label) {
			let total = null;
			for (const sessionId of await sessions(label)) {
				const usage = await inTarget(sessionId, 'Runtime.getHeapUsage');
				if (usage) total = (total ?? 0) + usage.backingStorageSize;
			}
			return total;
		},
		/**
		 * From now on, each target of `label` notes the buffer of each chunk
		 * a stream there is given (WATCH_CHUNKS), for `keptChunks`. What it
		 * noted before is forgotten.
		 */
		async watchChunks(label) {
			for (const sessionId of await sessions(label))
				await inTarget(sessionId, 'Runtime.evaluate', {
					expression: WATCH_CHUNKS,
				});
		},
		/**
		 * Of the chunks the targets of `label` enqueued since `watchChunks`,
		 * the bytes they held (`enqueued`) and the bytes their buffers still
		 * hold (`kept`), summed: a chunk passed on by transfer keeps none,
		 * one the worker copied and passed the copy of keeps all of its.
		 * Unlike `uncollected`, it is not a matter of when the collector
		 * ran. The watch ends. Null when there is no such target.
		 */
		async keptChunks(label) {
			let total = null;
			for (const sessionId of await sessions(label)) {
				const value = (
					await inTarget(sessionId, 'Runtime.evaluate', {
						expression: KEPT_CHUNKS,
						returnByValue: true,
					})
				)?.result?.value;
				if (!value) continue;
				total ??= { enqueued: 0, kept: 0 };
				total.enqueued += value.enqueued;
				total.kept += value.kept;
			}
			return total;
		},
		/** how many objects of `constructor` the targets of `label` hold alive */
		async count(label, constructor) {
			let total = 0;
			for (const sessionId of await sessions(label)) {
				await inTarget(sessionId, 'HeapProfiler.collectGarbage');
				total +=
					(await objects(
						sessionId,
						constructor,
						'function () { return this.length; }',
					)) ?? 0;
			}
			return total;
		},
		detach: () => cdp.detach().catch(() => {}),
	};
}

/** how much more `label` held in `after` than in `before`, all kinds summed; null when it is in neither */
export function grewBy(before, after, label) {
	const sum = (m) => m.heap + m.buffers + m.wasm;
	return after?.[label] && before?.[label]
		? sum(after[label]) - sum(before[label])
		: null;
}
