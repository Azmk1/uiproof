import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINER_RELAY_DIR,
  CONTAINER_WORK_DIR,
  RELAY_FILENAME,
  containerCommandArgs,
  containerEnvArgs,
  containerHardeningArgs,
  createRepairExecutor,
  executionConfig,
  executionRecordOf,
  makeSandboxWritable,
  probeContainerRuntime,
  resetContainerProbeCache,
  writeRelay,
  type ContainerSandbox,
} from "./container";

/**
 * The container execution model, asserted flag by flag.
 *
 * These tests do not start a container: they check the invocation UIProof builds, which is
 * what the isolation claim actually rests on. `e2e/repair-container.test.ts` then runs the
 * same module against a real runtime and a real application.
 */

const sandbox: ContainerSandbox = {
  runtime: "docker",
  serverVersion: "29.8.2",
  image: "node:24-bookworm-slim",
  config: executionConfig({ image: "node:24-bookworm-slim" }),
  sandboxDir: path.resolve(os.tmpdir(), "uiproof-test", "copy"),
  helperDir: path.resolve(os.tmpdir(), "uiproof-test", "relay"),
  runId: "abcd1234",
};

describe("probeContainerRuntime", () => {
  afterEach(() => resetContainerProbeCache());

  it("reports docker when it answers with a server version", async () => {
    const probe = await probeContainerRuntime({
      refresh: true,
      run: async (binary) =>
        binary === "docker" ? { ok: true, stdout: "29.8.2\n", error: null } : { ok: false, stdout: "", error: "no" },
    });
    expect(probe.available).toBe(true);
    expect(probe.available && probe.runtime.runtime).toBe("docker");
    expect(probe.available && probe.runtime.serverVersion).toBe("29.8.2");
  });

  it("falls back to podman and reports both failures when nothing answers", async () => {
    const seen: string[] = [];
    const probe = await probeContainerRuntime({
      refresh: true,
      run: async (binary) => {
        seen.push(binary);
        return { ok: false, stdout: "", error: `${binary} is not installed or not on PATH` };
      },
    });
    expect(seen).toEqual(["docker", "podman"]);
    expect(probe.available).toBe(false);
    expect(probe.available === false && probe.reason).toContain("docker is not installed");
    expect(probe.available === false && probe.reason).toContain("podman is not installed");
  });

  it("does not accept a CLI that answers without a server version", async () => {
    const probe = await probeContainerRuntime({
      runtime: "docker",
      refresh: true,
      run: async () => ({ ok: true, stdout: " \n", error: null }),
    });
    expect(probe.available).toBe(false);
  });

  it("caches a probe until it is refreshed", async () => {
    let calls = 0;
    const run = async (): Promise<{ ok: boolean; stdout: string; error: string | null }> => {
      calls += 1;
      return { ok: true, stdout: "1.0.0\n", error: null };
    };
    await probeContainerRuntime({ runtime: "docker", refresh: true, run, now: () => 0 });
    await probeContainerRuntime({ runtime: "docker", run, now: () => 1_000 });
    expect(calls).toBe(1);
    await probeContainerRuntime({ runtime: "docker", refresh: true, run, now: () => 2_000 });
    expect(calls).toBe(2);
  });
});

