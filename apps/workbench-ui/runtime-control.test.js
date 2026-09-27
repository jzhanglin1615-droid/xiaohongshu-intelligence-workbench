import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const control = readFileSync(new URL("../../scripts/workbench-control.ps1", import.meta.url), "utf8");
const startLauncher = readFileSync(new URL("../../启动采集台.cmd", import.meta.url), "utf8");
const stopLauncher = readFileSync(new URL("../../停止采集台.cmd", import.meta.url), "utf8");
const statusLauncher = readFileSync(new URL("../../查看采集台状态.cmd", import.meta.url), "utf8");

test("the local service exposes a process-identifiable health endpoint", () => {
  assert.match(server, /url\.pathname === "\/api\/health"/);
  for (const field of ["status", "service", "version", "pid", "port", "startedAt", "generatedAt"]) {
    assert.match(server, new RegExp(`\\b${field}\\b`));
  }
});

test("runtime JSON writes use same-directory atomic replacement", () => {
  assert.match(server, /randomUUID/);
  assert.match(server, /await writeFile\(temporary, serialized/);
  assert.match(server, /await rename\(temporary, file\)/);
  assert.match(server, /const pending = jsonWriteQueues\.get\(file\)/);
});

test("the runtime controller supports start, stop, restart, status, logs, state, and receipts", () => {
  for (const action of ["Start", "Stop", "Restart", "Status"]) assert.match(control, new RegExp(`"${action}"`));
  for (const capability of ["service-control", "logs", "receipts", "workbench-service.json", "api/health"]) {
    assert.match(control, new RegExp(capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(control, /-WindowStyle Hidden/);
  assert.match(control, /NODE_VERSION_UNSUPPORTED/);
});

test("stop is fail-closed and only targets the recorded workbench command", () => {
  assert.match(control, /Get-CimInstance Win32_Process/);
  assert.match(control, /IndexOf\(\$absoluteServerPath/);
  assert.match(control, /IndexOf\(\$relativeServerPath/);
  assert.match(control, /\[int\]\$health\.pid -ne \$ProcessId/);
  assert.match(control, /if \(\$null -eq \$owned\)/);
  assert.match(control, /Stop-Process -Id \$processId/);
});

test("double-click launchers call the same audited runtime controller", () => {
  assert.match(startLauncher, /workbench-control\.ps1" -Action Start -OpenBrowser/);
  assert.match(stopLauncher, /workbench-control\.ps1" -Action Stop/);
  assert.match(statusLauncher, /workbench-control\.ps1" -Action Status/);
});
