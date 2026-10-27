import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installManagedFile } from "../lib/plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "plugin/background-agents.ts"), "utf8");
const isolated = ["delegate_isolated", "delegation_accept", "delegation_apply", "delegation_discard"];
const native = ["build", "plan", "general", "explore", "compaction", "title", "summary"];
const unchanged = ["delegate", "delegation_open", "delegation_read", "delegation_tail", "delegation_list",
  "delegation_cancel", "delegation_continue", "same_session_task_list", "same_session_task_read"];
const stockHash = "bdf92ff644d4636a114f85cfd23d783266523ad8834c91d4270ba18485ded839";

// Execute the actual module bodies, substituting ONLY imports and host I/O.
// Do not export private helpers from the legacy runtime plugin for test access.
const javascript = stripTypeScriptTypes(source.replace(/^import .*$/gm, "")
  .replace("export const BackgroundAgents", "const BackgroundAgents")
  .replace("export default BackgroundAgents", ""));
const fixtureSchema = { string() { return this; }, boolean() { return this; },
  describe() { return this; }, optional() { return this; } };
function load({ io = {}, git } = {}) {
  const tool = Object.assign((definition) => definition, { schema: fixtureSchema });
  return new Function("fs", "os", "path", "crypto", "tool", "createOpencodeClientV2", "git",
    javascript + `\nif (git) runGit = git; return {applyIsolatedToolVisibility, ISOLATED_WRITE_TOOLS,
      NATIVE_AGENT_NAMES, BackgroundAgents, DelegationManager, READ_ONLY_DELEGATION_MATRIX,
      createDelegateIsolated, createDelegationAccept, createDelegationApply, createDelegationDiscard};`)(
    io, os, path, crypto, tool, () => ({}), git);
}

test("four exact tools are appended last without changing other permission order", () => {
  for (const broad of ["*", "delegation_*"]) {
    for (const earlier of [true, false]) {
      const rules = Object.fromEntries(earlier
        ? [["delegate_isolated", "allow"], [broad, "allow"], ["bash", { "*": "deny", "git status*": "allow" }]]
        : [[broad, "allow"], ["bash", "ask"], ["delegation_apply", { "*": "ask" }]]);
      const config = { permission: { edit: "deny" }, agent: { planner: { mode: "primary", prompt: "unchanged", permission: rules } } };
      const other = Object.entries(rules).filter(([key]) => !isolated.includes(key));
      load().applyIsolatedToolVisibility(config);
      const result = Object.entries(config.agent.planner.permission);
      assert.deepEqual(result, [...other, ...isolated.map((name) => [name, "deny"])]);
      assert.equal(config.agent.planner.prompt, "unchanged");
      assert.deepEqual(config.permission, { edit: "deny" });
      const once = structuredClone(config);
      load().applyIsolatedToolVisibility(config);
      assert.deepEqual(config, once);
    }
  }
});

test("missing/scalar permissions and future configured agents are handled without new allows", () => {
  for (const permission of [undefined, "allow", "ask", "deny", { "*": "deny", delegate: "allow" }]) {
    const config = { agent: { "future-specialist": { permission } } };
    load().applyIsolatedToolVisibility(config);
    const result = config.agent["future-specialist"].permission;
    assert.deepEqual(Object.keys(result).slice(-4), isolated);
    for (const name of isolated) assert.equal(result[name], "deny");
    if (typeof permission === "string") assert.equal(result["*"], permission);
    if (permission === undefined) assert.equal(Object.keys(result).length, 4);
  }
});

test("master-dev and disabled agents are untouched and master is never invented", () => {
  for (const permission of [undefined, "deny", { "*": "ask" }, { delegation_apply: "deny", delegate_isolated: "ask" }]) {
    const master = Object.freeze({ permission, tools: { delegation_apply: false }, model: "fixture/model", prompt: "master" });
    const disabled = Object.freeze({ disable: true, hidden: true, permission: { "*": "allow" } });
    const config = { agent: { "master-dev": master, plan: disabled } };
    load().applyIsolatedToolVisibility(config);
    assert.equal(config.agent["master-dev"], master);
    assert.equal(config.agent.plan, disabled);
  }
  const config = {};
  load().applyIsolatedToolVisibility(config);
  assert.equal(config.agent["master-dev"], undefined);
  assert.deepEqual(Object.keys(config.agent), native);
  for (const agent of Object.values(config.agent)) assert.deepEqual(Object.keys(agent), ["permission"]);
});

