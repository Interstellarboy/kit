import fs from 'fs';
import path from 'path';
import { mergeConfig } from 'vite';
import { mkdirp, posixify, resolve_entry } from '../../../utils/filesystem.js';
import { get_vite_config } from '../utils.js';
import { load_error_page, load_template } from '../../../core/config/index.js';
import {
	create_build,
	find_deps,
	get_default_build_config,
	is_http_method,
	resolve_symlinks
} from './utils.js';
import { s } from '../../../utils/misc.js';
import { runtime_directory } from '../../../core/utils.js';

/**
 * @param {{
 *   hooks: string | null;
 *   config: import('types').ValidatedConfig;
 *   has_service_worker: boolean;
 *   runtime_directory: string;
 *   template: string;
 *   error_page: string;
 * }} opts
 */
const server_template = ({
	config,
	hooks,
	has_service_worker,
	runtime_directory,
	template,
	error_page
}) => `
import root from './root.svelte';
import { set_paths } from '${runtime_directory}/paths.js'; // TODO probably just expose this directly?
export { set_building } from '${runtime_directory}/env.js';

export const paths = ${s(config.kit.paths)};

export const version = ${s(config.kit.version.name)};

export const options = {
	app_template: ({ head, body, assets, nonce }) => ${s(template)
		.replace('%sveltekit.head%', '" + head + "')
		.replace('%sveltekit.body%', '" + body + "')
		.replace(/%sveltekit\.assets%/g, '" + assets + "')
		.replace(/%sveltekit\.nonce%/g, '" + nonce + "')},
	app_template_contains_nonce: ${template.includes('%sveltekit.nonce%')},
	csp: ${s(config.kit.csp)},
	csrf: {
		check_origin: ${s(config.kit.csrf.checkOrigin)},
	},
	dev: false,
	embedded: ${config.kit.embedded},
	error_template: ({ status, message }) => ${s(error_page)
		.replace(/%sveltekit\.status%/g, '" + status + "')
		.replace(/%sveltekit\.error\.message%/g, '" + message + "')},
	paths,
	public_env: {},
	read: null,
	root,
	service_worker: ${has_service_worker},
	version: ${s(config.kit.version.name)}
};

export const public_prefix = '${config.kit.env.publicPrefix}';

// allow paths to be globally overridden
// in svelte-kit preview and in prerendering
export function override(settings) {
	set_paths(settings.paths);
	options.paths = settings.paths;
	options.read = settings.read;
}

export function get_hooks() {
	return ${hooks ? `import(${s(hooks)})` : '{}'};
}
`;

/**
 * @param {{
 *   cwd: string;
 *   config: import('types').ValidatedConfig;
 *   vite_config: import('vite').ResolvedConfig;
 *   vite_config_env: import('vite').ConfigEnv;
 *   manifest_data: import('types').ManifestData;
 *   output_dir: string;
 *   service_worker_entry_file: string | null;
 * }} options
 * @param {{ vite_manifest: import('vite').Manifest, assets: import('rollup').OutputAsset[] }} client
 */
