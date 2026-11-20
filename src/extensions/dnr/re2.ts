// RE2 as Chromium's declarativeNetRequest runs it, for regexFilter: a port of
// the parser, simplifier and compiler of google/re2 at the revision Chromium
// pins (2da0056814cf180480a19f5cf811e7e1c054bf6d), with the options of
// CreateRE2Options (extensions/browser/api/declarative_net_request/utils.cc):
// Latin-1 encoding, case_sensitive per rule, never_capture unless the rule has
// a regexSubstitution, max_mem 2 KiB. compileRE2 answers what RE2::Init
// answers (ok, an error code, ProgramSize()) and translates the pattern into
// a JS RegExp that matches like RE2 (leftmost-first) on ASCII text, which a
// canonical request URL always is. The service worker runs it.
//
// Latin-1 shapes everything here: the pattern's UTF-8 bytes are its runes
// (what RE2 sees when Chromium hands it a std::string), no rune is above
// 0xFF, so a character class is a 256-bit set, case folding is ASCII only and
// a class compiles to one byte range per run, without UTF-8 expansion.

export interface RE2Options {
	/** RE2::Options::set_case_sensitive */
	caseSensitive: boolean;
	/** Chromium: set_never_capture(!requireCapturing) */
	requireCapturing: boolean;
	/** default 2048 (Chromium kRegexMaxMemKb << 10) */
	maxMem?: number;
}

export type RE2Result =
	| {
			ok: true;
			source: string;
			flags: string;
			/** RE2::NumberOfCapturingGroups(); the RegExp has as many groups */
			groups: number;
			/** RE2::ProgramSize() */
			programSize: number;
			/** lowercase literals every match contains (AND) */
			required: string[];
			/** lowercase literals of which every match contains one (OR), null when unknown */
			anyOf: string[] | null;
			/**
			 * whether the RegExp's match and group spans are RE2's on every
			 * input; false when the pattern repeats a group that can match
			 * empty or repeats a capturing group, where JS rules differ (an
			 * empty iteration is refused, captures reset per iteration). Its
			 * matches still agree; for spans pass an RE2Pattern to replaceFirst.
			 */
			exact: boolean;
	  }
	| {
			ok: false;
			reason: 'syntaxError' | 'memoryLimitExceeded';
			error: string;
			/** RE2::ErrorCode */
			code: number;
	  };

/** a pattern to run on RE2's own program (exact spans, slower) */
export interface RE2Pattern {
	pattern: string;
	options: RE2Options;
}

// ---- parse flags (regexp.h)
const FoldCase = 1;
const ClassNL = 4;
const DotNL = 8;
const OneLine = 16;
const Latin1 = 32;
const NonGreedy = 64;
const PerlClasses = 128;
const PerlB = 256;
const PerlX = 512;
const UnicodeGroups = 1024;
const NeverCapture = 4096;
const WasDollar = 8192;
const LikePerl =
	ClassNL | OneLine | PerlClasses | PerlB | PerlX | UnicodeGroups;

// ---- ops (RegexpOp)
const NoMatch = 1;
const EmptyMatch = 2;
const Lit = 3;
const LitStr = 4;
const Concat = 5;
const Alternate = 6;
const Star = 7;
const Plus = 8;
const Quest = 9;
const Repeat = 10;
const Capture = 11;
const AnyChar = 12;
const AnyByte = 13;
const BeginLine = 14;
const EndLine = 15;
const WordB = 16;
const NoWordB = 17;
const BeginText = 18;
const EndText = 19;
const CharClass = 20;
const LeftParen = 22;
const VBar = 23;

// ---- RE2::ErrorCode
const ErrBadEscape = 2;
const ErrBadCharRange = 4;
const ErrMissingBracket = 5;
const ErrMissingParen = 6;
const ErrUnexpectedParen = 7;
const ErrTrailingBackslash = 8;
const ErrRepeatArgument = 9;
const ErrRepeatSize = 10;
const ErrRepeatOp = 11;
const ErrBadPerlOp = 12;
const ErrBadUTF8 = 13;
const ErrBadNamedCapture = 14;
const ErrPatternTooLarge = 15;
const errorText = [
	'',
	'unexpected error',
	'invalid escape sequence',
	'invalid character class',
	'invalid character class range',
	'missing ]',
	'missing )',
	'unexpected )',
	'trailing \\',
	'no argument for repetition operator',
	'invalid repetition size',
	'bad repetition operator',
	'invalid perl operator',
	'invalid UTF-8',
	'invalid named capture group',
	'pattern too large - compile failed',
];

class ParseError {
	constructor(public code: number) {}
}

// ---- character classes: a set of Latin-1 runes. RE2 removes every rune
// above rune_max (0xFF) before a class is used, so that is all a class holds.
type CC = Uint8Array;
const ccNew = (): CC => new Uint8Array(256);
function ccAdd(cc: CC, lo: number, hi: number) {
	for (let r = lo, e = Math.min(hi, 255); r <= e; r++) cc[r] = 1;
}
/** CharClassBuilder::AddRangeFlags (ClassNL is always on, NeverNL off) */
function ccAddFlags(cc: CC, lo: number, hi: number, flags: number) {
	if (!(flags & FoldCase)) return ccAdd(cc, lo, hi);
	for (let r = lo, e = Math.min(hi, 255); r <= e; r++) {
		cc[r] = 1;
		if (r >= 65 && r <= 90) cc[r + 32] = 1;
		if (r >= 97 && r <= 122) cc[r - 32] = 1;
	}
}
function ccSize(cc: CC) {
	let n = 0;
	for (let r = 0; r < 256; r++) n += cc[r];
	return n;
}
function ccRanges(cc: CC) {
	const out: number[] = [];
	for (let r = 0; r < 256; r++)
		if (cc[r]) {
			const lo = r;
			while (r < 255 && cc[r + 1]) r++;
			out.push(lo, r);
		}
	return out;
}
function ccFoldsASCII(cc: CC) {
	for (let r = 65; r <= 90; r++) if (cc[r] !== cc[r + 32]) return false;
	return true;
}
function ccEqual(a: CC, b: CC) {
	for (let r = 0; r < 256; r++) if (a[r] !== b[r]) return false;
	return true;
}

// ---- groups: Perl, POSIX and Unicode (Latin-1 part of each, as hex ranges)
type Group = [sign: number, ranges: number[]];
const hexRanges = (s: string) =>
	s
		? s.split(',').flatMap((r) => r.split('-').map((x) => parseInt(x, 16)))
		: [];
const perlGroups: Record<string, string> = {
	d: '30-39',
	s: '9-a,c-d,20-20',
	w: '30-39,41-5a,5f-5f,61-7a',
};
const posixGroups: Record<string, string> = {
	alnum: '30-39,41-5a,61-7a',
	alpha: '41-5a,61-7a',
	ascii: '0-7f',
	blank: '9-9,20-20',
	cntrl: '0-1f,7f-7f',
	digit: '30-39',
	graph: '21-7e',
	lower: '61-7a',
	print: '20-7e',
	punct: '21-2f,3a-40,5b-60,7b-7e',
	space: '9-d,20-20',
	upper: '41-5a',
	word: '30-39,41-5a,5f-5f,61-7a',
	xdigit: '30-39,41-46,61-66',
};
// unicode_groups.cc clipped to Latin-1: every group not listed here has no
// rune below 0x100 (generated by re2-oracle/gen-groups.mjs)
const unicodeLatin1: Record<string, string> = {
	Any: '0-ff',
	C: '0-1f,7f-9f,ad-ad',
	Cc: '0-1f,7f-9f',
	Cf: 'ad-ad',
	Common: '0-40,5b-60,7b-a9,ab-b9,bb-bf,d7-d7,f7-f7',
	L: '41-5a,61-7a,aa-aa,b5-b5,ba-ba,c0-d6,d8-f6,f8-ff',
	Latin: '41-5a,61-7a,aa-aa,ba-ba,c0-d6,d8-f6,f8-ff',
	Ll: '61-7a,b5-b5,df-f6,f8-ff',
	Lo: 'aa-aa,ba-ba',
	Lu: '41-5a,c0-d6,d8-de',
	N: '30-39,b2-b3,b9-b9,bc-be',
	Nd: '30-39',
	No: 'b2-b3,b9-b9,bc-be',
	P: '21-23,25-2a,2c-2f,3a-3b,3f-40,5b-5d,5f-5f,7b-7b,7d-7d,a1-a1,a7-a7,ab-ab,b6-b7,bb-bb,bf-bf',
	Pc: '5f-5f',
	Pd: '2d-2d',
	Pe: '29-29,5d-5d,7d-7d',
	Pf: 'bb-bb',
	Pi: 'ab-ab',
	Po: '21-23,25-27,2a-2a,2c-2c,2e-2f,3a-3b,3f-40,5c-5c,a1-a1,a7-a7,b6-b7,bf-bf',
	Ps: '28-28,5b-5b,7b-7b',
	S: '24-24,2b-2b,3c-3e,5e-5e,60-60,7c-7c,7e-7e,a2-a6,a8-a9,ac-ac,ae-b1,b4-b4,b8-b8,d7-d7,f7-f7',
	Sc: '24-24,a2-a5',
	Sk: '5e-5e,60-60,a8-a8,af-af,b4-b4,b8-b8',
	Sm: '2b-2b,3c-3e,7c-7c,7e-7e,ac-ac,b1-b1,d7-d7,f7-f7',
	So: 'a6-a6,a9-a9,ae-ae,b0-b0',
	Z: '20-20,a0-a0',
	Zs: '20-20,a0-a0',
};
const unicodeEmpty = new Set(
	(
		'Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak ' +
		'Bengali Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian ' +
		'Caucasian_Albanian Chakma Cham Cherokee Chorasmian Co Coptic Cs Cuneiform Cypriot ' +
		'Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs ' +
		'Elbasan Elymaic Ethiopic Georgian Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi ' +
		'Gurmukhi Han Hangul Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic ' +
		'Inherited Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Katakana ' +
		'Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Lao Lepcha Limbu ' +
		'Linear_A Linear_B Lisu Lm Lt Lycian Lydian M Mahajani Makasar Malayalam Mandaic Manichaean ' +
		'Marchen Masaram_Gondi Mc Me Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive ' +
		'Meroitic_Hieroglyphs Miao Mn Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari ' +
		'Nandinagari New_Tai_Lue Newa Nko Nl Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki ' +
		'Old_Hungarian Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian ' +
		'Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya Pahawh_Hmong Palmyrene ' +
		'Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic Samaritan Saurashtra Sharada ' +
		'Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng Soyombo Sundanese Syloti_Nagri ' +
		'Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Takri Tamil Tangsa Tangut Telugu Thaana ' +
		'Thai Tibetan Tifinagh Tirhuta Toto Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi ' +
		'Zanabazar_Square Zl Zp'
	).split(' '),
);
function lookupUnicode(name: string): Group | null {
	if (Object.hasOwn(unicodeLatin1, name))
		return [1, hexRanges(unicodeLatin1[name])];
	return unicodeEmpty.has(name) ? [1, []] : null;
}
function lookupPosix(name: string): Group | null {
	// "[:alpha:]" or "[:^alpha:]"
	const neg = name[2] === '^';
	const key = name.slice(neg ? 3 : 2, -2);
	if (!Object.hasOwn(posixGroups, key)) return null;
	return [neg ? -1 : 1, hexRanges(posixGroups[key])];
}
function lookupPerl(c: number): Group | null {
	const lower = c | 32;
	const key = String.fromCharCode(lower);
	if (!Object.hasOwn(perlGroups, key) || (c !== lower && c !== lower - 32))
		return null;
	return [c === lower ? 1 : -1, hexRanges(perlGroups[key])];
}
/** AddUGroup */
function addGroup(cc: CC, g: Group, sign: number, flags: number) {
	const r = g[1];
	if (sign > 0) {
		for (let i = 0; i < r.length; i += 2) ccAddFlags(cc, r[i], r[i + 1], flags);
		return;
	}
	if (flags & FoldCase) {
		const tmp = ccNew();
		addGroup(tmp, g, 1, flags);
		for (let i = 0; i < 256; i++) if (!tmp[i]) cc[i] = 1;
		return;
	}
	let next = 0;
	for (let i = 0; i < r.length; i += 2) {
		if (next < r[i]) ccAddFlags(cc, next, r[i] - 1, flags);
		next = r[i + 1] + 1;
	}
	ccAddFlags(cc, next, 255, flags);
}
// capture names: Lu Ll Lt Lm Lo Nl Mn Mc Nd Pc, as Latin-1
const nameRunes = hexRanges(
	'30-39,41-5a,5f-5f,61-7a,aa-aa,b5-b5,ba-ba,c0-d6,d8-f6,f8-ff',
);
function validCaptureName(name: number[]) {
	if (!name.length) return false;
	return name.every((r) => {
		for (let i = 0; i < nameRunes.length; i += 2)
			if (r >= nameRunes[i] && r <= nameRunes[i + 1]) return true;
		return false;
	});
}

