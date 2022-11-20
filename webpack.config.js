import ExcludeProvidePlugin from './ExcludeProvidePlugin.js';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import { resolve } from 'path';
import { cwd } from 'process';
import ResolveTypescriptPlugin from 'resolve-typescript-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import webpack from 'webpack';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * @param {import('webpack').Configuration & {tsConfig:string}} config
 * @returns {import('webpack').Configuration}
 */
const common = (config) => ({
	entry: config.entry,
	output: {
		...config.output,
		path: resolve(cwd(), 'dist'),
	},
	devtool: isDevelopment ? 'eval-source-map' : 'source-map',
	mode: isDevelopment ? 'development' : 'production',
	module: {
		...(config.module || {}),
		rules: [
			...(config.module?.rules || []),
			{
				test: /\.[mc]?[jt]sx?$/,
				include: resolve('src'),
				loader: 'swc-loader',
				options: {
					sourceMaps: true,
					minify: !isDevelopment,
					jsc: {
						parser: {
							syntax: 'typescript',
							tsx: true,
							decorators: false,
							dynamicImport: true,
						},
						transform: {
							react: {
								runtime: 'automatic',
							},
						},
						target: 'es2015',
						externalHelpers: true,
					},
				},
			},
			// Process any JS outside of the app with SWC
			{
				test: /\.(js|mjs)$/,
				exclude: /@swc(?:\/|\\{1,2})helpers/,
				loader: 'swc-loader',
				options: {
					minify: !isDevelopment,
					sourceMaps: true,
					jsc: {
						target: 'es2015',
						externalHelpers: true,
					},
				},
			},
			{
				test: /\.(ts|js)x?$/,
				enforce: 'pre',
				use: {
					options: {
						eslintPath: 'eslint',
					},
					loader: 'eslint-loader',
				},
				exclude: /node_modules/,
			},
			{
				test: /\.js$/,
				enforce: 'pre',
				use: 'source-map-loader',
			},
		],
	},
	ignoreWarnings: [/Failed to parse source map/],
	resolve: {
		extensions: ['.ts', '.js'],
		plugins: [new ResolveTypescriptPlugin()],
	},
	optimization: {
		minimize: !isDevelopment,
		minimizer: [new TerserPlugin()],
	},
	plugins: [
		...(config.plugins || []),
		new ForkTsCheckerWebpackPlugin({
			typescript: {
				configFile: resolve(cwd(), config.tsConfig),
			},
		}),
	].filter(Boolean),
});

/**
 * @type {import('webpack').Configuration[]}
 */
const configs = [
	...[
		[
			'./src/inject/worker/tsconfig.json',
			'./src/inject/worker/worker.ts',
			'injectWorker.js',
			{},
		],
		[
			'./src/inject/dom/tsconfig.json',
			'./src/inject/dom/document.ts',
			'injectDocument.js',
			Object.fromEntries(
				['DOMParser', 'navigator', 'postMessage'].map((name) => [
					name,
					[resolve(cwd(), './src/inject/dom/snapshot.ts'), name],
				])
			),
		],
	].map(([tsConfig, entry, filename, additionalInjecions]) =>
		common({
			tsConfig,
			entry,
			output: {
				library: {
					name: 'createClient',
					type: 'umd',
				},
				libraryExport: 'default',
				filename,
			},
			plugins: [
				new webpack.ProvidePlugin({
					...Object.fromEntries(
						[
							'fetch',
							'Request',
							'Response',
							'WebSocket',
							'XMLHttpRequest',
							'URL',
							'Reflect',
							'EventSource',
							'Function',
						].map((name) => [
							name,
							[resolve(cwd(), './src/inject/snapshot.ts'), name],
						])
					),
					...additionalInjecions,
				}),
			],
		})
	),
	common({
		tsConfig: './src/server/tsconfig.json',
		plugins: [
			new ExcludeProvidePlugin({
				definitions: {
					'Error.captureStackTrace': 'capture-stack-trace',
				},
				exclude: [/capture-stack-trace/],
			}),
		],
		entry: {
			serviceWorker: './src/server/serviceWorker.ts',
		},
		output: {
			libraryExport: 'default',
			filename: '[name].js',
		},
	}),
	...[
		[
			'SearchBuilder',
			'SearchBuilder.js',
			'./src/bootstrapper/SearchBuilder.ts',
		],
		[
			'StompBootstrapper',
			'Bootstrapper.js',
			'./src/bootstrapper/Bootstrapper.ts',
		],
	].map(([name, filename, entry]) =>
		common({
			tsConfig: './src/bootstrapper/tsconfig.json',
			entry,
			output: {
				library: {
					name,
					type: 'umd',
				},
				libraryExport: 'default',
				filename,
			},
		})
	),
];

export default configs;
