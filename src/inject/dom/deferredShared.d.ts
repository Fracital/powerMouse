// What a document bundle hands its deferred parts (./deferredParts.ts): the
// values of its own modules that the parts import, by file, made by build.js.
declare module 'stomp:deferred-shared' {
	/** by file (from the repository root), each import of the parts by name */
	const shared: () => Record<string, Record<string, unknown>>;
	export default shared;
}