// ---- Regexp
class Re {
	sub: Re[] = [];
	rune = 0;
	runes: number[] = [];
	min = 0;
	max = 0;
	cap = 0;
	name: string | null = null;
	cc: CC | null = null;
	simple = false;
	down: Re | null = null;
	constructor(
		public op: number,
		public flags: number,
	) {}
}
const isMarker = (op: number) => op >= LeftParen;
const isEmptyOp = (re: Re) =>
	re.op === BeginLine ||
	re.op === EndLine ||
	re.op === WordB ||
	re.op === NoWordB ||
	re.op === BeginText ||
	re.op === EndText;

function computeSimple(re: Re): boolean {
	switch (re.op) {
		case Concat:
		case Alternate:
			return re.sub.every((s) => s.simple);
		case CharClass:
			// never full: a Latin-1 class has at most 256 of Runemax+1 runes
			return ccSize(re.cc!) > 0;
		case Capture:
			return re.sub[0].simple;
		case Star:
		case Plus:
		case Quest: {
			const s = re.sub[0];
			if (!s.simple) return false;
			return !(
				s.op === Star ||
				s.op === Plus ||
				s.op === Quest ||
				s.op === EmptyMatch ||
				s.op === NoMatch
			);
		}
		case Repeat:
			return false;
	}
	return true;
}

function newLiteralString(runes: number[], flags: number) {
	if (runes.length === 0) return new Re(EmptyMatch, flags);
	if (runes.length === 1) {
		const re = new Re(Lit, flags);
		re.rune = runes[0];
		return re;
	}
	const re = new Re(LitStr, flags);
	re.runes = runes.slice();
	return re;
}
function newNode(op: number, sub: Re[], flags: number) {
	const re = new Re(op, flags);
	re.sub = sub;
	return re;
}
/** Regexp::StarPlusOrQuest */
function starPlusOrQuest(op: number, sub: Re, flags: number) {
	if (op === sub.op && flags === sub.flags) return sub;
	if (
		(sub.op === Star || sub.op === Plus || sub.op === Quest) &&
		flags === sub.flags
	) {
		if (sub.op === Star) return sub;
		return newNode(Star, [sub.sub[0]], flags);
	}
	return newNode(op, [sub], flags);
}
/** Regexp::ConcatOrAlternate (kMaxNsub splitting is not modelled) */
function concatOrAlternate(
	op: number,
	sub: Re[],
	flags: number,
	canFactor: boolean,
): Re {
	if (sub.length === 1) return sub[0];
	if (sub.length === 0)
		return new Re(op === Alternate ? NoMatch : EmptyMatch, flags);
	if (op === Alternate && canFactor) {
		sub = factorAlternation(sub.slice(), flags);
		if (sub.length === 1) return sub[0];
	}
	return newNode(op, sub, flags);
}

function topEqual(a: Re, b: Re): boolean {
	if (a.op !== b.op) return false;
	switch (a.op) {
		case EndText:
			return ((a.flags ^ b.flags) & WasDollar) === 0;
		case Lit:
			return a.rune === b.rune && ((a.flags ^ b.flags) & FoldCase) === 0;
		case LitStr:
			return (
				((a.flags ^ b.flags) & FoldCase) === 0 &&
				a.runes.length === b.runes.length &&
				a.runes.every((r, i) => r === b.runes[i])
			);
		case Alternate:
		case Concat:
			return a.sub.length === b.sub.length;
		case Star:
		case Plus:
		case Quest:
			return ((a.flags ^ b.flags) & NonGreedy) === 0;
		case Repeat:
			return (
				((a.flags ^ b.flags) & NonGreedy) === 0 &&
				a.min === b.min &&
				a.max === b.max
			);
		case Capture:
			return a.cap === b.cap && a.name === b.name;
		case CharClass:
			return ccEqual(a.cc!, b.cc!);
	}
	return true;
}
function equal(a: Re | null, b: Re | null): boolean {
	if (!a || !b) return a === b;
	if (!topEqual(a, b)) return false;
	for (let i = 0; i < a.sub.length; i++)
		if (!equal(a.sub[i], b.sub[i])) return false;
	return true;
}

