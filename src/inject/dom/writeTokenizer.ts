/**
 * Where a piece of markup handed to document.write stops being complete.
 *
 * Old ad and analytics loaders split one tag over several calls
 * (`document.write('<scr'); document.write('ipt src=...></script>')`, a
 * script whose body and end tag come later, an attribute value cut in the
 * middle). The browser's tokenizer waits for the rest; a fragment parser
 * does not, and would close the tag or drop it. This walks the text with
 * the tokenizer's own states and reports the length of the prefix that can
 * be parsed on its own: everything from the start of an unfinished tag,
 * comment, CDATA section or raw text element (script, style, textarea, ...)
 * is held back for the next call.
 */

const enum State {
	Data,
	TagOpen,
	EndTagOpen,
	TagName,
	BeforeAttributeName,
	AttributeName,
	AfterAttributeName,
	BeforeAttributeValue,
	AttributeValueQuoted,
	AttributeValueUnquoted,
	AfterAttributeValueQuoted,
	SelfClosingStartTag,
	MarkupDeclarationOpen,
	Comment,
	BogusComment,
	CDATASection,
	RawText,
}

// elements whose content the tokenizer takes as text up to the matching end
// tag (RAWTEXT, RCDATA, script data; noscript counts, scripting being on)
const RAW_TEXT = new Set([
	'script',
	'style',
	'xmp',
	'iframe',
	'noembed',
	'noframes',
	'noscript',
	'textarea',
	'title',
	'plaintext',
]);

const isSpace = (c: string) =>
	c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c: string) => /^[A-Za-z]$/.test(c);
// what may follow an end tag name for the tag to count (`</scriptx` is text)
const endsName = (c: string | undefined) =>
	c === undefined || isSpace(c) || c === '/' || c === '>';

function startsWithIgnoreCase(text: string, at: number, what: string) {
	return text.slice(at, at + what.length).toLowerCase() === what;
}

/**
 * The length of the leading part of `text` that the browser's tokenizer
 * would have consumed into whole tokens: `text.length` when nothing is left
 * open, otherwise the offset where the unfinished construct begins.
 */
