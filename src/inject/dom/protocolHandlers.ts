// navigator.registerProtocolHandler() and unregisterProtocolHandler() past
// the browser's own refusals of their arguments' count and receiver, a
// deferred part of the document bundle (./deferredParts.ts), made at a
// page's first such call (./modules/Navigator.ts installs the wrappers). A
// protocol handler would be registered for the proxy origin, with the
// browser's prompt naming it: the call is accepted silently, like a denied
// prompt, after the checks the browser makes first (the safelisted schemes
// and `web+` names, a URL with `%s`).
import { withStack } from '../nativeErrors';

/** the schemes a handler may be registered for without `web+` */
const SAFE_SCHEMES = [
	'bitcoin',
	'ftp',
	'ftps',
	'geo',
	'im',
	'irc',
	'ircs',
	'magnet',
	'mailto',
	'matrix',
	'mms',
	'news',
	'nntp',
	'openpgp4fpr',
	'sftp',
	'sip',
	'sms',
	'smsto',
	'ssh',
	'tel',
	'urn',
	'webcal',
	'wtai',
	'xmpp',
];

/** what a call of `name` with `args` (two or more) answers: undefined, or the browser's error */
export function protocolHandler(
	global: typeof globalThis,
	name: string,
	args: unknown[],
): undefined {
	const scheme = String(args[0]);
	if (!SAFE_SCHEMES.includes(scheme) && !/^web\+[a-z]+$/.test(scheme))
		throw withStack(
			new global.DOMException(
				`Failed to execute '${name}' on 'Navigator': The scheme '${scheme}' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.`,
				'SecurityError',
			),
		);
	if (!String(args[1]).includes('%s'))
		throw withStack(
			new global.DOMException(
				`Failed to execute '${name}' on 'Navigator': The url provided ('${String(args[1])}') does not contain '%s'.`,
				'SyntaxError',
			),
		);
	return undefined;
}
