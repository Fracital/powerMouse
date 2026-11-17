// web-platform-tests encoding/: TextDecoder, TextEncoder and their streams
// (wpt-encoding-api), and the documents whose own encoding matters, which
// the proxy decodes and serves again as UTF-8 (wpt-encoding-legacy).
export const sparse = ['encoding', 'common'];

export const include = [
	// the API tests, in a window and in a worker
	/^encoding\/[^/]+\.any\.js(\.headers)?$/,
	/^encoding\/streams\/[^/]+\.(any|window)\.js(\.headers)?$/,
	/^encoding\/streams\/resources\/[^/]+\.js$/,
	/^encoding\/legacy-mb-schinese\/(gbk|gb18030)\/[^/]+\.(any\.js|html)$/,
	'encoding/legacy-mb-schinese/gb18030/resources/ranges.js',
	// documents: byte order marks, the header and the meta declaration,
	// unsupported labels, what a link's query is encoded as
	/^encoding\/[^/]+\.window\.js$/,
	/^encoding\/(bom-handling|remove-only-one-bom|sniffing|utf-32|utf-32-from-win1252|json-document-utf8|big5-encoder|iso-2022-jp-encoder)\.html(\.headers)?$/,
	/^encoding\/resources\/[^/]+\.(js|html|xml)$/,
	// the legacy multi-byte encodings under their own label (the alias pages
	// are the same bytes again). What each decoder makes of bytes its index
	// does not have:
	/^encoding\/legacy-mb-[a-z]+\/[^/]+\/[a-z0-9]+[-_](decode-errors|errors)\.html(\.headers)?$/,
	// every pointer of an index decoded from one page, for the three whose
	// decoders differ most (a two-byte one, a stateful one, one with astral
	// characters); 370 to 730 KiB each
	/^encoding\/legacy-mb-japanese\/shift_jis\/(sjis-decode\.html|sjis_chars\.html(\.headers)?|sjis-decoder\.js|jis0208_index\.js)$/,
	/^encoding\/legacy-mb-japanese\/iso-2022-jp\/(iso2022jp-decode\.html|iso2022jp_chars\.html(\.headers)?|iso2022jp-decoder\.js|jis0208_index\.js)$/,
	/^encoding\/legacy-mb-tchinese\/big5\/(big5-decode\.html|big5_chars\.html(\.headers)?|big5-decoder\.js|big5_index\.js)$/,
	// what a link and a form of a legacy document encode: one index (the
	// suite runs its last, short variant; see its skip list for why), and
	// the unencodable characters of a stateful one
	/^encoding\/legacy-mb-korean\/euc-kr\/(euckr-encode-(form|href)\.html(\.headers)?|euckr-encoder\.js|euckr_index\.js)$/,
	'encoding/legacy-mb-japanese/iso-2022-jp/iso2022jp-encode-form-errors-stateful.html',
	'encoding/legacy-mb-tchinese/big5/big5-enc-ascii.html',
	'encoding/legacy-mb-tchinese/big5/big5-enc-ascii.html.headers',
	'common/subset-tests.js',
	'common/sab.js',
];

export const exclude = [
	// needs /resources/WebIDLParser.js, which is resources/webidl2/lib/ upstream:
	// refresh.mjs cannot wipe a directory under resources/ yet
	'encoding/idlharness.any.js',
	// reference tests: nothing for the harness to read
	/^encoding\/eof-/,
	// SharedArrayBuffer behind a secure context with isolation headers
	/^encoding\/sharedarraybuffer\.https\.html/,
];
