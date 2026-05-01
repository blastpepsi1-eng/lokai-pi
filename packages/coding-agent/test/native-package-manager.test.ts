import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { handleNativePackageCommand } from "../src/native-package-manager.js";

describe("native package manager commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let runtimeDir: string;
	let modelPath: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lokai-native-packages-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "lokai", "agent");
		projectDir = join(tempDir, "project");
		runtimeDir = join(tempDir, "llama-build");
		modelPath = join(tempDir, "models", "qwen36-27b.gguf");
		mkdirSync(join(runtimeDir, "bin"), { recursive: true });
		mkdirSync(join(modelPath, ".."), { recursive: true });
		writeFileSync(join(runtimeDir, "bin", "llama-server"), "#!/bin/sh\n");
		chmodSync(join(runtimeDir, "bin", "llama-server"), 0o755);
		writeFileSync(modelPath, "fake gguf");
		mkdirSync(projectDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs a local llama runtime, imports a model, and prints a locked localhost launch command", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleNativePackageCommand([
			"runtime",
			"install",
			"llama.cpp",
			"--from",
			runtimeDir,
			"--backend",
			"rocm-gfx1100",
			"--version",
			"btest",
		]);
		await handleNativePackageCommand(["model", "import", modelPath, "--name", "qwen36-27b"]);
		await handleNativePackageCommand(["runtime", "start", "llama.cpp", "--print-command"]);

		const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stdout).toContain("Installed lokai.llama.runtime.linux-x64.rocm-gfx1100.btest");
		expect(stdout).toContain("Imported model qwen36-27b");
		expect(stdout).toContain("--host 127.0.0.1");
		expect(stdout).toContain("--port 8081");
		expect(stdout).toContain("--model");
		expect(stdout).toContain(modelPath);
		expect(stdout).not.toContain("--hf-repo");
		expect(stdout).not.toContain("--model-url");

		const statePath = join(tempDir, "lokai", "manager", "registry", "native-packages.json");
		expect(existsSync(statePath)).toBe(true);
		const modelsConfig = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8")) as {
			providers?: Record<string, { baseUrl?: string; models?: Array<{ id?: string }> }>;
		};
		expect(modelsConfig.providers?.["lokai-local"]?.baseUrl).toBe("http://127.0.0.1:8081/v1");
		expect(modelsConfig.providers?.["lokai-local"]?.models?.[0]?.id).toBe("qwen36-27b");
	});
});
