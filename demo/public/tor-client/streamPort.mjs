// A Tor stream (TorClient.connect's `{ readable, writable }`) carried over a
// MessagePort: shared.mjs serves the stream it opened, a tab's transport
// worker (remote.mjs) gets streams that read and write it. Chunks go as
// messages, not as transferred streams (Safari transfers none), with a
// window each way: the serving side sends at most WINDOW chunks the other
// has not taken yet, and the other has at most WINDOW writes not yet
// written to the circuit.

const WINDOW = 32;

const text = (error) => String(error?.message ?? error);

/** a copy that can be transferred (a chunk may be a view of wasm memory) */
const own = (chunk) =>
	chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);

/** serve `{ readable, writable }` to the streamOverPort() at `port`'s other end */
export function serveStream({ readable, writable }, port) {
	const reader = readable.getReader();
	const writer = writable.getWriter();
	let credit = WINDOW;
	let waiting = null;
	let closed = false;
	let writes = Promise.resolve();
	const finish = () => {
		if (closed) return;
		closed = true;
		port.onmessage = null;
		waiting?.();
		reader.cancel().catch(() => {});
		writer.abort().catch(() => {});
		port.close();
	};
	const fail = (error) => {
		if (closed) return;
		port.postMessage({ type: 'error', message: text(error) });
		finish();
	};
	port.onmessage = ({ data }) => {
		if (data?.type === 'credit') {
			credit += data.n;
			waiting?.();
			waiting = null;
		} else if (data?.type === 'data')
			writes = writes
				.then(() => writer.write(data.chunk))
				.then(() => !closed && port.postMessage({ type: 'written' }), fail);
		else if (data?.type === 'cancel') finish();
	};
	(async () => {
		while (!closed) {
			while (credit <= 0 && !closed)
				await new Promise((resolve) => (waiting = resolve));
			if (closed) return;
			const { done, value } = await reader.read();
			if (closed) return;
			if (done) {
				// a Tor stream has no half-close: it is over both ways
				port.postMessage({ type: 'end' });
				finish();
				return;
			}
			credit--;
			const chunk = own(value);
			port.postMessage({ type: 'data', chunk }, [chunk.buffer]);
		}
	})().catch(fail);
}

/** the stream serveStream() serves at `port`'s other end */
export function streamOverPort(port) {
	let controller;
	let closed = false;
	// chunks the other side may still send before it hears from us
	let granted = WINDOW;
	let unwritten = 0;
	let written = null;
	const finish = () => {
		if (closed) return;
		closed = true;
		port.onmessage = null;
		written?.();
		port.close();
	};
	const cancel = () => {
		if (closed) return;
		port.postMessage({ type: 'cancel' });
		finish();
	};
	const readable = new ReadableStream(
		{
			start: (c) => (controller = c),
			pull: () => {
				if (closed) return;
				const want = controller.desiredSize - granted;
				if (want <= 0) return;
				granted += want;
				port.postMessage({ type: 'credit', n: want });
			},
			cancel,
		},
		{ highWaterMark: WINDOW },
	);
	const writable = new WritableStream({
		async write(chunk) {
			while (unwritten >= WINDOW && !closed)
				await new Promise((resolve) => (written = resolve));
			if (closed) throw new Error('the Tor stream closed');
			unwritten++;
			const copy = own(chunk);
			port.postMessage({ type: 'data', chunk: copy }, [copy.buffer]);
		},
		// no half-close: closing the writing side ends the stream
		close: cancel,
		abort: cancel,
	});
	port.onmessage = ({ data }) => {
		if (data?.type === 'data') {
			granted--;
			controller.enqueue(data.chunk);
		} else if (data?.type === 'written') {
			unwritten--;
			written?.();
			written = null;
		} else if (data?.type === 'end') {
			controller.close();
			finish();
		} else if (data?.type === 'error') {
			controller.error(new Error(data.message));
			finish();
		}
	};
	return { readable, writable };
}
