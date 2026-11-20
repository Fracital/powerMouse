// RE2 for declarativeNetRequest regexFilter (src/extensions/dnr/re2.ts), in
// node, against rows taken from native RE2 at Chromium's pinned revision
// (google/re2@2da0056814cf180480a19f5cf811e7e1c054bf6d) run with Chromium's
// CreateRE2Options: Latin-1, case_sensitive per rule, never_capture unless
// capturing is required, max_mem 2 KiB. A syntax row is [pattern, options,
// what RE2::Init answered: "ok <ProgramSize> <groups>" or "err <ErrorCode>"];
// options are "<caseSensitive><requireCapturing>" as 0/1. A match row is
// [pattern, options, input, spans of RE2::Match or null, rewrite, what
// RE2::Replace left]. Skips when esbuild is not installed, as the other unit
// suites do.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP dnr-re2-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}dnr-re2-unit-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/extensions/dnr/re2.ts`)};`,
);
const bundle = `${OUT}dnr-re2-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { compileRE2, checkRewriteString, replaceFirst, matchSpans } =
	await import(`${bundle}?${Date.now()}`);
const options = (o) => ({
	caseSensitive: o[0] === '1',
	requireCapturing: o[1] === '1',
});

const SYNTAX = [
	['abc', '11', 'ok 7 0'],
	['^https?://', '00', 'ok 9 0'],
	['^abc', '01', 'ok 4 0'],
	['(a)(b)', '11', 'ok 10 2'],
	['(a)(b)', '10', 'ok 6 0'],
	['(a)(b)', '01', 'ok 10 2'],
	['(a)(b)', '00', 'ok 6 0'],
	['', '10', 'ok 4 0'],
	['a|', '11', 'ok 6 0'],
	['|', '00', 'ok 4 0'],
	['(?:)', '01', 'ok 4 0'],
	['a**', '10', 'err 11'],
	['a*?', '11', 'ok 5 0'],
	['a*+', '00', 'err 11'],
	['a++', '01', 'err 11'],
	['a{2}{3}', '10', 'err 11'],
	['(?:a*)*', '11', 'ok 5 0'],
	['(?=a)', '00', 'err 12'],
	['(?!a)', '01', 'err 12'],
	['(?<=a)', '10', 'err 12'],
	['(?<!a)', '11', 'err 12'],
	['(?<=', '00', 'err 14'],
	['(?<a>b)', '01', 'ok 7 1'],
	['(?P<a>b)', '10', 'ok 7 1'],
	['(?P=a)', '11', 'err 12'],
	["(?'a'b)", '00', 'err 12'],
	['(?<1a>x)', '01', 'ok 7 1'],
	['(?<é>x)', '10', 'err 14'],
	['(?i)', '11', 'ok 4 0'],
	['(?i:a)', '00', 'ok 5 0'],
	['(?-)', '01', 'err 12'],
	['(?i-)', '10', 'err 12'],
	['(?x)', '11', 'err 12'],
	['a(?i)*', '00', 'ok 5 0'],
	['(?U)a*', '01', 'ok 5 0'],
	['(?s).', '10', 'ok 5 0'],
	['(?m)^a$', '11', 'ok 7 0'],
	['\\Aa\\z', '00', 'ok 4 0'],
	['\\Z', '01', 'err 2'],
	['\\C', '10', 'ok 5 0'],
	['\\C*', '11', 'ok 6 0'],
	['a\\C*', '00', 'ok 7 0'],
	['\\Qa.b\\E', '01', 'ok 7 0'],
	['\\Qa.b', '10', 'ok 7 0'],
	['\\E', '11', 'err 2'],
	['\\1', '00', 'err 2'],
	['\\0', '01', 'ok 5 0'],
	['\\012', '10', 'ok 5 0'],
	['\\08', '11', 'ok 6 0'],
	['\\8', '00', 'err 2'],
	['\\377', '01', 'ok 5 0'],
	['\\400', '10', 'err 2'],
	['\\x', '11', 'err 2'],
	['\\x4', '00', 'err 2'],
	['\\x41', '01', 'ok 5 0'],
	['\\x{', '10', 'err 13'],
	['\\x{}', '11', 'err 2'],
	['\\x{ff}', '00', 'ok 5 0'],
	['\\x{100}', '01', 'err 2'],
	['\\e', '10', 'err 2'],
	['\\_', '11', 'ok 5 0'],
	['\\', '00', 'err 8'],
	['\\p', '01', 'err 4'],
	['\\pL', '10', 'ok 11 0'],
	['\\PL', '11', 'ok 12 0'],
	['\\p{^L}', '00', 'ok 12 0'],
	['\\p{Greek}', '01', 'ok 1 0'],
	['\\P{Greek}', '10', 'ok 5 0'],
	['\\p{Any}', '11', 'ok 5 0'],
	['\\p{any}', '00', 'err 4'],
	['\\p{L', '01', 'err 4'],
	['\\p^', '10', 'err 4'],
	['[\\p]', '11', 'err 4'],
	['[\\p', '00', 'err 2'],
	['\\d', '01', 'ok 5 0'],
	['\\D', '10', 'ok 6 0'],
	['\\s', '11', 'ok 7 0'],
	['\\S', '00', 'ok 8 0'],
	['\\w', '01', 'ok 7 0'],
	['\\W', '10', 'ok 9 0'],
	['[\\s\\S]', '11', 'ok 5 0'],
	['[a-]', '00', 'ok 6 0'],
	['[]a]', '01', 'ok 6 0'],
	['[]', '10', 'err 5'],
	['[^]', '11', 'err 5'],
	['[b-a]', '00', 'err 4'],
	['[^\\x00-\\xff]', '01', 'ok 1 0'],
	['[[:alpha:]]', '10', 'ok 5 0'],
	['[[:^alpha:]]', '11', 'ok 7 0'],
	['[[:foo:]]', '00', 'err 4'],
	['[[:alpha:]', '01', 'err 5'],
	['[\\b]', '10', 'err 2'],
	['[\\d-z]', '11', 'ok 7 0'],
	['a{,2}', '00', 'ok 9 0'],
	['a{2,1}', '01', 'err 10'],
	['a{00}', '10', 'ok 9 0'],
	['a{01}', '11', 'ok 9 0'],
	['a{1000}', '00', 'err 15'],
	['a{1001}', '01', 'err 10'],
	['a{2,1001}', '10', 'err 10'],
	['{', '11', 'ok 5 0'],
	['a{1,', '00', 'ok 8 0'],
	['x{}', '01', 'ok 7 0'],
	['^*', '10', 'ok 9 0'],
	['(?:^)*', '11', 'ok 9 0'],
	['((a{2}){2}){2}', '11', 'ok 24 2'],
	['((a{2}){2}){2}', '10', 'ok 12 0'],
	['((a{2}){2}){2}', '01', 'ok 24 2'],
	['((a{2}){2}){2}', '00', 'ok 12 0'],
	['(a{2}){500}', '00', 'err 15'],
	['(a{3}){334}', '01', 'err 10'],
	['((a{10}){10}){10}', '10', 'err 15'],
	['(a', '11', 'err 6'],
	['a)', '00', 'err 7'],
	['.', '01', 'ok 6 0'],
	['.*', '10', 'ok 6 0'],
	['(?s).*', '11', 'ok 6 0'],
	['x[^]*', '00', 'err 5'],
	['a$|b', '01', 'ok 7 0'],
	['abc|abd|aef|bcx|bcy', '10', 'ok 12 0'],
	['a|.', '11', 'ok 6 0'],
	['.|a', '00', 'ok 6 0'],
	['(?i)abc|ABD', '01', 'ok 7 0'],
	['a*a+', '10', 'ok 6 0'],
	['[ab]*[ab]', '11', 'ok 6 0'],
	['(?i)k', '00', 'ok 5 0'],
	['(?i)[a-z]', '01', 'ok 5 0'],
	['(?i)[^a-z]', '10', 'ok 7 0'],
	['(?i)\\W', '11', 'ok 9 0'],
	['(?i)\\PL', '00', 'ok 12 0'],
	['(?i)1a', '01', 'ok 6 0'],
	['é', '10', 'ok 6 0'],
	['Ā', '11', 'ok 6 0'],
	['😀', '00', 'ok 8 0'],
	['a{100}', '01', 'ok 104 0'],
	['a{110}', '10', 'ok 114 0'],
	['a{111}', '11', 'ok 115 0'],
	['a{112}', '00', 'ok 116 0'],
	['^a{112}', '01', 'ok 114 0'],
	['a{109,}', '10', 'ok 114 0'],
	[
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		'11',
		'ok 116 0',
	],
	[
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		'00',
		'err 15',
	],
	[
		'^aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		'01',
		'ok 4 0',
	],
	['[a-z]{56}', '10', 'ok 60 0'],
	['[a-z]{57}', '11', 'ok 61 0'],
	['(?i)[a-z]{56}', '00', 'ok 60 0'],
	['(a){37}', '11', 'ok 115 1'],
	['(a){37}', '10', 'ok 41 0'],
	['(a){37}', '01', 'ok 115 1'],
	['(a){37}', '00', 'ok 41 0'],
	['(?:a|bc){27}', '01', 'ok 85 0'],
	[
		'a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?',
		'10',
		'ok 78 0',
	],
	[
		'a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?',
		'11',
		'ok 80 0',
	],
	['(?:a|b)(?:c|d)(?:e|f)', '00', 'ok 7 0'],
	['^https?://([a-z]+\\.)?example\\.com/', '11', 'ok 27 1'],
	['^https?://([a-z]+\\.)?example\\.com/', '10', 'ok 26 0'],
	['^https?://([a-z]+\\.)?example\\.com/', '01', 'ok 27 1'],
	['^https?://([a-z]+\\.)?example\\.com/', '00', 'ok 26 0'],
	['\\b(?:ads?|track(?:ing|er)?)\\b', '01', 'ok 21 0'],
	['^https?://[^/]+/[a-z0-9]{32}\\.js$', '10', 'ok 80 0'],
	['[?&]utm_[a-z]+=[^&]*', '11', 'ok 15 0'],
	['^https://(www\\.)?youtube\\.com/(?:embed|watch)', '11', 'ok 33 1'],
	['^https://(www\\.)?youtube\\.com/(?:embed|watch)', '10', 'ok 31 0'],
	['^https://(www\\.)?youtube\\.com/(?:embed|watch)', '01', 'ok 33 1'],
	['^https://(www\\.)?youtube\\.com/(?:embed|watch)', '00', 'ok 31 0'],
	['\\/js\\/[djpf]{2}(ad)?.*a\\d{2}\\.js', '11', 'ok 29 1'],
	['\\/js\\/[djpf]{2}(ad)?.*a\\d{2}\\.js', '10', 'ok 27 0'],
	['\\/js\\/[djpf]{2}(ad)?.*a\\d{2}\\.js', '01', 'ok 29 1'],
	['\\/js\\/[djpf]{2}(ad)?.*a\\d{2}\\.js', '00', 'ok 27 0'],
	[
		'^https?:\\/\\/img\\.tvchosun\\.com\\/upload_img\\/rnbImg\\/[0-9]+\\.',
		'00',
		'ok 47 0',
	],
	[
		'^https:\\/\\/ydbox[0-9]+\\.com\\/data\\/apms\\/background\\/.+\\.gif$',
		'01',
		'ok 39 0',
	],
	['smart-facebook-page-like-overlay-pro', '10', 'ok 40 0'],
	['\\.com\\/[_0-9a-zA-Z]+\\.jpg$', '11', 'ok 17 0'],
	[
		'^https?:\\/\\/a\\.[-0-9a-z]{4,}\\.[a-z]{2,5}\\/[0-9a-zA-Z]{5,8}\\.js$',
		'00',
		'ok 56 0',
	],
	['\\/images[0-9]?\\/(560h110|[a-z]{4,6}-banner.*)\\.gif', '11', 'ok 45 1'],
	['\\/images[0-9]?\\/(560h110|[a-z]{4,6}-banner.*)\\.gif', '10', 'ok 43 0'],
	['\\/images[0-9]?\\/(560h110|[a-z]{4,6}-banner.*)\\.gif', '01', 'ok 45 1'],
	['\\/images[0-9]?\\/(560h110|[a-z]{4,6}-banner.*)\\.gif', '00', 'ok 43 0'],
	['^.*\\.com\\/c.*?apk\\/e-tax%e.*', '01', 'ok 25 0'],
	['^.*\\/pop\\/jp-.*?\\/index\\.php\\?.*', '10', 'ok 27 0'],
	['^http:\\/\\/.*?\\/log_index\\.php.*', '11', 'ok 22 0'],
	['^[^:]+:\\/\\/([^:/]+\\.)?cx\\/sbanken$', '11', 'ok 26 1'],
	['^[^:]+:\\/\\/([^:/]+\\.)?cx\\/sbanken$', '10', 'ok 25 0'],
	['^[^:]+:\\/\\/([^:/]+\\.)?cx\\/sbanken$', '01', 'ok 26 1'],
	['^[^:]+:\\/\\/([^:/]+\\.)?cx\\/sbanken$', '00', 'ok 25 0'],
	['^.*\\/tr\\?tag=.*', '00', 'ok 14 0'],
	['^https?:\\/\\/web\\.tegr[a-z][a-z][a-z]\\.top\\/.*', '01', 'ok 27 0'],
	['^.*[^%.0-9a-z_-]s=.*?&ssk=.*?&svar=.*?&z=.*', '11', 'ok 34 0'],
	['^.*[^%.0-9a-z_-]s=.*?&ssk=.*?&svar=.*?&z=.*', '10', 'ok 34 0'],
	['^.*[^%.0-9a-z_-]s=.*?&ssk=.*?&svar=.*?&z=.*', '01', 'ok 35 0'],
	['^.*[^%.0-9a-z_-]s=.*?&ssk=.*?&svar=.*?&z=.*', '00', 'ok 35 0'],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?www\\.youtube\\.com\\/channel\\/ucwmnsubfoctn_xmhg4czo5a\\/.*',
		'11',
		'ok 67 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?www\\.youtube\\.com\\/channel\\/ucwmnsubfoctn_xmhg4czo5a\\/.*',
		'10',
		'ok 66 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?www\\.youtube\\.com\\/channel\\/ucwmnsubfoctn_xmhg4czo5a\\/.*',
		'01',
		'ok 67 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?www\\.youtube\\.com\\/channel\\/ucwmnsubfoctn_xmhg4czo5a\\/.*',
		'00',
		'ok 66 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?canadacentral-01\\.azurewebsites\\.net\\/index1\\.html.*',
		'11',
		'ok 64 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?canadacentral-01\\.azurewebsites\\.net\\/index1\\.html.*',
		'10',
		'ok 63 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?canadacentral-01\\.azurewebsites\\.net\\/index1\\.html.*',
		'01',
		'ok 64 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?canadacentral-01\\.azurewebsites\\.net\\/index1\\.html.*',
		'00',
		'ok 63 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?oortech\\.com\\/mic\\.shtml[^%.0-9a-z_-]?.*',
		'11',
		'ok 46 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?oortech\\.com\\/mic\\.shtml[^%.0-9a-z_-]?.*',
		'10',
		'ok 45 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?oortech\\.com\\/mic\\.shtml[^%.0-9a-z_-]?.*',
		'01',
		'ok 47 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?oortech\\.com\\/mic\\.shtml[^%.0-9a-z_-]?.*',
		'00',
		'ok 46 0',
	],
	[
		'^https:\\/\\/tpbank\\.[-a-z0-9]{5,}\\.[a-z]{3}(?:\\.vn)?\\/.*',
		'10',
		'ok 31 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?ocalam\\.com:8443\\/impact[^%.0-9a-z_-]?.*',
		'11',
		'ok 47 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?ocalam\\.com:8443\\/impact[^%.0-9a-z_-]?.*',
		'10',
		'ok 46 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?ocalam\\.com:8443\\/impact[^%.0-9a-z_-]?.*',
		'01',
		'ok 48 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?ocalam\\.com:8443\\/impact[^%.0-9a-z_-]?.*',
		'00',
		'ok 47 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?base-swap-frontend-.*?\\.vercel\\.app[^%.0-9a-z_-]?.*',
		'11',
		'ok 57 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?base-swap-frontend-.*?\\.vercel\\.app[^%.0-9a-z_-]?.*',
		'10',
		'ok 56 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?base-swap-frontend-.*?\\.vercel\\.app[^%.0-9a-z_-]?.*',
		'01',
		'ok 58 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?base-swap-frontend-.*?\\.vercel\\.app[^%.0-9a-z_-]?.*',
		'00',
		'ok 57 0',
	],
	['^https:\\/\\/.*?\\.favoripirlanta\\.com[^%.0-9a-z_-]?.*', '11', 'ok 34 0'],
	['^https:\\/\\/.*?\\.favoripirlanta\\.com[^%.0-9a-z_-]?.*', '10', 'ok 34 0'],
	['^https:\\/\\/.*?\\.favoripirlanta\\.com[^%.0-9a-z_-]?.*', '01', 'ok 35 0'],
	['^https:\\/\\/.*?\\.favoripirlanta\\.com[^%.0-9a-z_-]?.*', '00', 'ok 35 0'],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?usps-packages-.*?\\.com[^%.0-9a-z_-]?.*',
		'11',
		'ok 45 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?usps-packages-.*?\\.com[^%.0-9a-z_-]?.*',
		'10',
		'ok 44 0',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?usps-packages-.*?\\.com[^%.0-9a-z_-]?.*',
		'01',
		'ok 46 1',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?usps-packages-.*?\\.com[^%.0-9a-z_-]?.*',
		'00',
		'ok 45 0',
	],
	['^.*\\/clc\\?aid=.*', '11', 'ok 15 0'],
	['^88\\.208\\.22\\.[1234]$', '00', 'ok 5 0'],
	['briefmenow.org\\/img\\/pa[0-9]{1}.jpg', '01', 'ok 32 0'],
	[
		'^https:\\/\\/steam\\.(?:community)?workshop-?[a-z]+\\.com\\/',
		'10',
		'ok 31 0',
	],
	[
		'^https:\\/\\/www\\.totaljobs\\.com\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]+\\/[a-zA-Z0-9]+',
		'11',
		'ok 34 0',
	],
];
const MATCH = [
	['a.c', '11', 'xa\rc', [1, 4], null, null],
	['a.c', '11', 'xa\nc', null, null, null],
	['a\\sb', '11', 'a\u000bb', null, null, null],
	['a\\sb', '11', 'a\fb', [0, 3], null, null],
	['a$', '11', 'a\n', null, null, null],
	['(?m)a$', '11', 'a\nb', [0, 1], null, null],
	['(?m)^b', '11', 'a\rb', null, null, null],
	['(?m)^b', '11', 'a\nb', [2, 3], null, null],
	['a\\z', '11', 'ba', [1, 2], null, null],
	['\\Ab', '11', 'ab', null, null, null],
	['(?s)a.c', '11', 'a\nc', [0, 3], null, null],
	['(?U)a+', '11', 'aaa', [0, 1], null, null],
	['(?U)a+?', '11', 'aaa', [0, 3], null, null],
	['(?i)ab(?-i)c', '11', 'ABc', [0, 3], null, null],
	['(?i)ab(?-i)c', '11', 'ABC', null, null, null],
	['(?i:a)b', '10', 'AB', null, null, null],
	['Ab', '00', 'aB', [0, 2], null, null],
	['\\pN+', '11', 'x123y', [1, 4], null, null],
	['\\PL+', '11', 'ab12-c', [2, 5], null, null],
	['[[:punct:]]+', '11', 'a.-/b', [1, 4], null, null],
	['\\C\\C', '11', 'xy', [0, 2], null, null],
	[
		'(a|ab)(c|bcd)(d*)',
		'11',
		'abcd',
		[0, 4, 0, 1, 1, 4, 4, 4],
		'x\\1\\2\\3x',
		'xabcdx',
	],
	['(a*)+', '11', 'b', [0, 0, 0, 0], '<\\1>', '<>b'],
	['(a|)*', '11', 'aab', [0, 2, 1, 2], '<\\0|\\1>', '<aa|a>b'],
	['(?:|a)*', '11', 'aa', [0, 0], '<\\0>', '<>aa'],
	['(?:(a)|b)+', '11', 'ab', [0, 2, 0, 1], '<\\1>', '<a>'],
	['(?:(a)|b){2}', '11', 'ab', [0, 2, 0, 1], '<\\1>', '<a>'],
	['(a)?(b)', '11', 'b', [0, 1, -1, -1, 0, 1], '\\1-\\2', '-b'],
	['(?P<x>a)(b)', '10', 'ab', [0, 2, 0, 1], '\\2\\1', false],
	[
		'^https?://([^/]+)/(.*)$',
		'11',
		'https://example.com/a/b?c',
		[0, 25, 8, 19, 20, 25],
		'https://proxy.test/\\1/\\2\\\\',
		'https://proxy.test/example.com/a/b?c\\',
	],
	[
		'\\?.*',
		'11',
		'https://a.test/p?utm=1&x=2',
		[16, 26],
		'',
		'https://a.test/p',
	],
	[
		'\\/inc\\/embed\\/index\\.php',
		'01',
		'https://example.com//inc/embed/index.php',
		[20, 40],
		'/inc/embed/video-js-new.php',
		'https://example.com//inc/embed/video-js-new.php',
	],
	[
		'^.*\\.net\\/co\\.jp\\/$',
		'01',
		'https://example.com/.net/co.jp/',
		[0, 31],
		'/strictblock.html#\\0',
		'/strictblock.html#https://example.com/.net/co.jp/',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?flysas-no\\..*',
		'01',
		'https://example.com/://',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^https?:\\/\\/[-a-z]{4,}\\.org[-.][-a-z0-9]{2,}\\.[a-z]{2,6}\\/.*',
		'01',
		'https://example.com/.org',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^.*\\/click\\?pid=.*?&sub1=.*',
		'01',
		'https://example.com//click?pid=',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?honda-law-office\\.jp\\/wp-includes\\/70038\\/earthcorejp\\/$',
		'01',
		'https://example.com/://',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?oortech\\.com\\/mic\\.shtml[^%.0-9a-z_-]?.*',
		'01',
		'https://example.com/://',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?appeal-account-copyright-case-review\\..*',
		'01',
		'https://example.com/://',
		null,
		'/strictblock.html#\\0',
		null,
	],
	[
		'^.*\\/views\\/go\\/start\\.php[^%.0-9a-z_-]?.*',
		'01',
		'https://example.com//views/go/start.php',
		[0, 39],
		'/strictblock.html#\\0',
		'/strictblock.html#https://example.com//views/go/start.php',
	],
	[
		'^[^:]+:\\/\\/([^:/]+\\.)?geekupdates\\.notion\\.site\\/ultra-security.*',
		'01',
		'https://example.com/://',
		null,
		'/strictblock.html#\\0',
		null,
	],
];

// --- isRegexSupported and ProgramSize
{
	const bad = [];
	for (const [pattern, o, want] of SYNTAX) {
		const res = compileRE2(pattern, options(o));
		const got = res.ok
			? `ok ${res.programSize} ${res.groups}`
			: `err ${res.code}`;
		const tag = `${JSON.stringify(pattern)} ${o}`;
		if (got !== want) bad.push(`${tag}: ${got}, RE2 ${want}`);
		else if (res.ok) {
			try {
				const groups =
					new RegExp(`${res.source}|`, res.flags).exec('').length - 1;
				if (groups !== res.groups) bad.push(`${tag}: ${groups} JS groups`);
			} catch (error) {
				bad.push(`${tag}: ${error.message}`);
			}
		}
	}
	ok(
		`RE2::Init answers (status, error code, ProgramSize, groups) for ${SYNTAX.length} rows, each translation a JS RegExp with RE2's groups`,
		bad.length === 0,
		bad.slice(0, 5).join('; '),
	);
	const reasons = [
		['(?<=a)b', 'syntaxError'],
		['a{1001}', 'syntaxError'],
		['(a{2}){500}', 'memoryLimitExceeded'],
		['a{112}', undefined],
		['a{113}', 'memoryLimitExceeded'],
	].map(([p, want]) => [p, compileRE2(p, options('10')).reason, want]);
	ok(
		'unsupported reasons are isRegexSupported reasons',
		reasons.every(([, got, want]) => got === want),
		JSON.stringify(reasons),
	);
}