export function completeLength(text: string): number {
	const n = text.length;
	let i = 0;
	// where the construct now being tokenized began
	let anchor = 0;
	let state = State.Data;
	let tagName = '';
	let endTag = false;
	let quote = '';
	// the raw text element being read, and the script data escape states
	// (`<!-- <script> ... </script> -->` inside a script is script text)
	let rawTag = '';
	let escaped = false;
	let doubleEscaped = false;

	// the state after the tag just closed by `>`: a raw text element's start
	// tag switches the tokenizer (plaintext never switches back: held whole)
	const afterTag = (): State | null => {
		if (endTag || !RAW_TEXT.has(tagName)) return State.Data;
		if (tagName === 'plaintext') return null;
		rawTag = tagName;
		escaped = false;
		doubleEscaped = false;
		return State.RawText;
	};

	while (i < n) {
		const c = text[i];
		switch (state) {
			case State.Data:
				if (c === '<') {
					anchor = i;
					state = State.TagOpen;
				}
				i++;
				break;
			case State.TagOpen:
				if (c === '!') {
					state = State.MarkupDeclarationOpen;
					i++;
				} else if (c === '/') {
					state = State.EndTagOpen;
					i++;
				} else if (isAlpha(c)) {
					state = State.TagName;
					tagName = '';
					endTag = false;
				} else if (c === '?') {
					state = State.BogusComment;
					i++;
				} else state = State.Data;
				break;
			case State.EndTagOpen:
				if (isAlpha(c)) {
					state = State.TagName;
					tagName = '';
					endTag = true;
				} else if (c === '>') {
					state = State.Data;
					i++;
				} else state = State.BogusComment;
				break;
			case State.TagName:
				if (isSpace(c)) {
					state = State.BeforeAttributeName;
					i++;
				} else if (c === '/') {
					state = State.SelfClosingStartTag;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else {
					tagName += c.toLowerCase();
					i++;
				}
				break;
			case State.BeforeAttributeName:
				if (isSpace(c)) i++;
				else if (c === '/') {
					state = State.SelfClosingStartTag;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else state = State.AttributeName;
				break;
			case State.AttributeName:
				if (isSpace(c) || c === '/' || c === '>')
					state = State.AfterAttributeName;
				else if (c === '=') {
					state = State.BeforeAttributeValue;
					i++;
				} else i++;
				break;
			case State.AfterAttributeName:
				if (isSpace(c)) i++;
				else if (c === '/') {
					state = State.SelfClosingStartTag;
					i++;
				} else if (c === '=') {
					state = State.BeforeAttributeValue;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else state = State.AttributeName;
				break;
			case State.BeforeAttributeValue:
				if (isSpace(c)) i++;
				else if (c === '"' || c === "'") {
					quote = c;
					state = State.AttributeValueQuoted;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else state = State.AttributeValueUnquoted;
				break;
			case State.AttributeValueQuoted:
				if (c === quote) state = State.AfterAttributeValueQuoted;
				i++;
				break;
			case State.AttributeValueUnquoted:
				if (isSpace(c)) {
					state = State.BeforeAttributeName;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else i++;
				break;
			case State.AfterAttributeValueQuoted:
				if (isSpace(c)) {
					state = State.BeforeAttributeName;
					i++;
				} else if (c === '/') {
					state = State.SelfClosingStartTag;
					i++;
				} else if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else state = State.BeforeAttributeName;
				break;
			case State.SelfClosingStartTag:
				if (c === '>') {
					i++;
					const next = afterTag();
					if (next === null) return anchor;
					state = next;
				} else state = State.BeforeAttributeName;
				break;
			case State.MarkupDeclarationOpen: {
				// just past `<!`: a comment, a doctype, a CDATA section (held to
				// its `]]>` whether or not the parser is in foreign content; the
				// bogus comment it would be otherwise ends inside that anyway), or
				// a bogus comment. Too few characters to tell is incomplete.
				const rest = text.slice(i, i + 7).toLowerCase();
				if (rest.startsWith('--')) {
					i += 2;
					state = State.Comment;
				} else if (rest.startsWith('doctype')) {
					i += 7;
					state = State.BogusComment;
				} else if (startsWithIgnoreCase(text, i, '[cdata[')) {
					i += 7;
					state = State.CDATASection;
				} else if (
					'--'.startsWith(rest) ||
					'doctype'.startsWith(rest) ||
					'[cdata['.startsWith(rest)
				)
					return anchor;
				else state = State.BogusComment;
				break;
			}
			case State.BogusComment:
				if (c === '>') state = State.Data;
				i++;
				break;
			case State.Comment: {
				// ends at the first `>` preceded by `--` or `--!`, the opener's
				// dashes included (`<!-->` and `<!--->` are whole comments)
				let j = i;
				for (; j < n; j++) {
					if (text[j] !== '>') continue;
					const before = text.slice(anchor + 2, j);
					if (before.endsWith('--') || before.endsWith('--!')) break;
				}
				if (j >= n) return anchor;
				i = j + 1;
				state = State.Data;
				break;
			}
			case State.CDATASection: {
				const end = text.indexOf(']]>', i);
				if (end === -1) return anchor;
				i = end + 3;
				state = State.Data;
				break;
			}
			case State.RawText: {
				if (c !== '<') {
					if (
						rawTag === 'script' &&
						escaped &&
						c === '-' &&
						text.startsWith('-->', i)
					) {
						escaped = false;
						doubleEscaped = false;
						i += 3;
					} else i++;
					break;
				}
				if (rawTag === 'script') {
					if (!escaped && text.startsWith('<!--', i)) {
						escaped = true;
						i += 4;
						break;
					}
					if (
						escaped &&
						!doubleEscaped &&
						startsWithIgnoreCase(text, i, '<script') &&
						endsName(text[i + 7])
					) {
						doubleEscaped = true;
						i += 7;
						break;
					}
				}
				if (
					startsWithIgnoreCase(text, i, '</' + rawTag) &&
					endsName(text[i + 2 + rawTag.length])
				) {
					if (doubleEscaped) {
						// `</script>` inside the double escape is script text
						doubleEscaped = false;
						i += 2 + rawTag.length;
						break;
					}
					i += 2 + rawTag.length;
					tagName = rawTag;
					endTag = true;
					state = State.TagName;
					break;
				}
				i++;
				break;
			}
		}
	}

	// text is complete as it stands: a character reference cut in two
	// (`&am` + `p;`) is not held, since the browser emits `Q&A` where it is
	// written and holding `&A` would move it behind the rest of the page
	return state === State.Data ? n : anchor;
}