test("complete plugin exposes one config callback and exactly thirteen existing tools", async () => {
  const module = load({ io: { mkdir: async () => {} } });
  const hooks = await module.BackgroundAgents({ client: {}, directory: "/fixture", serverUrl: new URL("http://127.0.0.1:1") });
  assert.deepEqual(Object.keys(hooks.tool).sort(), [...isolated, ...unchanged].sort());
  assert.deepEqual([...module.ISOLATED_WRITE_TOOLS], isolated);
  assert.deepEqual([...module.NATIVE_AGENT_NAMES], native);
  const config = { agent: { planner: { permission: { delegate: "allow" } }, "master-dev": { permission: { "*": "ask" } } } };
  await hooks.config(config);
  assert.equal(config.agent.planner.permission.delegate, "allow");
  assert.equal(config.agent.planner.permission.delegate_isolated, "deny");
  assert.deepEqual(config.agent["master-dev"].permission, { "*": "ask" });
});

test("all previously allowed read-only caller/target pairs remain valid", async () => {
  const module = load();
  const manager = new module.DelegationManager({}, {}, "/fixture", "/fixture", () => {});
  manager.validateTargetAgent = async () => {};
  manager.getDelegationDepth = async () => 0;
  assert.deepEqual(module.READ_ONLY_DELEGATION_MATRIX.planner, ["code-inspector", "reviewer", "ui-web-designer"]);
  for (const [parentAgent, targets] of Object.entries(module.READ_ONLY_DELEGATION_MATRIX)) {
    for (const agent of targets) await manager.validateReadOnlyDelegation({ parentAgent, agent, parentSessionID: "fixture" });
  }
  await assert.rejects(manager.validateReadOnlyDelegation({ parentAgent: "knowledge-reader", agent: "code-inspector" }), /not allowed/);
});

test("isolated validator still rejects non-master, invalid targets and nested launches", async () => {
  const module = load();
  const agents = ["master-dev", "backend-java-developer", "frontend-web-developer", "backend-python-developer", "backend-typescript-developer"];
  const manager = new module.DelegationManager({ app: { agents: async () => ({ data: agents.map((name) => ({ name })) }) } }, {}, "/fixture", "/fixture", () => {});
  manager.getDelegationDepth = async () => 0;
  const input = { parentAgent: "master-dev", agent: "backend-java-developer", parentSessionID: "fixture" };
  await manager.validateIsolatedWriteDelegation(input);
  await assert.rejects(manager.validateIsolatedWriteDelegation({ ...input, parentAgent: "planner" }), /restricted to master-dev/);
  for (const agent of ["backend-python-developer", "backend-typescript-developer"]) {
    await assert.rejects(manager.validateIsolatedWriteDelegation({ ...input, agent }), /not allowed/);
  }
  manager.getDelegationDepth = async () => 1;
  await assert.rejects(manager.validateIsolatedWriteDelegation(input), /root orchestration/);
});

test("forced exposure cannot make non-master accept/apply/discard; master still reaches managers", async () => {
  const module = load();
  for (const [factory, method, status] of [
    [module.createDelegationAccept, "acceptIsolated", "accepted"],
    [module.createDelegationApply, "applyIsolated", "applied"],
    [module.createDelegationDiscard, "discardIsolated", "discarded"],
  ]) {
    let mutations = 0;
    const manager = { [method]: async () => { mutations++; return { id: "fixture", status }; } };
    const tool = factory(manager);
    assert.match(await tool.execute({ id: "fixture" }, { sessionID: "fixture", agent: "planner" }), /restricted to master-dev/);
    assert.equal(mutations, 0);
    assert.doesNotMatch(await tool.execute({ id: "fixture" }, { sessionID: "fixture", agent: "master-dev" }), /restricted|failed/);
    assert.equal(mutations, 1);
  }
});