// ---- alternation factoring (parse.cc FactorAlternation)
function leadingString(re: Re): [number[], number] {
	while (re.op === Concat && re.sub.length > 0) re = re.sub[0];
	const flags = re.flags & (FoldCase | Latin1);
	if (re.op === Lit) return [[re.rune], flags];
	if (re.op === LitStr) return [re.runes, flags];
	return [[], flags];
}
function removeLeadingString(re: Re, n: number) {
	const stk: Re[] = [];
	while (re.op === Concat) {
		if (stk.length < 4) stk.push(re);
		re = re.sub[0];
	}
	if (re.op === Lit) {
		re.rune = 0;
		re.op = EmptyMatch;
	} else if (re.op === LitStr) {
		if (n >= re.runes.length) {
			re.runes = [];
			re.op = EmptyMatch;
		} else if (n === re.runes.length - 1) {
			re.rune = re.runes[re.runes.length - 1];
			re.runes = [];
			re.op = Lit;
		} else {
			re.runes = re.runes.slice(n);
		}
	}
	while (stk.length) {
		re = stk.pop()!;
		if (re.sub[0].op === EmptyMatch) {
			if (re.sub.length === 2) Object.assign(re, re.sub[1]);
			else re.sub = re.sub.slice(1);
		}
	}
}
function leadingRegexp(re: Re): Re | null {
	if (re.op === EmptyMatch) return null;
	if (re.op === Concat && re.sub.length >= 2) {
		if (re.sub[0].op === EmptyMatch) return null;
		return re.sub[0];
	}
	return re;
}
function removeLeadingRegexp(re: Re): Re {
	if (re.op === EmptyMatch) return re;
	if (re.op === Concat && re.sub.length >= 2) {
		if (re.sub[0].op === EmptyMatch) return re;
		if (re.sub.length === 2) return re.sub[1];
		re.sub = re.sub.slice(1);
		return re;
	}
	return new Re(EmptyMatch, re.flags);
}
type Splice = { prefix: Re; start: number; n: number };
function factorAlternation(sub: Re[], flags: number): Re[] {
	for (let round = 1; round <= 3; round++) {
		const splices: Splice[] = [];
		let start = 0;
		if (round === 1) {
			let rune: number[] = [];
			let nrune = 0;
			let runeflags = 0;
			for (let i = 0; i <= sub.length; i++) {
				let runeI: number[] = [];
				let flagsI = 0;
				if (i < sub.length) {
					[runeI, flagsI] = leadingString(sub[i]);
					if (flagsI === runeflags) {
						let same = 0;
						while (
							same < nrune &&
							same < runeI.length &&
							rune[same] === runeI[same]
						)
							same++;
						if (same > 0) {
							nrune = same;
							continue;
						}
					}
				}
				if (i - start >= 2) {
					const prefix = newLiteralString(rune.slice(0, nrune), runeflags);
					for (let j = start; j < i; j++) removeLeadingString(sub[j], nrune);
					splices.push({ prefix, start, n: i - start });
				}
				if (i < sub.length) {
					start = i;
					rune = runeI.slice();
					nrune = runeI.length;
					runeflags = flagsI;
				}
			}
		} else if (round === 2) {
			let first: Re | null = null;
			for (let i = 0; i <= sub.length; i++) {
				let firstI: Re | null = null;
				if (i < sub.length) {
					firstI = leadingRegexp(sub[i]);
					if (
						first &&
						(isEmptyOp(first) ||
							first.op === CharClass ||
							first.op === AnyChar ||
							first.op === AnyByte ||
							(first.op === Repeat &&
								first.min === first.max &&
								(first.sub[0].op === Lit ||
									first.sub[0].op === CharClass ||
									first.sub[0].op === AnyChar ||
									first.sub[0].op === AnyByte))) &&
						equal(first, firstI)
					)
						continue;
				}
				if (i - start >= 2) {
					const prefix = first!;
					for (let j = start; j < i; j++) sub[j] = removeLeadingRegexp(sub[j]);
					splices.push({ prefix, start, n: i - start });
				}
				if (i < sub.length) {
					start = i;
					first = firstI;
				}
			}
		} else {
			let first: Re | null = null;
			const litOrClass = (re: Re) => re.op === Lit || re.op === CharClass;
			for (let i = 0; i <= sub.length; i++) {
				let firstI: Re | null = null;
				if (i < sub.length) {
					firstI = sub[i];
					if (first && litOrClass(first) && litOrClass(firstI)) continue;
				}
				if (i - start >= 2) {
					const cc = ccNew();
					for (let j = start; j < i; j++) {
						const re = sub[j];
						if (re.op === CharClass)
							for (let r = 0; r < 256; r++) cc[r] |= re.cc![r];
						else ccAddFlags(cc, re.rune, re.rune, re.flags);
					}
					const prefix = new Re(CharClass, flags & ~FoldCase);
					prefix.cc = cc;
					splices.push({ prefix, start, n: i - start });
				}
				if (i < sub.length) {
					start = i;
					first = firstI;
				}
			}
		}
		if (!splices.length) continue;
		const out: Re[] = [];
		let i = 0;
		for (const s of splices) {
			while (i < s.start) out.push(sub[i++]);
			if (round === 3) out.push(s.prefix);
			else {
				const suffixes = factorAlternation(
					sub.slice(s.start, s.start + s.n),
					flags,
				);
				out.push(
					newNode(
						Concat,
						[s.prefix, concatOrAlternate(Alternate, suffixes, flags, false)],
						flags,
					),
				);
			}
			i += s.n;
		}
		while (i < sub.length) out.push(sub[i++]);
		sub = out;
	}
	return sub;
}

// ---- parser (parse.cc)
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlnum = (c: number) =>
	isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isHex = (c: number) =>
	isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const unHex = (c: number) => (c <= 57 ? c - 48 : (c | 32) - 87);

/** RepetitionWalker: whether nested repeats stay within 1000 copies */
function repetitionOk(re: Re, arg: number): number {
	if (re.op === Repeat) {
		const m = re.max < 0 ? re.min : re.max;
		if (m > 0) arg = Math.trunc(arg / m);
	}
	let out = arg;
	for (const s of re.sub) out = Math.min(out, repetitionOk(s, arg));
	return out;
}

class Parser {
	stacktop: Re | null = null;
	ncap = 0;
	p = 0;
	constructor(
		public t: number[],
		public flags: number,
	) {}

	fail(code: number): never {
		throw new ParseError(code);
	}

	pushRegexp(re: Re) {
		this.maybeConcatString(-1, 0);
		if (re.op === CharClass && re.cc) {
			const n = ccSize(re.cc);
			const lo = re.cc.indexOf(1);
			if (n === 1) {
				re = new Re(Lit, this.flags);
				re.rune = lo;
			} else if (n === 2 && lo >= 65 && lo <= 90 && re.cc[lo + 32]) {
				re = new Re(Lit, this.flags | FoldCase);
				re.rune = lo + 32;
			}
		}
		if (!isMarker(re.op)) re.simple = computeSimple(re);
		re.down = this.stacktop;
		this.stacktop = re;
	}

	pushLiteral(r: number) {
		if (
			this.flags & FoldCase &&
			((r >= 65 && r <= 90) || (r >= 97 && r <= 122))
		) {
			const re = new Re(CharClass, this.flags & ~FoldCase);
			re.cc = ccNew();
			ccAddFlags(re.cc, r, r, FoldCase);
			return this.pushRegexp(re);
		}
		if (this.maybeConcatString(r, this.flags)) return;
		const re = new Re(Lit, this.flags);
		re.rune = r;
		this.pushRegexp(re);
	}

	pushSimple(op: number, flags = this.flags) {
		this.pushRegexp(new Re(op, flags));
	}

	pushDot() {
		if (this.flags & DotNL) return this.pushSimple(AnyChar);
		const re = new Re(CharClass, this.flags & ~FoldCase);
		re.cc = ccNew();
		ccAdd(re.cc, 0, 9);
		ccAdd(re.cc, 11, 255);
		this.pushRegexp(re);
	}

	pushRepeatOp(op: number, nongreedy: boolean) {
		const top = this.stacktop;
		if (!top || isMarker(top.op)) this.fail(ErrRepeatArgument);
		const fl = nongreedy ? this.flags ^ NonGreedy : this.flags;
		if (op === top.op && fl === top.flags) return;
		if (
			(top.op === Star || top.op === Plus || top.op === Quest) &&
			fl === top.flags
		) {
			top.op = Star;
			return;
		}
		const re = newNode(op, [top], fl);
		re.down = top.down;
		top.down = null;
		re.simple = computeSimple(re);
		this.stacktop = re;
	}

	pushRepetition(min: number, max: number, nongreedy: boolean) {
		if ((max !== -1 && max < min) || min > 1000 || max > 1000)
			this.fail(ErrRepeatSize);
		const top = this.stacktop;
		if (!top || isMarker(top.op)) this.fail(ErrRepeatArgument);
		const re = newNode(
			Repeat,
			[top],
			nongreedy ? this.flags ^ NonGreedy : this.flags,
		);
		re.min = min;
		re.max = max;
		re.down = top.down;
		top.down = null;
		re.simple = computeSimple(re);
		this.stacktop = re;
		if ((min >= 2 || max >= 2) && repetitionOk(re, 1000) === 0)
			this.fail(ErrRepeatSize);
	}

	doLeftParen(name: string | null) {
		const re = new Re(LeftParen, this.flags);
		re.cap = ++this.ncap;
		re.name = name;
		this.pushRegexp(re);
	}

	doLeftParenNoCapture() {
		const re = new Re(LeftParen, this.flags);
		re.cap = -1;
		this.pushRegexp(re);
	}

	doVerticalBar() {
		this.maybeConcatString(-1, 0);
		this.doConcatenation();
		const r1 = this.stacktop;
		const r2 = r1?.down;
		if (r1 && r2 && r2.op === VBar) {
			const r3 = r2.down;
			const single = (re: Re) =>
				re.op === Lit || re.op === CharClass || re.op === AnyChar;
			if (r3 && (r1.op === AnyChar || r3.op === AnyChar)) {
				if (r3.op === AnyChar && single(r1)) {
					this.stacktop = r2;
					return;
				}
				if (r1.op === AnyChar && single(r3)) {
					r1.down = r3.down;
					r2.down = r1;
					this.stacktop = r2;
					return;
				}
			}
			r1.down = r2.down;
			r2.down = r1;
			this.stacktop = r2;
			return;
		}
		this.pushSimple(VBar);
	}

	doRightParen() {
		this.doAlternation();
		const r1 = this.stacktop;
		const r2 = r1?.down;
		if (!r1 || !r2 || r2.op !== LeftParen) this.fail(ErrUnexpectedParen);
		this.stacktop = r2.down;
		this.flags = r2.flags;
		let re: Re = r2;
		if (re.cap > 0) {
			re.op = Capture;
			r1.down = null;
			re.sub = [r1];
			re.simple = computeSimple(re);
		} else re = r1;
		this.pushRegexp(re);
	}

	doFinish() {
		this.doAlternation();
		const re = this.stacktop!;
		if (re.down) this.fail(ErrMissingParen);
		this.stacktop = null;
		return re;
	}

