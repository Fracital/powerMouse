// Style-guide checks that prettier and eslint can't express:
//   - no em dashes anywhere in tracked text (AGENTS.md "Comments and prose")
//   - no AI attribution trailers or "Generated with" lines in docs, and,
//     with --commits <base> <head>, in commit messages of that range
//
// Exit code 1 lists every offender.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EM_DASH = '—';
const ATTRIBUTION =
	/co-authored-by:.*\b(claude|anthropic|copilot|chatgpt|openai|gemini|codex|cursor)\b|generated with \[?claude|🤖 generated/i;
const RULE_FILES = new Set([
	'AGENTS.md',
	'CLAUDE.md',
	'scripts/check-prose.mjs',
]);
const TEXT = /\.(md|ts|js|mjs|cjs|json|yml|yaml|html|css|txt)$/i;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const problems = [];

const [mode, base, head] = process.argv.slice(2);

if (mode === '--commits') {
	if (!base || !head) {
		console.error('usage: check-prose.mjs --commits <base-sha> <head-sha>');
		process.exit(2);
	}
	const log = git('log', '--format=%H%x00%B%x01', `${base}..${head}`);
	for (const entry of log.split('\u0001')) {
		const [sha, body = ''] = entry.trim().split('\u0000');
		if (!sha) continue;
		if (ATTRIBUTION.test(body))
			problems.push(
				`${sha.slice(0, 7)}: commit message carries AI attribution`,
			);
		if (body.includes(EM_DASH))
			problems.push(`${sha.slice(0, 7)}: commit message contains an em dash`);
	}
} else {
	const files = git('ls-files', '-z')
		.split('\0')
		.filter((f) => TEXT.test(f));
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		text.split('\n').forEach((line, i) => {
			if (line.includes(EM_DASH)) problems.push(`${file}:${i + 1}: em dash`);
			// the rule files and this script quote the forbidden trailer on purpose
			if (!RULE_FILES.has(file) && ATTRIBUTION.test(line))
				problems.push(`${file}:${i + 1}: AI attribution`);
		});
	}
}

if (problems.length) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log(mode === '--commits' ? 'commit messages ok' : 'prose ok');
