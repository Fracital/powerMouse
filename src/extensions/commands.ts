// Extension commands' shortcuts (docs/extensions.md "Keyboard shortcuts"),
// as Chrome 157 writes, checks and matches them: the text is
// `Ctrl+Alt+Command+Shift+<key>` in that order (Command::AcceleratorToString),
// the keys are cr_shortcut_util's, a shortcut needs Ctrl or Alt (or
// Command), never both Ctrl and Alt (cr_shortcut_input on Windows and
// Linux), and a media key takes no modifier. Types and pure functions only:
// the controller (its key matching) and the worker (its store) import it.

/** the commands that click the extension's button, by manifest version */
export const ACTION_COMMANDS = [
	'_execute_action',
	'_execute_browser_action',
	'_execute_page_action',
];

/** what the shortcuts page says of an action command (IDS_EXTENSION_COMMANDS_GENERIC_ACTIVATE) */
export const ACTION_DESCRIPTION = 'Activate the extension';

const MEDIA_KEYS = [
	'MediaNextTrack',
	'MediaPlayPause',
	'MediaPrevTrack',
	'MediaStop',
];

/** the keys a shortcut may end in besides A-Z and 0-9 */
const NAMED_KEYS = [
	'Comma',
	'Period',
	'Up',
	'Down',
	'Left',
	'Right',
	'Insert',
	'Delete',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'Space',
	'Tab',
	...MEDIA_KEYS,
];

/** KeyboardEvent.code to a shortcut's key */
const CODES: Record<string, string> = {
	Comma: 'Comma',
	Period: 'Period',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Insert: 'Insert',
	Delete: 'Delete',
	Home: 'Home',
	End: 'End',
	PageUp: 'PageUp',
	PageDown: 'PageDown',
	Space: 'Space',
	Tab: 'Tab',
	MediaTrackNext: 'MediaNextTrack',
	MediaPlayPause: 'MediaPlayPause',
	MediaTrackPrevious: 'MediaPrevTrack',
	MediaStop: 'MediaStop',
};

/** Chrome's own spellings of a key in a manifest's suggested_key */
const ALIASES: Record<string, string> = {
	ins: 'Insert',
	del: 'Delete',
	pgup: 'PageUp',
	pgdwn: 'PageDown',
	pagedown: 'PageDown',
	pageup: 'PageUp',
};

/** what a key event reads, the parts a shortcut is made of */
export interface KeyLike {
	key?: string;
	code?: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	metaKey?: boolean;
}

/** why a shortcut was refused, in the words of Chrome's shortcut input */
export const SHORTCUT_ERRORS = {
	start: 'Include either Ctrl or Alt',
	tooMany: 'Use either Ctrl or Alt',
	character: 'Type a letter',
} as const;

interface Parts {
	ctrl: boolean;
	alt: boolean;
	command: boolean;
	shift: boolean;
	key: string;
}

const text = ({ ctrl, alt, command, shift, key }: Parts) =>
	[
		...(ctrl ? ['Ctrl'] : []),
		...(alt ? ['Alt'] : []),
		...(command ? ['Command'] : []),
		...(shift ? ['Shift'] : []),
		key,
	].join('+');

function keyName(token: string): string | null {
	if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase();
	const alias = ALIASES[token.toLowerCase()];
	if (alias) return alias;
	return (
		NAMED_KEYS.find((name) => name.toLowerCase() === token.toLowerCase()) ??
		null
	);
}

/** what is wrong with the parts, null when they make a shortcut */
function problem(parts: Parts): string | null {
	if (MEDIA_KEYS.includes(parts.key))
		return parts.ctrl || parts.alt || parts.command || parts.shift
			? SHORTCUT_ERRORS.start
			: null;
	if (parts.ctrl && parts.alt) return SHORTCUT_ERRORS.tooMany;
	if (!parts.ctrl && !parts.alt && !parts.command) return SHORTCUT_ERRORS.start;
	if (!parts.key) return SHORTCUT_ERRORS.character;
	return null;
}

/**
 * A shortcut as Chrome writes it (`Ctrl+Shift+Y`), from a text such as the
 * manifest's or the host's (`ctrl + shift + y`): '' for none; throws the
 * reason Chrome's input gives for one it refuses
 */
export function normalizeShortcut(given: string): string {
	const trimmed = given.trim();
	if (!trimmed) return '';
	const parts: Parts = {
		ctrl: false,
		alt: false,
		command: false,
		shift: false,
		key: '',
	};
	for (const raw of trimmed.split('+')) {
		const token = raw.trim();
		const lower = token.toLowerCase();
		if (lower === 'ctrl' || lower === 'control' || lower === 'macctrl')
			parts.ctrl = true;
		else if (lower === 'alt' || lower === 'option') parts.alt = true;
		else if (lower === 'command' || lower === 'cmd' || lower === 'search')
			parts.command = true;
		else if (lower === 'shift') parts.shift = true;
		else {
			const key = keyName(token);
			if (!key || parts.key) throw new Error(SHORTCUT_ERRORS.character);
			parts.key = key;
		}
	}
	const wrong = problem(parts);
	if (wrong) throw new Error(wrong);
	return text(parts);
}

/** the shortcut a key press makes, '' when it makes none (a modifier alone, a key no shortcut takes) */
export function shortcutOfKey(event: KeyLike): string {
	const code = String(event.code ?? '');
	let key = '';
	if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
	else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
	else if (CODES[code]) key = CODES[code];
	else if (typeof event.key === 'string' && /^[a-z0-9]$/i.test(event.key))
		key = event.key.toUpperCase();
	if (!key) return '';
	const parts: Parts = {
		ctrl: !!event.ctrlKey,
		alt: !!event.altKey,
		command: !!event.metaKey,
		shift: !!event.shiftKey,
		key,
	};
	return problem(parts) ? '' : text(parts);
}

/** the suggested key a manifest gives a command for this platform ('' for none or one Chrome would refuse) */
export function suggestedShortcut(
	suggested: Record<string, string> | string | undefined,
	platform: string,
): string {
	const given =
		typeof suggested === 'string'
			? suggested
			: (suggested?.[platform] ?? suggested?.default ?? '');
	try {
		return normalizeShortcut(String(given));
	} catch {
		return '';
	}
}

/** the manifest's platform key for this browser (Chrome's kKeybindingPlatform*) */
export function shortcutPlatform(userAgent: string): string {
	if (/Mac OS X|Macintosh/.test(userAgent)) return 'mac';
	if (/CrOS/.test(userAgent)) return 'chromeos';
	if (/Windows/.test(userAgent)) return 'windows';
	if (/Linux/.test(userAgent)) return 'linux';
	return 'default';
}