	doCollapse(op: number) {
		const items: Re[] = [];
		let sub = this.stacktop;
		while (sub && !isMarker(sub.op)) {
			items.push(sub);
			sub = sub.down;
		}
		const next = sub;
		if (this.stacktop && this.stacktop.down === next) return;
		const subs: Re[] = [];
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i];
			it.down = null;
			if (it.op === op) subs.push(...it.sub);
			else subs.push(it);
		}
		const re = concatOrAlternate(op, subs, this.flags, true);
		re.simple = computeSimple(re);
		re.down = next;
		this.stacktop = re;
	}

	doConcatenation() {
		const r1 = this.stacktop;
		if (!r1 || isMarker(r1.op)) this.pushRegexp(new Re(EmptyMatch, this.flags));
		this.doCollapse(Concat);
	}

	doAlternation() {
		this.doVerticalBar();
		this.stacktop = this.stacktop!.down;
		this.doCollapse(Alternate);
	}

	maybeConcatString(r: number, flags: number) {
		const re1 = this.stacktop;
		const re2 = re1?.down;
		if (!re1 || !re2) return false;
		if (re1.op !== Lit && re1.op !== LitStr) return false;
		if (re2.op !== Lit && re2.op !== LitStr) return false;
		if ((re1.flags & FoldCase) !== (re2.flags & FoldCase)) return false;
		if (re2.op === Lit) {
			re2.op = LitStr;
			re2.runes = [re2.rune];
		}
		if (re1.op === Lit) re2.runes.push(re1.rune);
		else {
			re2.runes.push(...re1.runes);
			re1.runes = [];
		}
		if (r >= 0) {
			re1.op = Lit;
			re1.rune = r;
			re1.flags = flags;
			return true;
		}
		this.stacktop = re2;
		return false;
	}

	// lexing
	escape(rmax = 255): number {
		const t = this.t;
		if (this.p + 1 >= t.length) this.fail(ErrTrailingBackslash);
		this.p++;
		let c = t[this.p++];
		const more = () => this.p < t.length;
		switch (c) {
			case 49:
			case 50:
			case 51:
			case 52:
			case 53:
			case 54:
			case 55:
				if (!more() || t[this.p] < 48 || t[this.p] > 55)
					this.fail(ErrBadEscape);
			// falls through
			case 48: {
				let code = c - 48;
				if (more() && t[this.p] >= 48 && t[this.p] <= 55) {
					code = code * 8 + t[this.p++] - 48;
					if (more() && t[this.p] >= 48 && t[this.p] <= 55)
						code = code * 8 + t[this.p++] - 48;
				}
				if (code > rmax) this.fail(ErrBadEscape);
				return code;
			}
			case 120: {
				if (!more()) this.fail(ErrBadEscape);
				c = t[this.p++];
				if (c === 123) {
					if (!more()) this.fail(ErrBadUTF8);
					c = t[this.p++];
					let nhex = 0;
					let code = 0;
					while (isHex(c)) {
						nhex++;
						code = code * 16 + unHex(c);
						if (code > rmax) this.fail(ErrBadEscape);
						if (!more()) this.fail(ErrBadEscape);
						c = t[this.p++];
					}
					if (c !== 125 || nhex === 0) this.fail(ErrBadEscape);
					return code;
				}
				if (!more()) this.fail(ErrBadEscape);
				const c1 = t[this.p++];
				if (!isHex(c) || !isHex(c1)) this.fail(ErrBadEscape);
				return unHex(c) * 16 + unHex(c1);
			}
			case 110:
				return 10;
			case 114:
				return 13;
			case 116:
				return 9;
			case 97:
				return 7;
			case 102:
				return 12;
			case 118:
				return 11;
		}
		if (c < 0x80 && !isAlnum(c)) return c;
		this.fail(ErrBadEscape);
	}

	/** ParseUnicodeGroup, at \p or \P */
	unicodeGroup(cc: CC) {
		const t = this.t;
		let sign = t[this.p + 1] === 80 ? -1 : 1;
		this.p += 2;
		let name: number[] = [];
		if (this.p < t.length) {
			const c = t[this.p++];
			if (c !== 123) name = [c];
			else {
				const end = t.indexOf(125, this.p);
				if (end < 0) this.fail(ErrBadCharRange);
				name = t.slice(this.p, end);
				this.p = end + 1;
			}
		}
		if (name[0] === 94) {
			sign = -sign;
			name = name.slice(1);
		}
		const g = lookupUnicode(String.fromCharCode(...name));
		if (!g) this.fail(ErrBadCharRange);
		addGroup(cc, g, sign, this.flags);
	}

	ccChar(): number {
		if (this.p >= this.t.length) this.fail(ErrMissingBracket);
		if (this.t[this.p] === 92) return this.escape();
		return this.t[this.p++];
	}

	charClass(): Re {
		const t = this.t;
		const re = new Re(CharClass, this.flags & ~FoldCase);
		const cc = (re.cc = ccNew());
		this.p++;
		let negated = false;
		if (this.p < t.length && t[this.p] === 94) {
			this.p++;
			negated = true;
		}
		let first = true;
		while (this.p < t.length && (t[this.p] !== 93 || first)) {
			first = false;
			const left = t.length - this.p;
			if (left > 2 && t[this.p] === 91 && t[this.p + 1] === 58) {
				let q = this.p + 2;
				while (q <= t.length - 2 && (t[q] !== 58 || t[q + 1] !== 93)) q++;
				if (q <= t.length - 2) {
					const name = String.fromCharCode(...t.slice(this.p, q + 2));
					const g = lookupPosix(name);
					if (!g) this.fail(ErrBadCharRange);
					this.p = q + 2;
					addGroup(cc, g, g[0], this.flags);
					continue;
				}
			}
			if (left > 2 && t[this.p] === 92 && (t[this.p + 1] | 32) === 112) {
				this.unicodeGroup(cc);
				continue;
			}
			if (left >= 2 && t[this.p] === 92) {
				const g = lookupPerl(t[this.p + 1]);
				if (g) {
					this.p += 2;
					addGroup(cc, g, g[0], this.flags);
					continue;
				}
			}
			const lo = this.ccChar();
			let hi = lo;
			if (t.length - this.p >= 2 && t[this.p] === 45 && t[this.p + 1] !== 93) {
				this.p++;
				hi = this.ccChar();
				if (hi < lo) this.fail(ErrBadCharRange);
			}
			ccAddFlags(cc, lo, hi, this.flags | ClassNL);
		}
		if (this.p >= t.length) this.fail(ErrMissingBracket);
		this.p++;
		if (negated) for (let r = 0; r < 256; r++) cc[r] ^= 1;
		return re;
	}

	perlFlags() {
		const t = this.t;
		const p = this.p;
		const size = t.length - p;
		if (
			(size > 3 && (t[p + 2] === 61 || t[p + 2] === 33)) ||
			(size > 4 && t[p + 2] === 60 && (t[p + 3] === 61 || t[p + 3] === 33))
		)
			this.fail(ErrBadPerlOp);
		if (
			(size > 4 && t[p + 2] === 80 && t[p + 3] === 60) ||
			(size > 3 && t[p + 2] === 60)
		) {
			const begin = p + (t[p + 2] === 80 ? 4 : 3);
			const end = t.indexOf(62, begin);
			if (end < 0) this.fail(ErrBadNamedCapture);
			const name = t.slice(begin, end);
			if (!validCaptureName(name)) this.fail(ErrBadNamedCapture);
			this.doLeftParen(String.fromCharCode(...name));
			this.p = end + 1;
			return;
		}
		let q = p + 2;
		let negated = false;
		let sawflags = false;
		let nflags = this.flags;
		for (let done = false; !done;) {
			if (q >= t.length) this.fail(ErrBadPerlOp);
			const c = t[q++];
			let bit = 0;
			switch (c) {
				case 105:
					bit = FoldCase;
					break;
				case 109:
					bit = -OneLine;
					break;
				case 115:
					bit = DotNL;
					break;
				case 85:
					bit = NonGreedy;
					break;
				case 45:
					if (negated) this.fail(ErrBadPerlOp);
					negated = true;
					sawflags = false;
					continue;
				case 58:
					this.doLeftParenNoCapture();
					done = true;
					continue;
				case 41:
					done = true;
					continue;
				default:
					this.fail(ErrBadPerlOp);
			}
			sawflags = true;
			// m clears OneLine; -m sets it
			const set = bit > 0 ? !negated : negated;
			nflags = set ? nflags | Math.abs(bit) : nflags & ~Math.abs(bit);
		}
		if (negated && !sawflags) this.fail(ErrBadPerlOp);
		this.flags = nflags;
		this.p = q;
	}

	repetition(): [number, number] | null {
		const t = this.t;
		let q = this.p + 1;
		const int = (): number | null => {
			if (q >= t.length || !isDigit(t[q])) return null;
			if (t.length - q >= 2 && t[q] === 48 && isDigit(t[q + 1])) return null;
			let n = 0;
			while (q < t.length && isDigit(t[q])) {
				if (n >= 100000000) return null;
				n = n * 10 + t[q++] - 48;
			}
			return n;
		};
		const lo = int();
		if (lo === null || q >= t.length) return null;
		let hi: number | null = lo;
		if (t[q] === 44) {
			q++;
			if (q >= t.length) return null;
			if (t[q] === 125) hi = -1;
			else if ((hi = int()) === null) return null;
		}
		if (q >= t.length || t[q] !== 125) return null;
		this.p = q + 1;
		return [lo, hi];
	}

	parse(): Re {
		const t = this.t;
		let lastunary = false;
		while (this.p < t.length) {
			let isunary = false;
			const c = t[this.p];
			switch (c) {
				case 40:
					if (this.flags & PerlX && t[this.p + 1] === 63) {
						this.perlFlags();
						break;
					}
					if (this.flags & NeverCapture) this.doLeftParenNoCapture();
					else this.doLeftParen(null);
					this.p++;
					break;
				case 124:
					this.doVerticalBar();
					this.p++;
					break;
				case 41:
					this.doRightParen();
					this.p++;
					break;
				case 94:
					this.pushSimple(this.flags & OneLine ? BeginText : BeginLine);
					this.p++;
					break;
				case 36:
					if (this.flags & OneLine)
						this.pushSimple(EndText, this.flags | WasDollar);
					else this.pushSimple(EndLine);
					this.p++;
					break;
				case 46:
					this.pushDot();
					this.p++;
					break;
				case 91:
					this.pushRegexp(this.charClass());
					break;
				case 42:
				case 43:
				case 63: {
					this.p++;
					let nongreedy = false;
					if (t[this.p] === 63) {
						nongreedy = true;
						this.p++;
					}
					if (lastunary) this.fail(ErrRepeatOp);
					this.pushRepeatOp(
						c === 42 ? Star : c === 43 ? Plus : Quest,
						nongreedy,
					);
					isunary = true;
					break;
				}
				case 123: {
					const rep = this.repetition();
					if (!rep) {
						this.pushLiteral(123);
						this.p++;
						break;
					}
					let nongreedy = false;
					if (t[this.p] === 63) {
						nongreedy = true;
						this.p++;
					}
					if (lastunary) this.fail(ErrRepeatOp);
					this.pushRepetition(rep[0], rep[1], nongreedy);
					isunary = true;
					break;
				}
				case 92: {
					const c1 = t[this.p + 1];
					if (c1 === 98 || c1 === 66) {
						this.pushSimple(c1 === 98 ? WordB : NoWordB);
						this.p += 2;
						break;
					}
					if (c1 === 65 || c1 === 122 || c1 === 67) {
						this.pushSimple(
							c1 === 65 ? BeginText : c1 === 122 ? EndText : AnyByte,
						);
						this.p += 2;
						break;
					}
					if (c1 === 81) {
						this.p += 2;
						while (this.p < t.length) {
							if (t[this.p] === 92 && t[this.p + 1] === 69) {
								this.p += 2;
								break;
							}
							this.pushLiteral(t[this.p++]);
						}
						break;
					}
					if (c1 === 112 || c1 === 80) {
						const re = new Re(CharClass, this.flags & ~FoldCase);
						re.cc = ccNew();
						this.unicodeGroup(re.cc);
						this.pushRegexp(re);
						break;
					}
					const g = c1 === undefined ? null : lookupPerl(c1);
					if (g) {
						const re = new Re(CharClass, this.flags & ~FoldCase);
						re.cc = ccNew();
						addGroup(re.cc, g, g[0], this.flags);
						this.p += 2;
						this.pushRegexp(re);
						break;
					}
					this.pushLiteral(this.escape());
					break;
				}
				default:
					this.pushLiteral(c);
					this.p++;
			}
			lastunary = isunary;
		}
		return this.doFinish();
	}
}