describe("the hardening flags", () => {
  it("removes the network, the writable root and every capability", () => {
    const args = containerHardeningArgs(sandbox);
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("--security-opt");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--init");
    expect(args).toContain("--rm");
    expect(args).toContain("--pids-limit");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");
    expect(args[args.indexOf("--memory") + 1]).toBe("2048m");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args).toContain("--tmpfs");
  });

  it("mounts the checkout read-write and the relay read-only", () => {
    const args = containerHardeningArgs(sandbox);
    const mounts = args.filter((entry) => entry.startsWith("type=bind,"));
    expect(mounts).toContain(`type=bind,source=${sandbox.sandboxDir.split(path.sep).join("/")},target=${CONTAINER_WORK_DIR}`);
    expect(mounts).toContain(
      `type=bind,source=${sandbox.helperDir.split(path.sep).join("/")},target=${CONTAINER_RELAY_DIR},readonly`,
    );
    expect(args[args.indexOf("--workdir") + 1]).toBe(CONTAINER_WORK_DIR);
  });

  it("mounts a dependency volume read-only, and only reads/writes it for an install", () => {
    const withVolume: ContainerSandbox = {
      ...sandbox,
      config: executionConfig({ image: "node:24", dependenciesVolume: "uiproof-deps" }),
    };
    const args = containerHardeningArgs(withVolume);
    expect(args).toContain(`type=volume,source=uiproof-deps,target=${CONTAINER_WORK_DIR}/node_modules,readonly`);

    const install = containerHardeningArgs(withVolume, { dependencies: "rw", network: "egress" });
    expect(install).toContain(`type=volume,source=uiproof-deps,target=${CONTAINER_WORK_DIR}/node_modules`);
    expect(install[install.indexOf("--network") + 1]).toBe("bridge");
  });

  it("passes only environment the sandbox is allowed to see", () => {
    const args = containerEnvArgs({ EXTRA_FLAG: "1" }, "http://127.0.0.1:4199");
    const entries = args.filter((_entry, index) => args[index - 1] === "--env");
    const keys = entries.map((entry) => entry.split("=")[0]);
    expect(keys).not.toContain("PATH");
    expect(keys).not.toContain("HOME");
    expect(keys).not.toContain("TEMP");
    expect(keys).not.toContain("USERPROFILE");
    expect(keys).toContain("EXTRA_FLAG");
    expect(entries).toContain("PORT=4199");
    expect(entries).toContain("HOST=127.0.0.1");

    const secret = containerEnvArgs({ UIPROOF_AI_API_KEY: "sk-do-not-pass" });
    expect(secret.join(" ")).not.toContain("sk-do-not-pass");
  });

  it("puts the image before the command and only attaches stdin for the relay", () => {
    const plain = containerCommandArgs({ sandbox, name: "uiproof-x-build", command: ["npm", "run", "build"] });
    const imageIndex = plain.indexOf(sandbox.image);
    expect(imageIndex).toBeGreaterThan(0);
    expect(plain.slice(imageIndex)).toEqual([sandbox.image, "npm", "run", "build"]);
    expect(plain).not.toContain("-i");

    const relayed = containerCommandArgs({
      sandbox,
      name: "uiproof-x-server",
      command: ["node", `${CONTAINER_RELAY_DIR}/${RELAY_FILENAME}`, "4199", "npm", "start"],
      interactive: true,
    });
    expect(relayed).toContain("-i");
    expect(relayed.indexOf("-i")).toBeLessThan(relayed.indexOf(sandbox.image));
  });
});

describe("the execution record", () => {
  it("describes a host run as unisolated, in the same words everywhere", () => {
    const record = executionRecordOf({ mode: "host", config: executionConfig({ mode: "host" }) });
    expect(record.mode).toBe("host");
    expect(record.readOnlyRoot).toBe(false);
    expect(record.capDropAll).toBe(false);
    expect(record.summary).toContain("not an OS security boundary");
  });

  it("describes a container run with the flags that were actually used", () => {
    const record = executionRecordOf({
      mode: "container",
      runtime: { runtime: "docker", binary: "docker", serverVersion: "29.8.2" },
      config: executionConfig({ image: "node:24-bookworm-slim", network: "egress" }),
    });
    expect(record.mode).toBe("container");
    expect(record.runtime).toBe("docker");
    expect(record.readOnlyRoot).toBe(true);
    expect(record.capDropAll).toBe(true);
    expect(record.noNewPrivileges).toBe(true);
    expect(record.summary).toContain("docker 29.8.2");
    expect(record.summary).toContain("can reach the network");
  });
});