test("forced isolated launch is rejected before mutation, authorized master still forwards", async () => {
  const module = load();
  let mutations = 0;
  const validator = new module.DelegationManager({ app: { agents: async () => ({ data: [{ name: "backend-java-developer" }] }) } }, {}, "/fixture", "/fixture", () => {});
  validator.getDelegationDepth = async () => 0;
  const tool = module.createDelegateIsolated({ delegateIsolated: async (input) => {
    await validator.validateIsolatedWriteDelegation(input);
    mutations++;
    return { id: "fixture", agent: input.agent, status: "pending" };
  } });
  const ctx = { sessionID: "fixture", messageID: "fixture", agent: "planner" };
  assert.match(await tool.execute({ agent: "backend-java-developer", prompt: "fixture" }, ctx), /restricted to master-dev/);
  assert.equal(mutations, 0);
  assert.match(await tool.execute({ agent: "backend-java-developer", prompt: "fixture" }, { ...ctx, agent: "master-dev" }), /queued/);
  assert.equal(mutations, 1);
});

test("lifecycle state, dirty workspace and invalid patch guards still precede mutations", async () => {
  let gitCalls = [];
  let mode = "dirty";
  const module = load({ git: async (args) => {
    gitCalls.push(args);
    if (args[0] === "status") return { exitCode: 0, stdout: mode === "dirty" ? " M fixture" : "" };
    return { exitCode: 1, stderr: "fixture invalid patch" };
  } });
  const manager = new module.DelegationManager({}, {}, "/fixture", "/fixture", () => {});
  let entry = { id: "fixture", status: "running", artifactsDir: "/fixture", result: "fixture" };
  manager.resolveIsolatedDelegation = async () => entry;
  manager.readArtifactText = async () => "fixture diff";
  let writes = 0;
  for (const method of ["captureIsolatedArtifacts", "cleanupIsolatedWorktree", "saveIsolatedMeta", "writeIsolatedSummary"]) {
    manager[method] = async () => { writes++; };
  }
  await assert.rejects(manager.acceptIsolated("fixture", "fixture"), /not awaiting review/);
  await assert.rejects(manager.applyIsolated("fixture", "fixture"), /must be accepted/);
  await assert.rejects(manager.discardIsolated("fixture", "fixture"), /still running/);
  assert.equal(writes, 0);
  entry = { ...entry, status: "accepted" };
  await assert.rejects(manager.applyIsolated("fixture", "fixture"), /not clean/);
  mode = "invalid";
  await assert.rejects(manager.applyIsolated("fixture", "fixture"), /cannot be applied cleanly/);
  assert.equal(writes, 0);
  assert(!gitCalls.some((args) => args[0] === "apply" && !args.includes("--check")));
  entry = { ...entry, status: "applied" };
  await assert.rejects(manager.discardIsolated("fixture", "fixture"), /already applied/);
  entry = { ...entry, status: "review_pending" };
  await manager.acceptIsolated("fixture", "fixture");
  assert.equal(entry.status, "accepted");
});