// ---- simplification (simplify.cc)
function canCoalesce(r1: Re, r2: Re) {
	const loopOp = (re: Re) =>
		re.op === Star || re.op === Plus || re.op === Quest || re.op === Repeat;
	if (!loopOp(r1)) return false;
	const s = r1.sub[0];
	if (!(
		s.op === Lit ||
		s.op === CharClass ||
		s.op === AnyChar ||
		s.op === AnyByte
	))
		return false;
	if (
		loopOp(r2) &&
		equal(s, r2.sub[0]) &&
		((r1.flags ^ r2.flags) & NonGreedy) === 0
	)
		return true;
	if (equal(s, r2)) return true;
	return (
		s.op === Lit &&
		r2.op === LitStr &&
		r2.runes[0] === s.rune &&
		((s.flags ^ r2.flags) & FoldCase) === 0
	);
}
function doCoalesce(args: Re[], i: number) {
	const r1 = args[i];
	const r2 = args[i + 1];
	const nre = newNode(Repeat, [r1.sub[0]], r1.flags);
	if (r1.op === Star) [nre.min, nre.max] = [0, -1];
	else if (r1.op === Plus) [nre.min, nre.max] = [1, -1];
	else if (r1.op === Quest) [nre.min, nre.max] = [0, 1];
	else [nre.min, nre.max] = [r1.min, r1.max];
	let n = 1;
	switch (r2.op) {
		case Star:
			nre.max = -1;
			break;
		case Plus:
			nre.min++;
			nre.max = -1;
			break;
		case Quest:
			if (nre.max !== -1) nre.max++;
			break;
		case Repeat:
			nre.min += r2.min;
			if (r2.max === -1) nre.max = -1;
			else if (nre.max !== -1) nre.max += r2.max;
			break;
		case LitStr: {
			while (n < r2.runes.length && r2.runes[n] === r1.sub[0].rune) n++;
			nre.min += n;
			if (nre.max !== -1) nre.max += n;
			if (n < r2.runes.length) {
				args[i] = nre;
				args[i + 1] = newLiteralString(r2.runes.slice(n), r2.flags);
				return;
			}
			break;
		}
		default:
			nre.min++;
			if (nre.max !== -1) nre.max++;
	}
	args[i] = new Re(EmptyMatch, 0);
	args[i + 1] = nre;
}
function coalesce(re: Re): Re {
	if (!re.sub.length) return re;
	const args = re.sub.map(coalesce);
	const changed = args.some((a, i) => a !== re.sub[i]);
	let can = false;
	if (re.op === Concat)
		for (let i = 0; i + 1 < args.length; i++)
			if (canCoalesce(args[i], args[i + 1])) can = true;
	if (!can) {
		if (!changed) return re;
		const nre = newNode(re.op, args, re.flags);
		nre.min = re.min;
		nre.max = re.max;
		nre.cap = re.cap;
		return nre;
	}
	for (let i = 0; i + 1 < args.length; i++)
		if (canCoalesce(args[i], args[i + 1])) doCoalesce(args, i);
	return newNode(
		Concat,
		args.filter((a) => a.op !== EmptyMatch),
		re.flags,
	);
}
function simplifyRepeat(re: Re, min: number, max: number, f: number): Re {
	if (
		isEmptyOp(re) ||
		((re.op === Concat || re.op === Alternate) && re.sub.every(isEmptyOp))
	) {
		min = Math.min(min, 1);
		max = Math.min(max, 1);
	}
	if (max === -1) {
		if (min === 0) return starPlusOrQuest(Star, re, f);
		if (min === 1) return starPlusOrQuest(Plus, re, f);
		const subs: Re[] = Array(min - 1).fill(re);
		subs.push(starPlusOrQuest(Plus, re, f));
		return concatOrAlternate(Concat, subs, f, false);
	}
	if (min === 0 && max === 0) return new Re(EmptyMatch, f);
	if (min === 1 && max === 1) return re;
	let nre: Re | null = null;
	if (min > 0) nre = concatOrAlternate(Concat, Array(min).fill(re), f, false);
	if (max > min) {
		let suf = starPlusOrQuest(Quest, re, f);
		for (let i = min + 1; i < max; i++)
			suf = starPlusOrQuest(Quest, newNode(Concat, [re, suf], f), f);
		nre = nre ? newNode(Concat, [nre, suf], f) : suf;
	}
	return nre ?? new Re(NoMatch, f);
}
function simplifyWalk(re: Re): Re {
	if (re.simple) return re;
	const args = re.sub.map(simplifyWalk);
	const same = args.every((a, i) => a === re.sub[i]);
	let nre: Re;
	switch (re.op) {
		case Concat:
		case Alternate:
		case Capture:
			if (same) nre = re;
			else {
				nre = newNode(re.op, args, re.flags);
				nre.cap = re.cap;
			}
			break;
		case Star:
		case Plus:
		case Quest: {
			const s = args[0];
			if (s.op === EmptyMatch) return s;
			if (same) nre = re;
			else if (re.op === s.op && re.flags === s.flags) return s;
			else nre = newNode(re.op, args, re.flags);
			break;
		}
		case Repeat: {
			const s = args[0];
			if (s.op === EmptyMatch) return s;
			nre = simplifyRepeat(s, re.min, re.max, re.flags);
			break;
		}
		case CharClass:
			nre = ccSize(re.cc!) ? re : new Re(NoMatch, re.flags);
			break;
		default:
			nre = re;
	}
	nre.simple = true;
	return nre;
}
const simplify = (re: Re) => simplifyWalk(coalesce(re));

// ---- compiler (compile.cc, Latin-1), Prog::Optimize and Prog::Flatten
const IAlt = 0;
const IAltMatch = 1;
const IByte = 2;
const ICap = 3;
const IEmpty = 4;
const IMatch = 5;
const INop = 6;
const IFail = 7;
// EmptyOp
const EBeginLine = 1;
const EEndLine = 2;
const EBeginText = 4;
const EEndText = 8;
const EWordB = 16;
const ENoWordB = 32;

interface Inst {
	op: number;
	out: number;
	out1: number;
	lo: number;
	hi: number;
	fold: boolean;
	arg: number;
}
interface Frag {
	b: number;
	h: number;
	t: number;
	nl: boolean;
}
const noFrag: Frag = { b: 0, h: 0, t: 0, nl: false };
/** sizeof(Prog) and sizeof(Prog::Inst) at this revision on x86-64 Linux */
const sizeofProg = 432;
const sizeofInst = 8;

interface Prog {
	inst: Inst[];
	start: number;
	startUnanchored: number;
	ncap: number;
}

