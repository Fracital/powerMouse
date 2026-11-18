/* eslint-disable */
let wasm;

const heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

function getObject(idx) {
	return heap[idx];
}

let heap_next = heap.length;

function addHeapObject(obj) {
	if (heap_next === heap.length) heap.push(heap.length + 1);
	const idx = heap_next;
	heap_next = heap[idx];

	heap[idx] = obj;
	return idx;
}

function handleError(f, args) {
	try {
		return f.apply(this, args);
	} catch (e) {
		wasm.__wbindgen_export_0(addHeapObject(e));
	}
}

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
	if (
		cachedUint8ArrayMemory0 === null ||
		cachedUint8ArrayMemory0.byteLength === 0
	) {
		cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
	}
	return cachedUint8ArrayMemory0;
}

function getArrayU8FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

const cachedTextDecoder =
	typeof TextDecoder !== 'undefined'
		? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
		: {
				decode: () => {
					throw Error('TextDecoder not available');
				},
			};

if (typeof TextDecoder !== 'undefined') {
	cachedTextDecoder.decode();
}

function getStringFromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return cachedTextDecoder.decode(
		getUint8ArrayMemory0().subarray(ptr, ptr + len),
	);
}

function dropObject(idx) {
	if (idx < 132) return;
	heap[idx] = heap_next;
	heap_next = idx;
}

function takeObject(idx) {
	const ret = getObject(idx);
	dropObject(idx);
	return ret;
}

function isLikeNone(x) {
	return x === undefined || x === null;
}

const CLOSURE_DTORS =
	typeof FinalizationRegistry === 'undefined'
		? { register: () => {}, unregister: () => {} }
		: new FinalizationRegistry((state) => {
				wasm.__wbindgen_export_1.get(state.dtor)(state.a, state.b);
			});

function makeMutClosure(arg0, arg1, dtor, f) {
	const state = { a: arg0, b: arg1, cnt: 1, dtor };
	const real = (...args) => {
		// First up with a closure we increment the internal reference
		// count. This ensures that the Rust closure environment won't
		// be deallocated while we're invoking it.
		state.cnt++;
		const a = state.a;
		state.a = 0;
		try {
			return f(a, state.b, ...args);
		} finally {
			if (--state.cnt === 0) {
				wasm.__wbindgen_export_1.get(state.dtor)(a, state.b);
				CLOSURE_DTORS.unregister(state);
			} else {
				state.a = a;
			}
		}
	};
	real.original = state;
	CLOSURE_DTORS.register(real, state, state);
	return real;
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder =
	typeof TextEncoder !== 'undefined'
		? new TextEncoder('utf-8')
		: {
				encode: () => {
					throw Error('TextEncoder not available');
				},
			};

const encodeString =
	typeof cachedTextEncoder.encodeInto === 'function'
		? function (arg, view) {
				return cachedTextEncoder.encodeInto(arg, view);
			}
		: function (arg, view) {
				const buf = cachedTextEncoder.encode(arg);
				view.set(buf);
				return {
					read: arg.length,
					written: buf.length,
				};
			};

function passStringToWasm0(arg, malloc, realloc) {
	if (realloc === undefined) {
		const buf = cachedTextEncoder.encode(arg);
		const ptr = malloc(buf.length, 1) >>> 0;
		getUint8ArrayMemory0()
			.subarray(ptr, ptr + buf.length)
			.set(buf);
		WASM_VECTOR_LEN = buf.length;
		return ptr;
	}

	let len = arg.length;
	let ptr = malloc(len, 1) >>> 0;

	const mem = getUint8ArrayMemory0();

	let offset = 0;

	for (; offset < len; offset++) {
		const code = arg.charCodeAt(offset);
		if (code > 0x7f) break;
		mem[ptr + offset] = code;
	}

	if (offset !== len) {
		if (offset !== 0) {
			arg = arg.slice(offset);
		}
		ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
		const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
		const ret = encodeString(arg, view);

		offset += ret.written;
		ptr = realloc(ptr, len, offset, 1) >>> 0;
	}

	WASM_VECTOR_LEN = offset;
	return ptr;
}

function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1, 1) >>> 0;
	getUint8ArrayMemory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
	if (
		cachedDataViewMemory0 === null ||
		cachedDataViewMemory0.buffer.detached === true ||
		(cachedDataViewMemory0.buffer.detached === undefined &&
			cachedDataViewMemory0.buffer !== wasm.memory.buffer)
	) {
		cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
	}
	return cachedDataViewMemory0;
}
function __wbg_adapter_26(arg0, arg1) {
	wasm.__wbindgen_export_4(arg0, arg1);
}

