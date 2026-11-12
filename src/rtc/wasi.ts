// The WASI imports the stack's module asks for (rust/rtc/abi.json): the
// standard library's clock and randomness, answered from the worker's own.
// Built for wasm32-wasip1, the module may also ask for the handful of
// imports a WASI reactor can touch (stdout, the environment, exit); each is
// answered as an empty system would answer it.

const ERRNO_SUCCESS = 0;
const ERRNO_INVAL = 28;
const ERRNO_BADF = 8;

/** nanoseconds since the epoch (realtime) or since an arbitrary point (monotonic), as a BigInt */
function now(clockId: number): bigint {
	if (clockId === 0) return BigInt(Math.round(Date.now())) * 1000000n;
	// performance.now() is a double of milliseconds with sub-ms precision
	return BigInt(Math.round(performance.now() * 1000)) * 1000n;
}

/** the import object for `instantiate`; `memory()` is read on each call (it may grow) */
export function wasiImports(memory: () => WebAssembly.Memory) {
	const view = () => new DataView(memory().buffer);
	return {
		wasi_snapshot_preview1: {
			clock_time_get(clockId: number, _precision: bigint, out: number) {
				if (clockId !== 0 && clockId !== 1) return ERRNO_INVAL;
				view().setBigUint64(out, now(clockId), true);
				return ERRNO_SUCCESS;
			},
			random_get(ptr: number, len: number) {
				const bytes = new Uint8Array(memory().buffer, ptr, len);
				// getRandomValues takes at most 65536 bytes at once
				for (let at = 0; at < len; at += 65536)
					crypto.getRandomValues(bytes.subarray(at, Math.min(len, at + 65536)));
				return ERRNO_SUCCESS;
			},
			fd_write(_fd: number, _iovs: number, _count: number, written: number) {
				// nothing is printed; the bytes count as written
				view().setUint32(written, 0, true);
				return ERRNO_SUCCESS;
			},
			fd_close() {
				return ERRNO_BADF;
			},
			fd_seek() {
				return ERRNO_BADF;
			},
			fd_read() {
				return ERRNO_BADF;
			},
			environ_sizes_get(count: number, size: number) {
				view().setUint32(count, 0, true);
				view().setUint32(size, 0, true);
				return ERRNO_SUCCESS;
			},
			environ_get() {
				return ERRNO_SUCCESS;
			},
			sched_yield() {
				return ERRNO_SUCCESS;
			},
			proc_exit(code: number) {
				throw new Error(`the WebRTC stack exited with ${code}`);
			},
		},
	};
}