class Compiler {
	inst: Inst[] = [];
	failed = false;
	maxInst: number;
	visits: number;
	range: Frag = noFrag;
	constructor(maxMem: number) {
		this.maxInst = 1;
		this.alloc(1);
		this.inst[0].op = IFail;
		if (maxMem <= 0) this.maxInst = 100000;
		else if (maxMem <= sizeofProg) this.maxInst = 0;
		else
			this.maxInst = Math.min(
				Math.floor((maxMem - sizeofProg) / sizeofInst),
				1 << 24,
			);
		this.visits = 2 * this.maxInst;
	}
	alloc(n: number) {
		if (this.failed || this.inst.length + n > this.maxInst) {
			this.failed = true;
			return -1;
		}
		const id = this.inst.length;
		for (let i = 0; i < n; i++)
			this.inst.push({
				op: IAlt,
				out: 0,
				out1: 0,
				lo: 0,
				hi: 0,
				fold: false,
				arg: 0,
			});
		return id;
	}
	patch(h: number, p: number) {
		while (h) {
			const ip = this.inst[h >> 1];
			if (h & 1) [h, ip.out1] = [ip.out1, p];
			else [h, ip.out] = [ip.out, p];
		}
	}
	append(h1: number, t1: number, h2: number, t2: number): [number, number] {
		if (!h1) return [h2, t2];
		if (!h2) return [h1, t1];
		const ip = this.inst[t1 >> 1];
		if (t1 & 1) ip.out1 = h2;
		else ip.out = h2;
		return [h1, t2];
	}
	one(op: number, f: (ip: Inst) => void, nl: boolean, open = true): Frag {
		const id = this.alloc(1);
		if (id < 0) return noFrag;
		this.inst[id].op = op;
		f(this.inst[id]);
		return open
			? { b: id, h: id << 1, t: id << 1, nl }
			: { b: id, h: 0, t: 0, nl };
	}
	cat(a: Frag, b: Frag): Frag {
		if (!a.b || !b.b) return noFrag;
		const begin = this.inst[a.b];
		if (begin.op === INop && a.h === a.b << 1 && begin.out === 0) {
			this.patch(a.h, b.b);
			return b;
		}
		this.patch(a.h, b.b);
		return { b: a.b, h: b.h, t: b.t, nl: a.nl && b.nl };
	}
	alt(a: Frag, b: Frag): Frag {
		if (!a.b) return b;
		if (!b.b) return a;
		const id = this.alloc(1);
		if (id < 0) return noFrag;
		Object.assign(this.inst[id], { op: IAlt, out: a.b, out1: b.b });
		const [h, t] = this.append(a.h, a.t, b.h, b.t);
		return { b: id, h, t, nl: a.nl || b.nl };
	}
	loop(a: Frag, ng: boolean): [number, number] {
		const id = this.alloc(1);
		if (id < 0) return [-1, 0];
		Object.assign(
			this.inst[id],
			ng ? { out: 0, out1: a.b } : { out: a.b, out1: 0 },
		);
		return [id, ng ? id << 1 : (id << 1) | 1];
	}
	plus(a: Frag, ng: boolean): Frag {
		const [id, pl] = this.loop(a, ng);
		if (id < 0) return noFrag;
		this.patch(a.h, id);
		return { b: a.b, h: pl, t: pl, nl: a.nl };
	}
	star(a: Frag, ng: boolean): Frag {
		if (a.nl) return this.quest(this.plus(a, ng), ng);
		const [id, pl] = this.loop(a, ng);
		if (id < 0) return noFrag;
		this.patch(a.h, id);
		return { b: id, h: pl, t: pl, nl: true };
	}
	quest(a: Frag, ng: boolean): Frag {
		if (!a.b) return this.nop();
		const [id, pl] = this.loop(a, ng);
		if (id < 0) return noFrag;
		const [h, t] = this.append(pl, pl, a.h, a.t);
		return { b: id, h, t, nl: true };
	}
	byteRange(lo: number, hi: number, fold: boolean) {
		return this.one(IByte, (ip) => Object.assign(ip, { lo, hi, fold }), false);
	}
	nop() {
		return this.one(INop, () => {}, true);
	}
	empty(e: number) {
		return this.one(IEmpty, (ip) => (ip.arg = e), true);
	}
	capture(a: Frag, n: number): Frag {
		if (!a.b) return noFrag;
		const id = this.alloc(2);
		if (id < 0) return noFrag;
		Object.assign(this.inst[id], { op: ICap, arg: 2 * n, out: a.b });
		Object.assign(this.inst[id + 1], { op: ICap, arg: 2 * n + 1 });
		this.patch(a.h, id + 1);
		const pl = (id + 1) << 1;
		return { b: id, h: pl, t: pl, nl: a.nl };
	}
	/** a byte range added to the rune range alternation (AddRuneRangeLatin1) */
	addRange(lo: number, hi: number, fold: boolean) {
		if (lo > hi || lo > 255) return;
		const f = this.byteRange(lo, Math.min(hi, 255), fold);
		const [h, t] = this.append(this.range.h, this.range.t, f.h, f.t);
		this.range = { ...this.range, h, t };
		if (this.failed) return;
		if (!this.range.b) {
			this.range.b = f.b;
			return;
		}
		const alt = this.alloc(1);
		if (alt < 0) {
			this.range.b = 0;
			return;
		}
		Object.assign(this.inst[alt], { op: IAlt, out: this.range.b, out1: f.b });
		this.range.b = alt;
	}
	walk(re: Re): Frag {
		if (--this.visits < 0) {
			this.failed = true;
			return noFrag;
		}
		if (this.failed) return noFrag;
		const kids = re.sub.map((s) => this.walk(s));
		if (this.failed) return noFrag;
		const ng = (re.flags & NonGreedy) !== 0;
		const fold = (re.flags & FoldCase) !== 0;
		switch (re.op) {
			case NoMatch:
				return noFrag;
			case EmptyMatch:
				return this.nop();
			case Concat:
				return kids.reduce((f, k) => this.cat(f, k));
			case Alternate:
				return kids.reduce((f, k) => this.alt(f, k));
			case Star:
				return this.star(kids[0], ng);
			case Plus:
				return this.plus(kids[0], ng);
			case Quest:
				return this.quest(kids[0], ng);
			case Lit:
				return this.byteRange(re.rune, re.rune, fold);
			case LitStr: {
				if (!re.runes.length) return this.nop();
				let f = noFrag;
				re.runes.forEach((r, i) => {
					const f1 = this.byteRange(r, r, fold);
					f = i ? this.cat(f, f1) : f1;
				});
				return f;
			}
			case AnyChar:
				this.range = noFrag;
				this.addRange(0, 255, false);
				return this.range;
			case AnyByte:
				return this.byteRange(0, 255, false);
			case CharClass: {
				const cc = re.cc!;
				const foldascii = ccFoldsASCII(cc);
				this.range = noFrag;
				const r = ccRanges(cc);
				for (let i = 0; i < r.length; i += 2) {
					const lo = r[i];
					const hi = r[i + 1];
					if (foldascii && lo >= 65 && hi <= 90) continue;
					let f = foldascii;
					if (
						(lo <= 65 && hi >= 122) ||
						hi < 65 ||
						lo > 122 ||
						(lo > 90 && hi < 97)
					)
						f = false;
					this.addRange(lo, hi, f);
				}
				return this.range;
			}
			case Capture:
				return this.capture(kids[0], re.cap);
			case BeginLine:
				return this.empty(EBeginLine);
			case EndLine:
				return this.empty(EEndLine);
			case BeginText:
				return this.empty(EBeginText);
			case EndText:
				return this.empty(EEndText);
			case WordB:
				return this.empty(EWordB);
			case NoWordB:
				return this.empty(ENoWordB);
		}
		this.failed = true;
		return noFrag;
	}
}

/** IsAnchorStart / IsAnchorEnd: strip a leading \A (or trailing \z) */
function stripAnchor(re: Re, depth: number, end: boolean): Re | null {
	if (depth >= 4) return null;
	if (re.op === Concat && re.sub.length) {
		const i = end ? re.sub.length - 1 : 0;
		const s = stripAnchor(re.sub[i], depth + 1, end);
		if (!s) return null;
		const subs = re.sub.slice();
		subs[i] = s;
		return concatOrAlternate(Concat, subs, re.flags, false);
	}
	if (re.op === Capture) {
		const s = stripAnchor(re.sub[0], depth + 1, end);
		if (!s) return null;
		const c = newNode(Capture, [s], re.flags);
		c.cap = re.cap;
		return c;
	}
	if (re.op === (end ? EndText : BeginText))
		return new Re(EmptyMatch, re.flags);
	return null;
}

/** Compiler::Compile, forward; null when the program does not fit */
function compileProg(re: Re, maxMem: number, anchors: boolean): Prog | null {
	const c = new Compiler(maxMem);
	let sre = simplify(re);
	let anchorStart = false;
	if (anchors) {
		const s = stripAnchor(sre, 0, false);
		if (s) [sre, anchorStart] = [s, true];
		sre = stripAnchor(sre, 0, true) ?? sre;
	}
	let all = c.walk(sre);
	if (c.failed) return null;
	all = c.cat(
		all,
		c.one(IMatch, () => {}, false, false),
	);
	const start = all.b;
	if (anchors && !anchorStart)
		all = c.cat(c.star(c.byteRange(0, 255, false), true), all);
	if (c.failed) return null;
	let ncap = 0;
	for (const ip of c.inst)
		if (ip.op === ICap) ncap = Math.max(ncap, ip.arg >> 1);
	return { inst: c.inst, start, startUnanchored: all.b, ncap };
}

/** Prog::Optimize then Prog::Flatten: the flattened size (ProgramSize) */
function flattenedSize(prog: Prog): number {
	const { inst } = prog;
	if (!prog.start && !prog.startUnanchored) inst.length = 1;
	const walkFrom = (start: number, visit: (id: number, ip: Inst) => void) => {
		const q = new Set<number>();
		if (start) q.add(start);
		for (const id of q) {
			const ip = inst[id];
			visit(id, ip);
			if (ip.out) q.add(ip.out);
			if ((ip.op === IAlt || ip.op === IAltMatch) && ip.out1) q.add(ip.out1);
		}
	};
	const skipNops = (j: number) => {
		while (j && inst[j].op === INop) j = inst[j].out;
		return j;
	};
	walkFrom(prog.start, (id, ip) => {
		ip.out = skipNops(ip.out);
		if (ip.op === IAlt) ip.out1 = skipNops(ip.out1);
	});
	const isMatch = (id: number): boolean => {
		for (;;) {
			const ip = inst[id];
			if (ip.op === ICap || ip.op === INop) id = ip.out;
			else return ip.op === IMatch;
		}
	};
	const anyLoop = (j: Inst, id: number) =>
		j.op === IByte && j.out === id && j.lo === 0 && j.hi === 255;
	walkFrom(prog.start, (id, ip) => {
		if (ip.op !== IAlt) return;
		if (
			(anyLoop(inst[ip.out], id) && isMatch(ip.out1)) ||
			(isMatch(ip.out) && anyLoop(inst[ip.out1], id))
		)
			ip.op = IAltMatch;
	});

	// MarkSuccessors
	const rootmap = new Map<number, number>([[0, 0]]);
	const addRoot = (id: number) =>
		rootmap.has(id) || rootmap.set(id, rootmap.size);
	addRoot(prog.startUnanchored);
	addRoot(prog.start);
	const preds = new Map<number, number[]>();
	const flood = (root: number, onInst: (id: number, ip: Inst) => boolean) => {
		const reach = new Set<number>();
		const stk = [root];
		while (stk.length) {
			let id = stk.pop()!;
			for (;;) {
				if (reach.has(id)) break;
				reach.add(id);
				const ip = inst[id];
				if (!onInst(id, ip)) break;
				if (ip.op === IAlt || ip.op === IAltMatch) stk.push(ip.out1);
				id = ip.out;
			}
		}
		return reach;
	};
	flood(prog.startUnanchored, (id, ip) => {
		if (ip.op === IAlt || ip.op === IAltMatch) {
			for (const out of [ip.out, ip.out1]) {
				if (!preds.has(out)) preds.set(out, []);
				preds.get(out)!.push(id);
			}
			return true;
		}
		if (ip.op === IByte || ip.op === ICap || ip.op === IEmpty) {
			addRoot(ip.out);
			return true;
		}
		return ip.op === INop;
	});
	// MarkDominator, from the greatest root to the least
	const sorted = [...rootmap.keys()].sort((a, b) => a - b);
	for (let i = sorted.length - 1; i > 0; i--) {
		const root = sorted[i];
		if (root === prog.startUnanchored || root === prog.start) continue;
		const reach = flood(
			root,
			(id, ip) =>
				!(id !== root && rootmap.has(id)) &&
				(ip.op === IAlt || ip.op === IAltMatch || ip.op === INop),
		);
		for (const id of reach)
			for (const pred of preds.get(id) ?? []) if (!reach.has(pred)) addRoot(id);
	}
	// EmitList: count what each list holds
	let size = 0;
	for (const root of rootmap.keys())
		flood(root, (id, ip) => {
			if (id !== root && rootmap.has(id)) {
				size++;
				return false;
			}
			if (ip.op === IAltMatch) size++;
			if (ip.op === IAlt || ip.op === IAltMatch || ip.op === INop) return true;
			size++;
			return false;
		});
	return size;
}