// --- PartialMatch, match spans and Replace
{
	const bad = [];
	for (const [pattern, o, input, spans, rewrite, replaced] of MATCH) {
		const res = compileRE2(pattern, options(o));
		const re = new RegExp(res.source, res.flags);
		const tag = `${JSON.stringify(pattern)} ${o} ${JSON.stringify(input)}`;
		if (re.test(input) !== (spans !== null)) bad.push(`${tag}: test`);
		const exact = { pattern, options: options(o) };
		const vm = matchSpans(input, exact);
		if (String(vm) !== String(spans)) bad.push(`${tag}: spans ${vm}`);
		if (res.exact && String(matchSpans(input, re)) !== String(spans))
			bad.push(`${tag}: RegExp spans ${matchSpans(input, re)}`);
		if (rewrite !== null) {
			const want = spans === null || replaced === false ? null : replaced;
			const got = replaceFirst(input, exact, rewrite);
			if (got !== want) bad.push(`${tag}: replace ${got}`);
			if (res.exact && o[1] === '1') {
				const viaRegExp = replaceFirst(input, re, rewrite);
				if (viaRegExp !== want) bad.push(`${tag}: RegExp replace ${viaRegExp}`);
			}
		}
	}
	ok(
		`PartialMatch, Match spans and Replace agree with RE2 on ${MATCH.length} rows`,
		bad.length === 0,
		bad.slice(0, 5).join('; '),
	);
	const inexact = ['(a|)*', '(?:|a)*', '(?:(a)|b)+', '(?:(a)|b){2}'];
	ok(
		'patterns whose JS spans can differ from RE2 are marked inexact',
		inexact.every((p) => compileRE2(p, options('11')).exact === false) &&
			compileRE2('^https?://([^/]+)/', options('11')).exact === true,
	);
}