describe("createRepairExecutor", () => {
  const tempDirs: string[] = [];
  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uiproof-executor-"));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses host execution unless the registration trusts it", async () => {
    await expect(
      createRepairExecutor({
        config: executionConfig({ mode: "host" }),
        sandboxDir: await tempDir(),
        helperDir: await tempDir(),
        runId: "test",
      }),
    ).rejects.toThrow(/trustHostExecution/);
  });

  it("builds a host executor when host execution is trusted, and says what it is", async () => {
    const warnings: string[] = [];
    const executor = await createRepairExecutor({
      config: executionConfig({ mode: "host", trustHostExecution: true }),
      sandboxDir: await tempDir(),
      helperDir: await tempDir(),
      runId: "test",
      onWarning: (message) => warnings.push(message),
    });
    expect(executor.mode).toBe("host");
    expect(executor.unisolated).toBe(true);
    expect(warnings.join(" ")).toContain("not an OS security boundary");
  });

  it("refuses container mode without an image", async () => {
    await expect(
      createRepairExecutor({
        config: executionConfig(),
        sandboxDir: await tempDir(),
        helperDir: await tempDir(),
        runId: "test",
      }),
    ).rejects.toThrow(/no image is registered/);
  });

  it("refuses container mode when no runtime answers, and names the alternative", async () => {
    await expect(
      createRepairExecutor({
        config: executionConfig({ image: "node:24" }),
        sandboxDir: await tempDir(),
        helperDir: await tempDir(),
        runId: "test",
        probe: { available: false, runtime: null, reason: "docker is not installed or not on PATH." },
      }),
    ).rejects.toThrow(/docker is not installed.*trustHostExecution/s);
  });

  it("opens the checkout so a capability-free container can write in it", async () => {
    const sandboxDir = await tempDir();
    await chmod(sandboxDir, 0o700);
    const executor = await createRepairExecutor({
      config: executionConfig({ image: "node:24" }),
      sandboxDir,
      helperDir: await tempDir(),
      runId: "test",
      probe: {
        available: true,
        runtime: { runtime: "docker", binary: "docker", serverVersion: "29.8.2" },
        reason: null,
      },
      imagePresent: async () => true,
    });
    expect(executor.mode).toBe("container");
    // The container drops CAP_DAC_OVERRIDE too, so the mount's own bits decide: a 0700 copy
    // is unwritable inside the sandbox, which is how `vite build` failed on Linux only.
    if (process.platform !== "win32") expect((await stat(sandboxDir)).mode & 0o777).toBe(0o777);
  });

  it("writes the relay outside the checkout and reports container mode", async () => {
    const helperDir = await tempDir();
    const executor = await createRepairExecutor({
      config: executionConfig({ image: "node:24" }),
      sandboxDir: await tempDir(),
      helperDir,
      runId: "test",
      probe: {
        available: true,
        runtime: { runtime: "docker", binary: "docker", serverVersion: "29.8.2" },
        reason: null,
      },
      imagePresent: async () => true,
    });
    expect(executor.mode).toBe("container");
    expect(executor.unisolated).toBe(false);
    const relay = await readFile(path.join(helperDir, RELAY_FILENAME), "utf8");
    expect(relay).toContain("UIProof repair relay");
    expect(await writeRelay(helperDir)).toBe(path.join(helperDir, RELAY_FILENAME));
  });

  it("makes directories writable, keeps executable bits and never follows a symlink", async () => {
    const root = await tempDir();
    const nested = path.join(root, "src", "pages");
    await mkdir(nested, { recursive: true });
    await chmod(root, 0o700);
    await chmod(path.join(root, "src"), 0o700);
    await chmod(nested, 0o700);
    const file = path.join(nested, "page.jsx");
    const script = path.join(root, "build.sh");
    const outside = path.join(await tempDir(), "outside.txt");
    await writeFile(file, "export default 1;\n", "utf8");
    await writeFile(script, "#!/bin/sh\n", "utf8");
    await writeFile(outside, "outside\n", "utf8");
    await chmod(file, 0o600);
    await chmod(script, 0o700);
    await chmod(outside, 0o600);
    const link = path.join(root, "escape");
    let linked = true;
    try {
      await symlink(outside, link, "file");
    } catch {
      linked = false; // Windows without Developer Mode cannot create a symlink; covered on POSIX.
    }

    await makeSandboxWritable(root);

    if (process.platform !== "win32") {
      const mode = async (target: string): Promise<number> => (await stat(target)).mode & 0o777;
      expect(await mode(root)).toBe(0o777);
      expect(await mode(path.join(root, "src"))).toBe(0o777);
      expect(await mode(nested)).toBe(0o777);
      expect((await mode(file)) & 0o666).toBe(0o666);
      expect((await mode(script)) & 0o111).toBe(0o111);
      expect((await mode(script)) & 0o666).toBe(0o666);
      // `chmod` follows symlinks; the copy's link must not change what it points at.
      if (linked) expect(await mode(outside)).toBe(0o600);
    }
    expect(await readFile(file, "utf8")).toBe("export default 1;\n");
  });

  it("refuses a dependency volume that does not exist and cannot be filled", async () => {
    await expect(
      createRepairExecutor({
        config: executionConfig({ image: "node:24", dependenciesVolume: "uiproof-missing-deps" }),
        sandboxDir: await tempDir(),
        helperDir: await tempDir(),
        runId: "test",
        probe: {
          available: true,
          runtime: { runtime: "docker", binary: "does-not-exist-binary", serverVersion: "29.8.2" },
          reason: null,
        },
        imagePresent: async () => true,
      }),
    ).rejects.toThrow(/dependency volume "uiproof-missing-deps" does not exist/);
  });
});