// ---- the JS translation
const hex2 = (r: number) => '\\x' + r.toString(16).padStart(2, '0');
function litChar(r: number) {
	if (isAlnum(r)) return String.fromCharCode(r);
	if (r >= 0x20 && r < 0x7f) {
		const ch = String.fromCharCode(r);
		return '\\^$.|?*+()[]{}/'.includes(ch) ? '\\' + ch : ch;
	}
	return hex2(r);
}
function classChar(r: number) {
	if (isAlnum(r)) return String.fromCharCode(r);
	if (r >= 0x20 && r < 0x7f) {
		const ch = String.fromCharCode(r);
		return '\\]^-['.includes(ch) ? '\\' + ch : ch;
	}
	return hex2(r);
}
function classSource(cc: CC): string {
	// the input is ASCII: what a class holds above 0x7F never matters
	const ascii = cc.slice(0, 128);
	let n = 0;
	for (let r = 0; r < 128; r++) n += ascii[r];
	if (n === 128) return '[^]';
	if (n === 0) return '[]';
	const body = (set: Uint8Array) => {
		let s = '';
		const r = ccRanges(set);
		for (let i = 0; i < r.length; i += 2)
			s +=
				r[i] === r[i + 1]
					? classChar(r[i])
					: classChar(r[i]) +
						(r[i + 1] > r[i] + 1 ? '-' : '') +
						classChar(r[i + 1]);
		return s;
	};
	const inv = ascii.map((b) => b ^ 1);
	const pos = body(ascii);
	const neg = body(inv);
	if (n === 1) return litChar(ascii.indexOf(1));
	return neg.length + 1 < pos.length ? `[^${neg}]` : `[${pos}]`;
}

const isLetter = (r: number) => (r >= 65 && r <= 90) || (r >= 97 && r <= 122);
/** whether every letter the tree mentions folds, so the i flag can carry it */
function foldsEverywhere(re: Re): boolean {
	if (
		(re.op === Lit && isLetter(re.rune)) ||
		(re.op === LitStr && re.runes.some(isLetter))
	)
		return (re.flags & FoldCase) !== 0;
	if (re.op === CharClass) return ccFoldsASCII(re.cc!);
	return re.sub.every(foldsEverywhere);
}
const nullable = (re: Re): boolean => {
	switch (re.op) {
		case EmptyMatch:
		case Star:
		case Quest:
		case BeginLine:
		case EndLine:
		case BeginText:
		case EndText:
		case WordB:
		case NoWordB:
			return true;
		case Concat:
			return re.sub.every(nullable);
		case Alternate:
			return re.sub.some(nullable);
		case Plus:
		case Capture:
			return nullable(re.sub[0]);
		case Repeat:
			return re.min === 0 || nullable(re.sub[0]);
	}
	return false;
};
const hasCapture = (re: Re): boolean =>
	re.op === Capture || re.sub.some(hasCapture);

function translate(root: Re, useI: boolean) {
	let exact = true;
	// [source, precedence]: 0 alternation, 1 concatenation, 2 atom
	const lit = (r: number, flags: number) =>
		!useI && flags & FoldCase && isLetter(r)
			? `[${String.fromCharCode(r & ~32)}${String.fromCharCode(r | 32)}]`
			: litChar(r);
	const emit = (re: Re): [string, number] => {
		switch (re.op) {
			case NoMatch:
				return ['[]', 2];
			case EmptyMatch:
				return ['', 1];
			case Lit:
				return [lit(re.rune, re.flags), 2];
			case LitStr:
				return [re.runes.map((r) => lit(r, re.flags)).join(''), 1];
			case Concat:
				return [
					re.sub
						.map((s) => emit(s))
						.map((s) => (s[1] ? s[0] : `(?:${s[0]})`))
						.join(''),
					1,
				];
			case Alternate:
				return [re.sub.map((s) => emit(s)[0]).join('|'), 0];
			case Star:
			case Plus:
			case Quest:
			case Repeat: {
				const s = re.sub[0];
				const many =
					re.op === Star ||
					re.op === Plus ||
					(re.op === Repeat && (re.max < 0 || re.max > 1));
				if (nullable(s) && (re.op !== Repeat || re.max !== re.min))
					exact = false;
				if (many && hasCapture(s)) exact = false;
				const inner = emit(s);
				const operand =
					inner[1] === 2 && !isEmptyOp(s) && s.op !== BeginLine
						? inner[0]
						: `(?:${inner[0]})`;
				const q =
					re.op === Star
						? '*'
						: re.op === Plus
							? '+'
							: re.op === Quest
								? '?'
								: re.min === re.max
									? `{${re.min}}`
									: `{${re.min},${re.max < 0 ? '' : re.max}}`;
				// a quantified operand is not quantifiable again in JS
				return [operand + q + (re.flags & NonGreedy ? '?' : ''), 1];
			}
			case Capture:
				return [`(${emit(re.sub[0])[0]})`, 2];
			case AnyChar:
			case AnyByte:
				return ['[^]', 2];
			case BeginLine:
				return ['(?<![^\\n])', 2];
			case EndLine:
				return ['(?![^\\n])', 2];
			case BeginText:
				return ['^', 2];
			case EndText:
				return ['$', 2];
			case WordB:
				return ['\\b', 2];
			case NoWordB:
				return ['\\B', 2];
			case CharClass:
				return [classSource(re.cc!), 2];
		}
		return ['[]', 2];
	};
	const source = emit(root)[0] || '(?:)';
	return { source, exact };
}

// ---- prefilter: literals every match must contain (like FilteredRE2 atoms)
const MaxExact = 16;
interface Info {
	exact: Set<string> | null;
	and: string[][];
}
const anyInfo = (): Info => ({ exact: null, and: [] });
const lower = (r: number) =>
	String.fromCharCode(r >= 65 && r <= 90 ? r + 32 : r);
function clauses(info: Info): string[][] {
	if (!info.exact) return info.and;
	if (info.exact.has('') || !info.exact.size) return [];
	return [[...info.exact]];
}
const clauseScore = (c: string[]) => Math.min(...c.map((s) => s.length));
function bestClause(cs: string[][]): string[] | null {
	let best: string[] | null = null;
	for (const c of cs)
		if (
			!best ||
			clauseScore(c) > clauseScore(best) ||
			(clauseScore(c) === clauseScore(best) && c.length < best.length)
		)
			best = c;
	return best;
}
function prefilter(re: Re): Info {
	switch (re.op) {
		case Lit:
			return { exact: new Set([lower(re.rune)]), and: [] };
		case LitStr:
			return { exact: new Set([re.runes.map(lower).join('')]), and: [] };
		case EmptyMatch:
		case BeginLine:
		case EndLine:
		case BeginText:
		case EndText:
		case WordB:
		case NoWordB:
			return { exact: new Set(['']), and: [] };
		case CharClass: {
			const set = new Set<string>();
			for (let r = 0; r < 256; r++) if (re.cc![r]) set.add(lower(r));
			return set.size <= 4 ? { exact: set, and: [] } : anyInfo();
		}
		case Capture:
			return prefilter(re.sub[0]);
		case Concat: {
			let acc: Info = { exact: new Set(['']), and: [] };
			for (const s of re.sub) {
				const b = prefilter(s);
				if (acc.exact && b.exact && acc.exact.size * b.exact.size <= MaxExact) {
					const next = new Set<string>();
					for (const x of acc.exact) for (const y of b.exact) next.add(x + y);
					acc = { exact: next, and: [] };
				} else acc = { exact: null, and: [...clauses(acc), ...clauses(b)] };
			}
			return acc;
		}
		case Alternate: {
			const kids = re.sub.map(prefilter);
			if (kids.every((k) => k.exact)) {
				const u = new Set<string>();
				for (const k of kids) for (const s of k.exact!) u.add(s);
				if (u.size <= MaxExact) return { exact: u, and: [] };
			}
			const union = new Set<string>();
			for (const k of kids) {
				const c = bestClause(clauses(k));
				if (!c) return anyInfo();
				for (const s of c) union.add(s);
			}
			return union.size <= 64 ? { exact: null, and: [[...union]] } : anyInfo();
		}
		case Quest: {
			const k = prefilter(re.sub[0]);
			if (k.exact && k.exact.size < MaxExact)
				return { exact: new Set([...k.exact, '']), and: [] };
			return anyInfo();
		}
		case Plus:
			return { exact: null, and: clauses(prefilter(re.sub[0])) };
		case Repeat:
			return re.min > 0
				? { exact: null, and: clauses(prefilter(re.sub[0])) }
				: anyInfo();
	}
	return anyInfo();
}
/** the longest substring (of 3 or more) all of `c` contain, or '' */
function common(c: string[]) {
	const base = c.reduce((a, b) => (b.length < a.length ? b : a));
	for (let n = base.length; n >= 3; n--)
		for (let i = 0; i + n <= base.length; i++) {
			const sub = base.slice(i, i + n);
			if (c.every((s) => s.includes(sub))) return sub;
		}
	return '';
}
function prefilterResult(re: Re) {
	const cs = clauses(prefilter(re)).map((c) => [...new Set(c)]);
	let required = [
		...new Set(cs.map((c) => (c.length === 1 ? c[0] : common(c)))),
	].filter(Boolean);
	required = required.filter(
		(s) => !required.some((t) => t !== s && t.includes(s)),
	);
	const multi = cs.filter(
		(c) => c.length > 1 && !c.some((s) => required.some((r) => r.includes(s))),
	);
	return { required, anyOf: bestClause(multi) };
}

