import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
	{
		ignores: [
			'dist/',
			'lib/',
			'node_modules/',
			'demo/public/pm/main.js',
			// esbuild bundles written by the rewriter-unit suite
			'test/out/',
			// fixture pages and their scripts run inside proxied pages with their
			// own globals; they are test data, not project code
			'test/pages/',
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
]);
