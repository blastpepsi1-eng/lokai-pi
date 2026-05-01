import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir, getModelsPath } from "./config.js";

type LlamaBackend = "cpu" | "vulkan" | "cuda" | "rocm-gfx1100";

interface RuntimeRecord {
	id: string;
	engine: "llama.cpp";
	version: string;
	platform: string;
	backend: LlamaBackend;
	installedAt: string;
	path: string;
	binaries: {
		server: string;
		cli?: string;
		bench?: string;
		ggufSplit?: string;
	};
	hashes: Record<string, string>;
	networkPolicy: {
		externalEgress: false;
		defaultBind: "127.0.0.1";
	};
}

interface ModelRecord {
	id: string;
	name: string;
	format: "GGUF";
	path: string;
	importedAt: string;
	defaults: LlamaLaunchDefaults;
}

interface NativeState {
	schema: 1;
	currentRuntime?: string;
	currentModel?: string;
	runtimes: Record<string, RuntimeRecord>;
	models: Record<string, ModelRecord>;
}

interface LlamaLaunchDefaults {
	ctxSize: number;
	batchSize: number;
	ubatchSize: number;
	nGpuLayers: number;
	cacheTypeK: string;
	cacheTypeV: string;
	flashAttn: boolean;
	jinja: boolean;
	temp: number;
	topP: number;
	topK: number;
	repeatPenalty: number;
	host: "127.0.0.1";
	port: number;
}

interface RuntimeInstallOptions {
	engine: string;
	from?: string;
	backend?: LlamaBackend;
	version?: string;
	setCurrent?: boolean;
}

interface ModelImportOptions {
	source: string;
	name?: string;
	copy?: boolean;
	setCurrent?: boolean;
}

interface RuntimeStartOptions {
	engine: string;
	model?: string;
	printCommand?: boolean;
}

const DEFAULT_LAUNCH: LlamaLaunchDefaults = {
	ctxSize: 131072,
	batchSize: 4096,
	ubatchSize: 1024,
	nGpuLayers: 99,
	cacheTypeK: "q8_0",
	cacheTypeV: "q8_0",
	flashAttn: true,
	jinja: true,
	temp: 0.6,
	topP: 0.95,
	topK: 20,
	repeatPenalty: 1.0,
	host: "127.0.0.1",
	port: 8081,
};

const UNSAFE_LLAMA_ARGS = new Set(["-hf", "--hf-repo", "--hf-file", "--model-url", "--model-endpoint", "--host"]);

function lokaiRoot(): string {
	return dirname(getAgentDir());
}

function statePath(): string {
	return join(lokaiRoot(), "manager", "registry", "native-packages.json");
}