// ---- entry points
/** the pattern as RE2 sees it from Chromium: its UTF-8 bytes, as Latin-1 runes */
function utf8(s: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c < 0x80) {
			out.push(c);
			continue;
		}
		if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d < 0xe000) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
			}
		}
		if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
		if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000)
			out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else
			out.push(
				0xf0 | (c >> 18),
				0x80 | ((c >> 12) & 63),
				0x80 | ((c >> 6) & 63),
				0x80 | (c & 63),
			);
	}
	return out;
}
function parseFlags(o: RE2Options) {
	return (
		ClassNL |
		Latin1 |
		LikePerl |
		(o.requireCapturing ? 0 : NeverCapture) |
		(o.caseSensitive ? 0 : FoldCase)
	);
}
function countCaptures(re: Re): number {
	let n = re.op === Capture ? 1 : 0;
	for (const s of re.sub) n += countCaptures(s);
	return n;
}
/** Regexp::RequiredPrefix: ^literal... runs as a memcmp, not in the program */
function requiredPrefixSuffix(re: Re): Re | null {
	if (re.op !== Concat) return null;
	let i = 0;
	while (i < re.sub.length && re.sub[i].op === BeginText) i++;
	if (i === 0 || i >= re.sub.length) return null;
	const s = re.sub[i];
	if (s.op !== Lit && s.op !== LitStr) return null;
	i++;
	return i < re.sub.length
		? concatOrAlternate(Concat, re.sub.slice(i), re.flags, false)
		: new Re(EmptyMatch, re.flags);
}

function parse(pattern: string, options: RE2Options): Re {
	return new Parser(utf8(pattern), parseFlags(options)).parse();
}

/**
 * RE2::Init as Chromium runs it for a regexFilter, plus the JS translation.
 * `{ ok: false }` is what isRegexSupported reports as unsupported, with
 * `reason` as its UnsupportedRegexReason.
 */
export function compileRE2(pattern: string, options: RE2Options): RE2Result {
	const maxMem = options.maxMem ?? 2048;
	let entire: Re;
	try {
		entire = parse(pattern, options);
	} catch (error) {
		if (!(error instanceof ParseError)) throw error;
		return {
			ok: false,
			reason: 'syntaxError',
			error: errorText[error.code],
			code: error.code,
		};
	}
	let programSize = -1;
	try {
		const prog = compileProg(
			requiredPrefixSuffix(entire) ?? entire,
			Math.floor((maxMem * 2) / 3),
			true,
		);
		if (prog) programSize = flattenedSize(prog);
	} catch (error) {
		// a tree too deep for the stack is far over any program limit
		if (!(error instanceof RangeError)) throw error;
	}
	if (programSize < 0)
		return {
			ok: false,
			reason: 'memoryLimitExceeded',
			error: errorText[ErrPatternTooLarge],
			code: ErrPatternTooLarge,
		};
	const useI = !options.caseSensitive && foldsEverywhere(entire);
	const { source, exact } = translate(entire, useI);
	return {
		ok: true,
		source,
		flags: useI ? 'i' : '',
		groups: countCaptures(entire),
		programSize,
		exact,
		...prefilterResult(entire),
	};
}

/** RE2::CheckRewriteString against a pattern with `groups` capturing groups */
export function checkRewriteString(rewrite: string, groups: number): boolean {
	let max = -1;
	for (let i = 0; i < rewrite.length; i++) {
		if (rewrite[i] !== '\\') continue;
		if (++i === rewrite.length) return false;
		const c = rewrite.charCodeAt(i);
		if (c === 92) continue;
		if (!isDigit(c)) return false;
		max = Math.max(max, c - 48);
	}
	return max <= groups;
}

// exact matching on RE2's program (the Pike VM of nfa.cc), for RE2Pattern
const progCache = new Map<string, Prog | null>();
function programFor(re: RE2Pattern): Prog | null {
	const key = `${+re.options.caseSensitive}${+re.options.requireCapturing}${re.pattern}`;
	let prog = progCache.get(key);
	if (prog === undefined) {
		try {
			prog = compileProg(parse(re.pattern, re.options), 0, false);
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			prog = null;
		}
		if (progCache.size >= 256) progCache.clear();
		progCache.set(key, prog);
	}
	return prog;
}
const isWord = (c: number) => isAlnum(c) || c === 95;
function pikeVM(prog: Prog, s: string): number[] | null {
	const { inst } = prog;
	const n = s.length;
	const at = (p: number) => (p >= 0 && p < n ? s.charCodeAt(p) : -1);
	const mark = new Int32Array(inst.length).fill(-1);
	let gen = 0;
	type Thread = [id: number, caps: number[]];
	const add = (q: Thread[], id0: number, p: number, caps0: number[]) => {
		const stk: Thread[] = [[id0, caps0]];
		while (stk.length) {
			let [id, caps] = stk.pop()!;
			for (;;) {
				if (!id || mark[id] === gen) break;
				mark[id] = gen;
				const ip = inst[id];
				if (ip.op === IAlt || ip.op === IAltMatch) {
					stk.push([ip.out1, caps]);
					id = ip.out;
				} else if (ip.op === ICap) {
					if (ip.arg < caps.length) {
						caps = caps.slice();
						caps[ip.arg] = p;
					}
					id = ip.out;
				} else if (ip.op === IEmpty) {
					const c0 = at(p - 1);
					const c1 = at(p);
					const e = ip.arg;
					if (
						(e & EBeginText && p !== 0) ||
						(e & EEndText && p !== n) ||
						(e & EBeginLine && p !== 0 && c0 !== 10) ||
						(e & EEndLine && p !== n && c1 !== 10) ||
						(e & EWordB && isWord(c0) === isWord(c1)) ||
						(e & ENoWordB && isWord(c0) !== isWord(c1))
					)
						break;
					id = ip.out;
				} else if (ip.op === INop) id = ip.out;
				else {
					q.push([id, caps]);
					break;
				}
			}
		}
	};
	// the list of threads at p is marked with p + 1; a new thread starts
	// at p behind the threads already running (leftmost wins)
	let run: Thread[] = [];
	let matched: number[] | null = null;
	for (let p = 0; p <= n; p++) {
		gen = p + 1;
		if (!matched) {
			const caps = Array(2 * prog.ncap + 2).fill(-1);
			caps[0] = p;
			add(run, prog.start, p, caps);
		}
		if (!run.length) {
			if (matched) break;
			continue;
		}
		const next: Thread[] = [];
		gen = p + 2;
		const c = at(p);
		for (const [id, caps] of run) {
			const ip = inst[id];
			if (ip.op === IMatch) {
				matched = caps.slice();
				matched[1] = p;
				break;
			}
			if (ip.op === IByte && c >= 0) {
				const cf = ip.fold && c >= 65 && c <= 90 ? c + 32 : c;
				if (cf >= ip.lo && cf <= ip.hi) add(next, ip.out, p + 1, caps);
			}
		}
		run = next;
	}
	return matched;
}

/** the spans of the leftmost-first match: [start0, end0, start1, end1, ...], -1 for a group that did not take part */
export function matchSpans(
	input: string,
	re: RegExp | RE2Pattern,
): number[] | null {
	if (re instanceof RegExp) {
		const own = re.hasIndices && !re.global && !re.sticky;
		const m = (
			own ? re : new RegExp(re.source, re.flags.replace(/[dgy]/g, '') + 'd')
		).exec(input);
		if (!m) return null;
		return m.indices!.flatMap((r) => r ?? [-1, -1]);
	}
	const prog = programFor(re);
	return prog ? pikeVM(prog, input) : null;
}

/** RE2::Replace: the first match replaced by `rewrite` (\0..\9, \\); null without a match */
export function replaceFirst(
	input: string,
	re: RegExp | RE2Pattern,
	rewrite: string,
): string | null {
	const spans = matchSpans(input, re);
	if (!spans) return null;
	let max = 0;
	for (let i = 0; i < rewrite.length; i++)
		if (rewrite[i] === '\\') {
			const c = rewrite.charCodeAt(++i);
			if (isDigit(c)) max = Math.max(max, c - 48);
		}
	if (2 * max + 1 >= spans.length) return null;
	let out = '';
	for (let i = 0; i < rewrite.length; i++) {
		if (rewrite[i] !== '\\') {
			out += rewrite[i];
			continue;
		}
		const c = rewrite.charCodeAt(++i);
		if (isDigit(c)) {
			const k = 2 * (c - 48);
			if (spans[k] >= 0) out += input.slice(spans[k], spans[k + 1]);
		} else if (c === 92) out += '\\';
		else return null;
	}
	return input.slice(0, spans[0]) + out + input.slice(spans[1]);
}
