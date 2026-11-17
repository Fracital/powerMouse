// What a document bundle hands its deferred parts (./deferredParts.ts): the
// values of its own modules that the parts import, made by build.js.
declare module 'stomp:deferred-shared' {
	/**
	 * A module's imports of the parts by name, made when a statement reads it:
	 * by the module's number (build.js deferredSharing)
	 */
	const shared: (module: number) => Record<string, unknown> | undefined;
	export default shared;
}