function __wbg_adapter_29(arg0, arg1, arg2) {
	wasm.__wbindgen_export_5(arg0, arg1, addHeapObject(arg2));
}

const ServerFinalization =
	typeof FinalizationRegistry === 'undefined'
		? { register: () => {}, unregister: () => {} }
		: new FinalizationRegistry((ptr) => wasm.__wbg_server_free(ptr >>> 0, 1));

export class Server {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		ServerFinalization.unregister(this);
		return ptr;
	}

	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_server_free(ptr, 0);
	}
	/**
	 * the host's function for /bridge sessions: `bridge(kind, id, value)`
	 * (src/bridge.rs)
	 * @param {Function} f
	 */
	set_bridge(f) {
		wasm.server_set_bridge(this.__wbg_ptr, addHeapObject(f));
	}
	/**
	 * closes a /bridge session with its capsule and FIN
	 * @param {number} session
	 * @param {number} code
	 * @param {string} reason
	 */
	bridge_close(session, code, reason) {
		const ptr0 = passStringToWasm0(
			reason,
			wasm.__wbindgen_export_2,
			wasm.__wbindgen_export_3,
		);
		const len0 = WASM_VECTOR_LEN;
		wasm.server_bridge_close(this.__wbg_ptr, session, code, ptr0, len0);
	}
	/**
	 * resets a /bridge stream with WebTransport code `code`
	 * @param {number} stream
	 * @param {number} code
	 */
	bridge_reset(stream, code) {
		wasm.server_bridge_reset(this.__wbg_ptr, stream, code);
	}
	/**
	 * writes `data` on a /bridge stream (in order with the earlier writes)
	 * @param {number} stream
	 * @param {Uint8Array} data
	 */
	bridge_write(stream, data) {
		const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export_2);
		const len0 = WASM_VECTOR_LEN;
		wasm.server_bridge_write(this.__wbg_ptr, stream, ptr0, len0);
	}
	/**
	 * finishes a /bridge stream once what was written went out
	 * @param {number} stream
	 */
	bridge_finish(stream) {
		wasm.server_bridge_finish(this.__wbg_ptr, stream);
	}
	/**
	 * sends a datagram on a /bridge session; false when it was not sent
	 * @param {number} session
	 * @param {Uint8Array} data
	 * @returns {boolean}
	 */
	bridge_datagram(session, data) {
		const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export_2);
		const len0 = WASM_VECTOR_LEN;
		const ret = wasm.server_bridge_datagram(
			this.__wbg_ptr,
			session,
			ptr0,
			len0,
		);
		return ret !== 0;
	}
	/**
	 * what a datagram of a /bridge session can carry, -1 for none
	 * @param {number} session
	 * @returns {number}
	 */
	bridge_max_datagram(session) {
		const ret = wasm.server_bridge_max_datagram(this.__wbg_ptr, session);
		return ret;
	}
	/**
	 * `cert`: the leaf's DER; `key`: its PKCS#8 DER; `address`/`port`: the
	 * socket the host bound; `send(bytes, address, port)`; `emit(json)`.
	 * @param {Uint8Array} cert
	 * @param {Uint8Array} key
	 * @param {string} address
	 * @param {number} port
	 * @param {Function} send
	 * @param {Function} emit
	 */
	constructor(cert, key, address, port, send, emit) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passArray8ToWasm0(cert, wasm.__wbindgen_export_2);
			const len0 = WASM_VECTOR_LEN;
			const ptr1 = passArray8ToWasm0(key, wasm.__wbindgen_export_2);
			const len1 = WASM_VECTOR_LEN;
			const ptr2 = passStringToWasm0(
				address,
				wasm.__wbindgen_export_2,
				wasm.__wbindgen_export_3,
			);
			const len2 = WASM_VECTOR_LEN;
			wasm.server_new(
				retptr,
				ptr0,
				len0,
				ptr1,
				len1,
				ptr2,
				len2,
				port,
				addHeapObject(send),
				addHeapObject(emit),
			);
			var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
			var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
			if (r2) {
				throw takeObject(r1);
			}
			this.__wbg_ptr = r0 >>> 0;
			ServerFinalization.register(this, this.__wbg_ptr, this);
			return this;
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	 * a datagram the host's socket received
	 * @param {Uint8Array} data
	 * @param {string} address
	 * @param {number} port
	 */
	recv(data, address, port) {
		const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export_2);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(
			address,
			wasm.__wbindgen_export_2,
			wasm.__wbindgen_export_3,
		);
		const len1 = WASM_VECTOR_LEN;
		wasm.server_recv(this.__wbg_ptr, ptr0, len0, ptr1, len1, port);
	}
	/**
	 * closes every connection (CONNECTION_CLOSE, code 0)
	 */
	close() {
		wasm.server_close(this.__wbg_ptr);
	}
}

