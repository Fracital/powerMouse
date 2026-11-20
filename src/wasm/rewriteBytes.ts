// A script rewritten from the bytes the network sent to the bytes of its
// output, for the threads that rewrite a site's scripts (the rewrite
// workers and the service worker). The module reads and writes UTF-8, and
// a script's response is UTF-8 almost always, so a rewrite made from a
// string decoded the bytes, encoded them again for the module, decoded its
// output and had the response encode that once more, and the string went
// to and from a rewrite worker as a copy each way: for Discord's 12.6 MB
// bundle, whose output is 28 MB, some 60 ms of one thread or another,
// about a tenth of the rewrite, a third of it on the service worker's one
// thread. Here the bytes go in as they came and the output comes out as
// a Blob of its bytes, for the response to take as it is: the same bytes
// the string's rewrite gives, encoded. The Blob is made from the module's
// memory where the output stands, the one copy of it the rewrite makes:
// a rewrite worker posts it to the service worker as a handle, where a
// buffer of the bytes was copied out of the module and then again into
// the Blob the service worker made of it (10 ms of its thread for
// Discord's 28 MB).
import type { Config } from '../config';
import { keepsSourcesHere } from '../functionSource';
import { scriptLead } from '../scriptLead';
import { isModuleType, type ScriptType } from '../scriptRoutes';
import type StompURL from '../StompURL';
import {
	counts,
	FLAG_HOLDER,
	FLAG_MODULE,
	FLAG_PARAMS,
	FLAG_POSITIONS,
	REWRITER,
	rewriterConfig,
	rewriterRoute,
	sameRevision,
} from './rewriter';
import { hasModule, withInstance } from './thread';

/**
 * The output of the script whose UTF-8 bytes are `bytes`, as modifyJS
 * (src/rewriteJS.ts) makes it of the text `new TextDecoder().decode(bytes)`,
 * as a Blob of its UTF-8 bytes; or null for the caller to make it of that
 * text: the thread holds no module or another revision's, the bytes are no
 * UTF-8 (the decoder puts U+FFFD in for what is not), the module declined
 * the script (it is handed back, with what the string's rewrite says of
 * it), or this realm keeps the scripts' texts itself.
 */
export function rewriteBytesInWasm(
	bytes: Uint8Array,
	url: StompURL,
	config: Config,
	type: ScriptType,
	preamble = '',
): Blob | null {
	if (!hasModule(REWRITER) || keepsSourcesHere()) return null;
	// (the decoder drops one byte order mark)
	const text =
		bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
			? bytes.subarray(3)
			: bytes;
	const output = withInstance(
		REWRITER,
		(instance) => {
			if (!sameRevision(instance)) return null;
			// a script's params as rewriteWith writes them: its URL, no key or
			// shifts of its own, and the text that runs before its code
			const params = `${url.toString()}\n\n\n${scriptLead(url, config, type, preamble)}`;
			if (!params.isWellFormed()) return null;
			instance.configure(rewriterConfig(config, type));
			if (!('output' in instance.call(params, FLAG_PARAMS))) return null;
			const result = instance.callBytes(
				text,
				(isModuleType(type) ? FLAG_MODULE : 0) | FLAG_HOLDER | FLAG_POSITIONS,
			);
			if (!('bytes' in result)) return null;
			// an output that starts with a byte order mark (a script with two)
			// is decoded without it where the text's rewrite reads it back
			// (BufferInstance.call), as a browser decodes the body it is served
			const out = result.bytes;
			return new Blob([
				out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf
					? out.subarray(3)
					: out,
			]);
		},
		rewriterRoute(url, config, type),
	);
	if (output !== null) counts.answered++;
	return output;
}
