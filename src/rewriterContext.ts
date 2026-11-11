// What a call to the rewriter library depends on, as its caller sends it:
// the two libraries (src/rewriterLib.ts and the light one the inject
// bundles carry, src/rewriterLight.ts) read it the same way.
import { parseConfig, type Config, type ConfigCodec } from './config';
import { setBlobOrigins, setRouteScopes } from './routeURL';
import StompURL from './StompURL';

/**
 * What a rewrite depends on, as the caller sends it (JSON): the document's
 * URL, its codec and key, the controller's directory, the config (null for
 * CSS, which needs none), the blob: origins and the route scopes
 */
type Context = [
	url: string,
	codec: ConfigCodec,
	key: string,
	directory: string,
	config: Config | null,
	blob: [page: string, proxy: string] | null,
	scopes: string[],
];

let contextText = '';
let context: { url: StompURL; config: Config } | null = null;

export function enter(text: string): { url: StompURL; config: Config } {
	if (context && text === contextText) return context;
	const [url, codecName, key, directory, config, blob, scopes] = JSON.parse(
		text,
	) as Context;
	const full: Config = config ?? { codec: codecName, directory, scope: '' };
	const { codec } = parseConfig({ ...full, codec: codecName }, key);
	// the module state the rewriters read is the caller's
	if (blob) setBlobOrigins(blob[0], blob[1]);
	else setBlobOrigins('', '');
	setRouteScopes(scopes);
	context = { url: new StompURL(url, codec, directory), config: full };
	contextText = text;
	return context;
}