async function __wbg_load(module, imports) {
	if (typeof Response === 'function' && module instanceof Response) {
		if (typeof WebAssembly.instantiateStreaming === 'function') {
			try {
				return await WebAssembly.instantiateStreaming(module, imports);
			} catch (e) {
				if (module.headers.get('Content-Type') != 'application/wasm') {
					console.warn(
						'`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
						e,
					);
				} else {
					throw e;
				}
			}
		}

		const bytes = await module.arrayBuffer();
		return await WebAssembly.instantiate(bytes, imports);
	} else {
		const instance = await WebAssembly.instantiate(module, imports);

		if (instance instanceof WebAssembly.Instance) {
			return { instance, module };
		} else {
			return instance;
		}
	}
}

function __wbg_get_imports() {
	const imports = {};
	imports.wbg = {};
	imports.wbg.__wbg_buffer_609cc3eee51ed158 = function (arg0) {
		const ret = getObject(arg0).buffer;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_call_672a4d21634d4a24 = function () {
		return handleError(function (arg0, arg1) {
			const ret = getObject(arg0).call(getObject(arg1));
			return addHeapObject(ret);
		}, arguments);
	};
	imports.wbg.__wbg_call_7cccdd69e0791ae2 = function () {
		return handleError(function (arg0, arg1, arg2) {
			const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
			return addHeapObject(ret);
		}, arguments);
	};
	imports.wbg.__wbg_call_b8adc8b1d0a0d8eb = function () {
		return handleError(function (arg0, arg1, arg2, arg3, arg4) {
			const ret = getObject(arg0).call(
				getObject(arg1),
				getObject(arg2),
				getObject(arg3),
				getObject(arg4),
			);
			return addHeapObject(ret);
		}, arguments);
	};
	imports.wbg.__wbg_clearTimeout_5e039a2f327573ee = function (arg0) {
		clearTimeout(getObject(arg0));
	};
	imports.wbg.__wbg_crypto_86f2631e91b51511 = function (arg0) {
		const ret = getObject(arg0).crypto;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_getRandomValues_a8ddca022803a145 = function () {
		return handleError(function (arg0, arg1) {
			globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
		}, arguments);
	};
	imports.wbg.__wbg_getRandomValues_b3f15fcbfabb0f8b = function () {
		return handleError(function (arg0, arg1) {
			getObject(arg0).getRandomValues(getObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_msCrypto_d562bbe83e0d4b91 = function (arg0) {
		const ret = getObject(arg0).msCrypto;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_new_a12002a7f91c75be = function (arg0) {
		const ret = new Uint8Array(getObject(arg0));
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_newnoargs_105ed471475aaf50 = function (arg0, arg1) {
		const ret = new Function(getStringFromWasm0(arg0, arg1));
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_newwithbyteoffsetandlength_d97e637ebe145a9a = function (
		arg0,
		arg1,
		arg2,
	) {
		const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_newwithlength_a381634e90c276d4 = function (arg0) {
		const ret = new Uint8Array(arg0 >>> 0);
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_node_e1f24f89a7336c2e = function (arg0) {
		const ret = getObject(arg0).node;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_now_2c95c9de01293173 = function (arg0) {
		const ret = getObject(arg0).now();
		return ret;
	};
	imports.wbg.__wbg_now_807e54c39636c349 = function () {
		const ret = Date.now();
		return ret;
	};
	imports.wbg.__wbg_performance_7a3ffd0b17f663ad = function (arg0) {
		const ret = getObject(arg0).performance;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_process_3975fd6c72f520aa = function (arg0) {
		const ret = getObject(arg0).process;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_queueMicrotask_97d92b4fcc8a61c5 = function (arg0) {
		queueMicrotask(getObject(arg0));
	};
	imports.wbg.__wbg_queueMicrotask_d3219def82552485 = function (arg0) {
		const ret = getObject(arg0).queueMicrotask;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_randomFillSync_f8c153b79f285817 = function () {
		return handleError(function (arg0, arg1) {
			getObject(arg0).randomFillSync(takeObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_require_b74f47fc2d022fd6 = function () {
		return handleError(function () {
			const ret = module.require;
			return addHeapObject(ret);
		}, arguments);
	};
	imports.wbg.__wbg_resolve_4851785c9c5f573d = function (arg0) {
		const ret = Promise.resolve(getObject(arg0));
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_setTimeout_175119baede6ef8f = function (arg0, arg1) {
		const ret = setTimeout(getObject(arg0), arg1);
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_set_65595bdd868b3009 = function (arg0, arg1, arg2) {
		getObject(arg0).set(getObject(arg1), arg2 >>> 0);
	};
	imports.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = function () {
		const ret = typeof global === 'undefined' ? null : global;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = function () {
		const ret = typeof globalThis === 'undefined' ? null : globalThis;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = function () {
		const ret = typeof self === 'undefined' ? null : self;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = function () {
		const ret = typeof window === 'undefined' ? null : window;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_subarray_aa9065fa9dc5df96 = function (arg0, arg1, arg2) {
		const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_then_44b73946d2fb3e7d = function (arg0, arg1) {
		const ret = getObject(arg0).then(getObject(arg1));
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_versions_4e31226f5e8dc909 = function (arg0) {
		const ret = getObject(arg0).versions;
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_cb_drop = function (arg0) {
		const obj = takeObject(arg0).original;
		if (obj.cnt-- == 1) {
			obj.a = 0;
			return true;
		}
		const ret = false;
		return ret;
	};
	imports.wbg.__wbindgen_closure_wrapper270 = function (arg0, arg1, arg2) {
		const ret = makeMutClosure(arg0, arg1, 9, __wbg_adapter_26);
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_closure_wrapper3098 = function (arg0, arg1, arg2) {
		const ret = makeMutClosure(arg0, arg1, 132, __wbg_adapter_29);
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_error_new = function (arg0, arg1) {
		const ret = new Error(getStringFromWasm0(arg0, arg1));
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_is_function = function (arg0) {
		const ret = typeof getObject(arg0) === 'function';
		return ret;
	};
	imports.wbg.__wbindgen_is_object = function (arg0) {
		const val = getObject(arg0);
		const ret = typeof val === 'object' && val !== null;
		return ret;
	};
	imports.wbg.__wbindgen_is_string = function (arg0) {
		const ret = typeof getObject(arg0) === 'string';
		return ret;
	};
	imports.wbg.__wbindgen_is_undefined = function (arg0) {
		const ret = getObject(arg0) === undefined;
		return ret;
	};
	imports.wbg.__wbindgen_memory = function () {
		const ret = wasm.memory;
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_number_new = function (arg0) {
		const ret = arg0;
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_object_clone_ref = function (arg0) {
		const ret = getObject(arg0);
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_object_drop_ref = function (arg0) {
		takeObject(arg0);
	};
	imports.wbg.__wbindgen_string_new = function (arg0, arg1) {
		const ret = getStringFromWasm0(arg0, arg1);
		return addHeapObject(ret);
	};
	imports.wbg.__wbindgen_throw = function (arg0, arg1) {
		throw new Error(getStringFromWasm0(arg0, arg1));
	};

	return imports;
}

function __wbg_init_memory(imports, memory) {}

function __wbg_finalize_init(instance, module) {
	wasm = instance.exports;
	__wbg_init.__wbindgen_wasm_module = module;
	cachedDataViewMemory0 = null;
	cachedUint8ArrayMemory0 = null;

	return wasm;
}

function initSync(module) {
	if (wasm !== undefined) return wasm;

	if (typeof module !== 'undefined') {
		if (Object.getPrototypeOf(module) === Object.prototype) {
			({ module } = module);
		} else {
			console.warn(
				'using deprecated parameters for `initSync()`; pass a single object instead',
			);
		}
	}

	const imports = __wbg_get_imports();

	__wbg_init_memory(imports);

	if (!(module instanceof WebAssembly.Module)) {
		module = new WebAssembly.Module(module);
	}

	const instance = new WebAssembly.Instance(module, imports);

	return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
	if (wasm !== undefined) return wasm;

	if (typeof module_or_path !== 'undefined') {
		if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
			({ module_or_path } = module_or_path);
		} else {
			console.warn(
				'using deprecated parameters for the initialization function; pass a single object instead',
			);
		}
	}

	if (typeof module_or_path === 'undefined') {
		module_or_path = new URL('wtserver_bg.wasm', '');
	}
	const imports = __wbg_get_imports();

	if (
		typeof module_or_path === 'string' ||
		(typeof Request === 'function' && module_or_path instanceof Request) ||
		(typeof URL === 'function' && module_or_path instanceof URL)
	) {
		module_or_path = fetch(module_or_path);
	}

	__wbg_init_memory(imports);

	const { instance, module } = await __wbg_load(await module_or_path, imports);

	return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