function ensureParent(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function emptyState(): NativeState {
	return {
		schema: 1,
		runtimes: {},
		models: {},
	};
}

function readState(): NativeState {
	const path = statePath();
	if (!existsSync(path)) return emptyState();
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as NativeState;
	return {
		...emptyState(),
		...parsed,
		runtimes: parsed.runtimes ?? {},
		models: parsed.models ?? {},
	};
}

function writeState(state: NativeState): void {
	const path = statePath();
	ensureParent(path);
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function fileSha256(path: string): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return `sha256-${hash.digest("hex")}`;
}

function platformTag(): string {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `${os}-${arch}`;
}

function findServerBinary(root: string): string | undefined {
	const candidates =
		process.platform === "win32"
			? ["bin/llama-server.exe", "llama-server.exe", "server/llama-server.exe"]
			: ["bin/llama-server", "llama-server", "server/llama-server"];
	for (const candidate of candidates) {
		const path = join(root, candidate);
		if (existsSync(path) && statSync(path).isFile()) return path;
	}
	return undefined;
}

function runtimeId(backend: LlamaBackend, version: string): string {
	return `lokai.llama.runtime.${platformTag()}.${backend}.${version}`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function writePiProvider(model: ModelRecord, defaults: LlamaLaunchDefaults): void {
	const path = getModelsPath();
	ensureParent(path);
	const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) : {};
	const providers = { ...((existing.providers as Record<string, unknown> | undefined) ?? {}) };
	const currentProvider = providers["lokai-local"] as { models?: Array<Record<string, unknown>> } | undefined;
	const currentModels = currentProvider?.models ?? [];
	const nextModel = {
		id: model.name,
		name: model.name,
		contextWindow: defaults.ctxSize,
		maxTokens: 16384,
	};
	const models = currentModels.filter((entry) => entry.id !== model.name);
	models.push(nextModel);
	providers["lokai-local"] = {
		api: "openai-completions",
		baseUrl: `http://${defaults.host}:${defaults.port}/v1`,
		apiKey: "lokai-local",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
		models,
	};
	writeFileSync(path, `${JSON.stringify({ ...existing, providers }, null, 2)}\n`, "utf-8");
}

function getRuntimeForEngine(state: NativeState, engine: string): RuntimeRecord | undefined {
	if (engine !== "llama.cpp") return undefined;
	if (state.currentRuntime && state.runtimes[state.currentRuntime]) return state.runtimes[state.currentRuntime];
	return Object.values(state.runtimes).find((runtime) => runtime.engine === "llama.cpp");
}

function getModel(state: NativeState, name?: string): ModelRecord | undefined {
	if (name && state.models[name]) return state.models[name];
	if (state.currentModel && state.models[state.currentModel]) return state.models[state.currentModel];
	return Object.values(state.models)[0];
}

export class NativePackageManager {
	installRuntime(options: RuntimeInstallOptions): RuntimeRecord {
		if (options.engine !== "llama.cpp") {
			throw new Error(`Unsupported runtime engine: ${options.engine}`);
		}
		if (!options.from) {
			throw new Error("Missing --from path for runtime install.");
		}

		const sourceRoot = realpathSync(resolve(options.from));
		const server = findServerBinary(sourceRoot);
		if (!server) {
			throw new Error(`No llama-server binary found under ${sourceRoot}`);
		}

		const backend = options.backend ?? "cpu";
		if (!["cpu", "vulkan", "cuda", "rocm-gfx1100"].includes(backend)) {
			throw new Error(`Unsupported llama.cpp backend: ${backend}`);
		}
		const version = options.version ?? (basename(sourceRoot).replace(/[^A-Za-z0-9_.-]/g, "-") || "local");
		const id = runtimeId(backend, version);
		const installRoot = join(lokaiRoot(), "runtimes", "llama.cpp", version, `${platformTag()}-${backend}`);
		mkdirSync(installRoot, { recursive: true });
		cpSync(sourceRoot, installRoot, { recursive: true });

		const installedServer = findServerBinary(installRoot);
		if (!installedServer) {
			throw new Error(`Installed runtime is missing llama-server: ${installRoot}`);
		}

		const record: RuntimeRecord = {
			id,
			engine: "llama.cpp",
			version,
			platform: platformTag(),
			backend,
			installedAt: new Date().toISOString(),
			path: installRoot,
			binaries: {
				server: installedServer,
			},
			hashes: {
				[installedServer]: fileSha256(installedServer),
			},
			networkPolicy: {
				externalEgress: false,
				defaultBind: "127.0.0.1",
			},
		};

		const state = readState();
		state.runtimes[id] = record;
		if (options.setCurrent !== false) state.currentRuntime = id;
		writeState(state);
		return record;
	}

	importModel(options: ModelImportOptions): ModelRecord {
		const source = realpathSync(resolve(options.source));
		if (!statSync(source).isFile()) {
			throw new Error(`Model source is not a file: ${source}`);
		}
		if (extname(source).toLowerCase() !== ".gguf") {
			throw new Error("Only local .gguf model files are supported right now.");
		}

		const name = options.name ?? basename(source, extname(source));
		const modelPath = options.copy ? join(lokaiRoot(), "models", name, "model.gguf") : source;
		if (options.copy) {
			mkdirSync(dirname(modelPath), { recursive: true });
			cpSync(source, modelPath);
		}

		const record: ModelRecord = {
			id: name,
			name,
			format: "GGUF",
			path: modelPath,
			importedAt: new Date().toISOString(),
			defaults: DEFAULT_LAUNCH,
		};

		const state = readState();
		state.models[name] = record;
		if (options.setCurrent !== false) state.currentModel = name;
		writeState(state);
		writePiProvider(record, DEFAULT_LAUNCH);
		return record;
	}

	buildLlamaCommand(runtime: RuntimeRecord, model: ModelRecord): string[] {
		const defaults = model.defaults;
		return [
			runtime.binaries.server,
			"--model",
			model.path,
			"--alias",
			model.name,
			"--host",
			defaults.host,
			"--port",
			String(defaults.port),
			"--ctx-size",
			String(defaults.ctxSize),
			"--batch-size",
			String(defaults.batchSize),
			"--ubatch-size",
			String(defaults.ubatchSize),
			"--n-gpu-layers",
			String(defaults.nGpuLayers),
			"--cache-type-k",
			defaults.cacheTypeK,
			"--cache-type-v",
			defaults.cacheTypeV,
			"--flash-attn",
			defaults.flashAttn ? "on" : "off",
			"--temp",
			String(defaults.temp),
			"--top-p",
			String(defaults.topP),
			"--top-k",
			String(defaults.topK),
			"--repeat-penalty",
			String(defaults.repeatPenalty),
			...(defaults.jinja ? ["--jinja"] : []),
		];
	}

	startRuntime(options: RuntimeStartOptions): Promise<number> {
		const state = readState();
		const runtime = getRuntimeForEngine(state, options.engine);
		if (!runtime) throw new Error(`No installed runtime for ${options.engine}.`);
		const model = getModel(state, options.model);
		if (!model) throw new Error("No imported model. Run model import first.");

		const command = this.buildLlamaCommand(runtime, model);
		for (const arg of command) {
			if (UNSAFE_LLAMA_ARGS.has(arg) && arg !== "--host") {
				throw new Error(`Unsafe llama-server argument rejected: ${arg}`);
			}
		}
		if (options.printCommand) {
			console.log(command.map(shellQuote).join(" "));
			return Promise.resolve(0);
		}

		return new Promise((resolvePromise) => {
			const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
			child.on("close", (code) => resolvePromise(code ?? 0));
			child.on("error", (error) => {
				console.error(chalk.red(`Error: ${error.message}`));
				resolvePromise(1);
			});
		});
	}

	status(): NativeState {
		return readState();
	}
}

function usage(command?: string): string {
	if (command === "runtime") {
		return `${APP_NAME} runtime install llama.cpp --from <path> [--backend cpu|vulkan|cuda|rocm-gfx1100] [--version <id>]
${APP_NAME} runtime start llama.cpp [--model <name>] [--print-command]`;
	}
	if (command === "model") {
		return `${APP_NAME} model import <model.gguf> [--name <name>] [--copy]`;
	}
	return `${APP_NAME} runtime install|start ...\n${APP_NAME} model import ...\n${APP_NAME} status`;
}

function takeOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`Missing value for ${name}.`);
	}
	args.splice(index, 2);
	return value;
}

