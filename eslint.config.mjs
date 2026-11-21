import { readFileSync } from 'node:fs';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The members of the inject's `navigator` (src/inject/dom/snapshot.ts): the
// document bundles' files that name the global are given that object, which
// has only the members listed there
const snapshotNavigator = JSON.parse(
	readFileSync(new URL('src/inject/dom/snapshot.ts', import.meta.url), 'utf8')
		.match(/const NAVIGATOR_MEMBERS = (\[[^\]]*\])/)[1]
		.replaceAll("'", '"'),
);
/** a read of the global `navigator` in the inject of a member it lacks */
const snapshotNavigatorRule = {
	meta: { type: 'problem', schema: [] },
	create(context) {
		return {
			'Program:exit'(program) {
				const scope = context.sourceCode.getScope(program);
				const references = [
					...(scope.set.get('navigator')?.references ?? []),
					...scope.through.filter(
						(reference) => reference.identifier.name === 'navigator',
					),
				];
				for (const { identifier } of references) {
					const parent = identifier.parent;
					const member =
						parent.type === 'MemberExpression' &&
						parent.object === identifier &&
						!parent.computed
							? parent.property.name
							: null;
					if (member === null || !snapshotNavigator.includes(member))
						context.report({
							node: identifier,
							message: `the inject's navigator has only ${snapshotNavigator.join(', ')} (src/inject/dom/snapshot.ts NAVIGATOR_MEMBERS)`,
						});
				}
			},
		};
	},
};

export default defineConfig([
	{
		ignores: [
			'dist/',
			'lib/',
			'node_modules/',
			// the vibeOS submodule, its own project (docs/vibeos.md)
			'vendor/',
			'demo/public/pm/main.js',
			// esbuild bundles written by the rewriter-unit suite
			'test/out/',
			// fixture pages and their scripts run inside proxied pages with their
			// own globals; they are test data, not project code
			'test/pages/',
			// minified shapes of real sites' scripts, rewriter input only
			'test/corpus/sample/',
			// vendored web-platform-tests (test/wpt/README.md); the harness
			// scripts of ours in test/wpt/resources/ run in a page too
			'test/wpt/**/*.html',
			'test/wpt/**/*.js',
			'test/wpt/**/*.mjs',
			'!test/wpt/refresh.mjs',
			'!test/wpt/lists/*.mjs',
			// benchmark output, the contenders it builds, and the pages it
			// serves (host pages and fixtures run in the browser with their
			// own globals)
			'bench/results/',
			'bench/.contenders/',
			'bench/contenders/*/host/',
			'bench/contenders/*/pkg/',
			'bench/fixtures/',
			'bench/lib/probe.js',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettier,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.worker,
				...globals.serviceworker,
				...globals.node,
			},
		},
		rules: {
			'no-lone-blocks': 'off',
			eqeqeq: 'error',
			'prefer-const': 'error',
			'no-var': 'error',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', caughtErrors: 'none' },
			],
			// the Proxy module deliberately handles arbitrary callables
			'@typescript-eslint/no-unsafe-function-type': 'off',
			// XMLHttpRequest modules keep credentials they never read (pre-existing)
			'no-unused-private-class-members': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'no-constant-condition': ['error', { checkLoops: false }],
		},
	},
	{
		files: ['src/inject/**/*.ts', 'src/*.ts'],
		ignores: ['src/inject/worker/**', 'src/inject/dom/rtcStack*.ts'],
		plugins: {
			stomp: { rules: { 'snapshot-navigator': snapshotNavigatorRule } },
		},
		rules: { 'stomp/snapshot-navigator': 'error' },
	},
]);