// --- CheckRewriteString
{
	const rows = [
		['\\1', 1, true],
		['\\1', 0, false],
		['\\0x\\\\', 0, true],
		['a\\', 3, false],
		['\\q', 3, false],
		['\\9', 9, true],
		['', 0, true],
	];
	const bad = rows.filter(([r, n, want]) => checkRewriteString(r, n) !== want);
	ok('CheckRewriteString', bad.length === 0, JSON.stringify(bad));
}

// --- the prefilter never drops a URL the pattern matches
{
	const rows = [
		[
			'^https?://(?:www\\.)?example\\.com/ads/',
			'https://WWW.Example.com/ads/x',
		],
		['(?i)/BANNER[0-9]+\\.gif', 'https://a.test/banner12.gif'],
		['track(?:ing|er)?\\.js', 'https://a.test/tracker.js'],
		['\\.(?:png|jpe?g)\\?ad=', 'https://a.test/x.JPG?ad=1'],
	];
	const bad = [];
	for (const [pattern, url] of rows) {
		const res = compileRE2(pattern, options('00'));
		const low = url.toLowerCase();
		if (!new RegExp(res.source, res.flags).test(url))
			bad.push(`${pattern}: no match`);
		if (
			!res.required.every((s) => low.includes(s)) ||
			!(res.anyOf ?? ['']).some((s) => low.includes(s))
		)
			bad.push(`${pattern}: ${JSON.stringify([res.required, res.anyOf])}`);
	}
	ok(
		'required and anyOf hold for matching URLs, lowercased',
		bad.length === 0,
		bad.join('; '),
	);
	const res = compileRE2(
		'^https?://(?:www\\.)?example\\.com/ads/',
		options('00'),
	);
	ok(
		'the prefilter finds the literals',
		res.required.includes('example.com/ads/'),
		JSON.stringify([res.required, res.anyOf]),
	);
}

done();