test("managed stock hash requires backup and unknown modifications remain refused", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest/addon.json"), "utf8"));
  const hashes = manifest.plugins.find((plugin) => plugin.id === "background-agents").compatibleInstalledHashes;
  assert(hashes.includes(stockHash));
  const tmp = await fs.mkdtemp(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), "bg-managed-fixture-"));
  try {
    const stock = path.join(tmp, "installed.ts"), candidate = path.join(tmp, "candidate.ts"), backup = path.join(tmp, "backup.ts");
    await fs.writeFile(stock, "known stock fixture");
    await fs.writeFile(candidate, "candidate fixture");
    const fixtureHash = crypto.createHash("sha256").update("known stock fixture").digest("hex");
    await assert.rejects(installManagedFile(candidate, stock, { replaceCompatibleInstalledHashes: [fixtureHash] }), /backupPath/);
    const unknown = await installManagedFile(candidate, stock, { replaceCompatibleInstalledHashes: hashes, backupPath: backup });
    assert.equal(unknown.state, "modified");
    assert.equal(await fs.readFile(stock, "utf8"), "known stock fixture");
    const known = await installManagedFile(candidate, stock, { replaceCompatibleInstalledHashes: [fixtureHash], backupPath: backup });
    assert.equal(known.state, "replaced_compatible");
    assert.equal(await fs.readFile(backup, "utf8"), "known stock fixture");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("declared native inventory matches the actual opted-in host source", { skip: !process.env.OPENCODE_RUNTIME_SOURCE }, async () => {
  const host = await fs.readFile(path.join(process.env.OPENCODE_RUNTIME_SOURCE, "packages/opencode/src/agent/agent.ts"), "utf8");
  const block = host.slice(host.indexOf("const agents: Record<string, Info> = {"), host.indexOf("for (const [key, value] of Object.entries(cfg.agent"));
  assert.deepEqual([...block.matchAll(/^          (\w+): \{$/gm)].map((match) => match[1]), native);
});

test("complete candidate loads natively after role overrides without re-enabling master restrictions", { skip: !process.env.OPENCODE_BACKGROUND_NATIVE }, async () => {
  const deps = path.resolve(process.env.OPENCODE_BACKGROUND_DEPS);
  assert((await fs.stat(path.join(deps, "@opencode-ai/plugin"))).isDirectory());
  const tmp = await fs.mkdtemp(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), "bg-native-fixture-"));
  try {
    const config = path.join(tmp, "home/.config/opencode");
    await fs.mkdir(path.join(config, "plugins"), { recursive: true });
    await fs.symlink(deps, path.join(config, "node_modules"), "dir");
    for (const name of ["package.json", "package-lock.json", ".gitignore"]) await fs.copyFile(path.join(deps, "..", name), path.join(config, name));
    await fs.copyFile(path.join(root, "plugin/background-agents.ts"), path.join(config, "plugins/background-agents.ts"));
    await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: "openai/gpt-6.1-sol", plugin: [], mcp: {},
      agent: { "master-dev": { mode: "primary", permission: { delegate_isolated: "ask", delegation_accept: "ask", delegation_apply: "deny" }, tools: { delegation_discard: false } },
        planner: { mode: "primary", permission: { delegate_isolated: "allow", "*": "allow", "delegation_*": "allow", task: { "*": "deny", "code-inspector": "allow" } } } },
    }));
    const env = { PATH: process.env.PATH, HOME: path.join(tmp, "home"), XDG_CONFIG_HOME: path.join(tmp, "home/.config"),
      XDG_DATA_HOME: path.join(tmp, "data"), XDG_STATE_HOME: path.join(tmp, "state"), XDG_CACHE_HOME: path.join(tmp, "cache"),
      OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" };
    async function debug(...args) {
      const output = path.join(tmp, "native-output.json");
      const handle = await fs.open(output, "w+");
      try {
        const result = spawnSync("opencode", ["debug", ...args], { cwd: tmp, env, stdio: ["ignore", handle.fd, "pipe"], timeout: 90000 });
        assert.equal(result.status, 0, "Native debug failed; raw output suppressed");
        return JSON.parse(await fs.readFile(output, "utf8"));
      } finally { await handle.close(); }
    }
    const cfg = await debug("config");
    assert.deepEqual(Object.keys(cfg.agent.planner.permission).slice(-4), isolated);
    for (const tool of isolated) assert.equal(cfg.agent.planner.permission[tool], "deny");
    const planner = await debug("agent", "planner");
    for (const tool of isolated) assert.equal(planner.tools[tool], false);
    for (const tool of unchanged) assert.equal(planner.tools[tool], true);
    const master = await debug("agent", "master-dev");
    assert.equal(master.tools.delegation_apply, false);
    assert.equal(master.tools.delegation_discard, false);
    assert.equal(master.tools.delegate_isolated, true);
    assert.equal(master.tools.delegation_accept, true);
    for (const name of native) {
      const agent = await debug("agent", name);
      assert.equal(agent.native, true);
      for (const tool of isolated) assert.equal(agent.tools[tool], false);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
