// The isolated world's bundle as text (build.js `extensionsWorld`), which
// ./worlds.ts evaluates in each world's realm.
declare module 'extensions-world:source' {
	const source: string;
	export default source;
}