export async function handleNativePackageCommand(args: string[]): Promise<boolean> {
	const [command, subcommand, target, ...rest] = args;
	if (!["runtime", "model", "status", "llama-runner"].includes(command ?? "")) {
		return false;
	}

	const manager = new NativePackageManager();
	try {
		if (args.includes("-h") || args.includes("--help")) {
			console.log(usage(command));
			return true;
		}

		if (command === "status") {
			const state = manager.status();
			const runtime = state.currentRuntime ? state.runtimes[state.currentRuntime] : undefined;
			const model = state.currentModel ? state.models[state.currentModel] : undefined;
			console.log(chalk.bold("LokAI native packages"));
			console.log(`Runtime: ${runtime ? `${runtime.engine} ${runtime.backend} (${runtime.version})` : "none"}`);
			console.log(`Model: ${model ? `${model.name} (${model.path})` : "none"}`);
			console.log(`Server: http://${DEFAULT_LAUNCH.host}:${DEFAULT_LAUNCH.port}/v1`);
			console.log("Network: localhost-only launch command");
			return true;
		}

		if (command === "llama-runner") {
			const mutable = [...args.slice(1)];
			const model = takeOption(mutable, "--model");
			if (mutable.length > 0) throw new Error(`Unexpected argument: ${mutable[0]}`);
			process.exitCode = await manager.startRuntime({ engine: "llama.cpp", model });
			return true;
		}

		if (command === "runtime" && subcommand === "install") {
			if (target !== "llama.cpp") throw new Error(`Unsupported runtime target: ${target ?? "<missing>"}`);
			const mutable = [...rest];
			const from = takeOption(mutable, "--from");
			const backend = takeOption(mutable, "--backend") as LlamaBackend | undefined;
			const version = takeOption(mutable, "--version");
			if (mutable.length > 0) throw new Error(`Unexpected argument: ${mutable[0]}`);
			const record = manager.installRuntime({ engine: "llama.cpp", from, backend, version });
			console.log(chalk.green(`Installed ${record.id}`));
			return true;
		}

		if (command === "runtime" && subcommand === "start") {
			if (target !== "llama.cpp") throw new Error(`Unsupported runtime target: ${target ?? "<missing>"}`);
			const mutable = [...rest];
			const model = takeOption(mutable, "--model");
			const printCommand = mutable.includes("--print-command");
			if (printCommand) mutable.splice(mutable.indexOf("--print-command"), 1);
			if (mutable.length > 0) throw new Error(`Unexpected argument: ${mutable[0]}`);
			process.exitCode = await manager.startRuntime({ engine: "llama.cpp", model, printCommand });
			return true;
		}

		if (command === "model" && subcommand === "import") {
			if (!target) throw new Error("Missing model path.");
			const mutable = [...rest];
			const name = takeOption(mutable, "--name");
			const copy = mutable.includes("--copy");
			if (copy) mutable.splice(mutable.indexOf("--copy"), 1);
			if (mutable.length > 0) throw new Error(`Unexpected argument: ${mutable[0]}`);
			const record = manager.importModel({ source: target, name, copy });
			console.log(chalk.green(`Imported model ${record.name}`));
			console.log(chalk.dim(`Pi provider: lokai-local/${record.name}`));
			return true;
		}

		throw new Error(`Unknown native package command.\n${usage(command)}`);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