export async function build_server(options, client) {
	const {
		cwd,
		config,
		vite_config,
		vite_config_env,
		manifest_data,
		output_dir,
		service_worker_entry_file
	} = options;

	// TODO the casting shouldn't be necessary — investigate
	const hooks_file = /** @type {string} */ (resolve_entry(config.kit.files.hooks.server));

	/** @type {Record<string, string>} */
	const input = {
		index: `${runtime_directory}/server/index.js`,
		internal: `${config.kit.outDir}/generated/server-internal.js`
	};

	// add entry points for every endpoint...
	manifest_data.routes.forEach((route) => {
		if (route.endpoint) {
			const resolved = path.resolve(cwd, route.endpoint.file);
			const relative = decodeURIComponent(path.relative(config.kit.files.routes, resolved));
			const name = posixify(path.join('entries/endpoints', relative.replace(/\.js$/, '')));
			input[name] = resolved;
		}
	});

	// ...and every component used by pages...
	manifest_data.nodes.forEach((node) => {
		for (const file of [node.component, node.universal, node.server]) {
			if (file) {
				const resolved = path.resolve(cwd, file);
				const relative = decodeURIComponent(path.relative(config.kit.files.routes, resolved));

				const name = relative.startsWith('..')
					? posixify(path.join('entries/fallbacks', path.basename(file)))
					: posixify(path.join('entries/pages', relative.replace(/\.js$/, '')));
				input[name] = resolved;
			}
		}
	});

	// ...and every matcher
	Object.entries(manifest_data.matchers).forEach(([key, file]) => {
		const name = posixify(path.join('entries/matchers', key));
		input[name] = path.resolve(cwd, file);
	});

	/** @param {string} file */
	function relative(file) {
		return path.relative(path.dirname(input.internal), file);
	}

	fs.writeFileSync(
		input.internal,
		server_template({
			config,
			hooks: fs.existsSync(hooks_file) ? relative(hooks_file) : null,
			has_service_worker: config.kit.serviceWorker.register && !!service_worker_entry_file,
			runtime_directory: relative(runtime_directory),
			template: load_template(cwd, config),
			error_page: load_error_page(config)
		})
	);

	const merged_config = mergeConfig(
		get_default_build_config({ config, input, ssr: true, outDir: `${output_dir}/server` }),
		await get_vite_config(vite_config, vite_config_env)
	);

	const { chunks } = await create_build(merged_config);

	/** @type {import('vite').Manifest} */
	const vite_manifest = JSON.parse(
		fs.readFileSync(`${output_dir}/server/${vite_config.build.manifest}`, 'utf-8')
	);

	mkdirp(`${output_dir}/server/nodes`);
	mkdirp(`${output_dir}/server/stylesheets`);

	const stylesheet_lookup = new Map();

	client.assets.forEach((asset) => {
		if (asset.fileName.endsWith('.css')) {
			if (asset.source.length < config.kit.inlineStyleThreshold) {
				const index = stylesheet_lookup.size;
				const file = `${output_dir}/server/stylesheets/${index}.js`;

				fs.writeFileSync(file, `// ${asset.fileName}\nexport default ${s(asset.source)};`);
				stylesheet_lookup.set(asset.fileName, index);
			}
		}
	});

	manifest_data.nodes.forEach((node, i) => {
		/** @type {string[]} */
		const imports = [];

		// String representation of
		/** @type {import('types').SSRNode} */
		/** @type {string[]} */
		const exports = [`export const index = ${i};`];

		/** @type {string[]} */
		const imported = [];

		/** @type {string[]} */
		const stylesheets = [];

		/** @type {string[]} */
		const fonts = [];

		if (node.component) {
			const entry = find_deps(client.vite_manifest, node.component, true);

			imported.push(...entry.imports);
			stylesheets.push(...entry.stylesheets);
			fonts.push(...entry.fonts);

			exports.push(
				`export const component = async () => (await import('../${
					resolve_symlinks(vite_manifest, node.component).chunk.file
				}')).default;`,
				`export const file = '${entry.file}';` // TODO what is this?
			);
		}

		if (node.universal) {
			const entry = find_deps(client.vite_manifest, node.universal, true);

			imported.push(...entry.imports);
			stylesheets.push(...entry.stylesheets);
			fonts.push(...entry.fonts);

			imports.push(`import * as universal from '../${vite_manifest[node.universal].file}';`);
			exports.push(`export { universal };`);
		}

		if (node.server) {
			imports.push(`import * as server from '../${vite_manifest[node.server].file}';`);
			exports.push(`export { server };`);
		}

		exports.push(
			`export const imports = ${s(imported)};`,
			`export const stylesheets = ${s(stylesheets)};`,
			`export const fonts = ${s(fonts)};`
		);

		/** @type {string[]} */
		const styles = [];

		stylesheets.forEach((file) => {
			if (stylesheet_lookup.has(file)) {
				const index = stylesheet_lookup.get(file);
				const name = `stylesheet_${index}`;
				imports.push(`import ${name} from '../stylesheets/${index}.js';`);
				styles.push(`\t${s(file)}: ${name}`);
			}
		});

		if (styles.length > 0) {
			exports.push(`export const inline_styles = () => ({\n${styles.join(',\n')}\n});`);
		}

		const out = `${output_dir}/server/nodes/${i}.js`;
		fs.writeFileSync(out, `${imports.join('\n')}\n\n${exports.join('\n')}\n`);
	});

	return {
		chunks,
		vite_manifest,
		methods: get_methods(cwd, chunks, manifest_data)
	};
}

/**
 * @param {string} cwd
 * @param {import('rollup').OutputChunk[]} output
 * @param {import('types').ManifestData} manifest_data
 */
function get_methods(cwd, output, manifest_data) {
	/** @type {Record<string, string[]>} */
	const lookup = {};
	output.forEach((chunk) => {
		if (!chunk.facadeModuleId) return;
		const id = posixify(path.relative(cwd, chunk.facadeModuleId));
		lookup[id] = chunk.exports;
	});

	/** @type {Record<string, import('types').HttpMethod[]>} */
	const methods = {};
	manifest_data.routes.forEach((route) => {
		if (route.endpoint) {
			if (lookup[route.endpoint.file]) {
				methods[route.endpoint.file] = lookup[route.endpoint.file].filter(is_http_method);
			}
		}

		if (route.leaf?.server) {
			if (lookup[route.leaf.server]) {
				methods[route.leaf.server] = lookup[route.leaf.server].filter(is_http_method);
			}
		}
	});

	return methods;
}
