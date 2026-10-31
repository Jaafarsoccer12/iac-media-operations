import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testPassword = "integration-test-password";
const testAccounts = [
  { userId: "demo-admin", username: "admin.test" },
  { userId: "demo-naqi", username: "naqi.test" },
  { userId: "demo-ameen", username: "ameen.test" },
  { userId: "demo-zayn", username: "zayn.test" },
  { userId: "demo-moqset", username: "moqset.test" },
];

let server;
let baseUrl;
let dataDirectory;
let testWorkspaceDirectory;
let startupOutput = "";
let lastStartupProbe = "No readiness probe completed.";
let cookies = {};

function captureOutput(chunk) {
  startupOutput = `${startupOutput}${chunk}`.slice(-6000);
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(pathname, { method = "GET", cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${method} ${pathname} returned HTTP ${response.status} without a JSON response: ${text.slice(0, 400)}\n${startupOutput}`); }
  return { response, json };
}

async function login(username, password = testPassword) {
  const { response, json } = await request("/api/auth", { method: "POST", body: { action: "demo_login", username, password } });
  assert.equal(response.status, 200, json.error);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "demo session cookie is set");
  return cookie.split(";")[0];
}

async function action(cookie, actionName, payload = {}) {
  return request("/api/operations", { method: "POST", cookie, body: { action: actionName, payload } });
}

function dateIn(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }

function writeTemporaryAccounts() {
  const accounts = testAccounts.map(({ userId, username }) => {
    const salt = randomBytes(16).toString("hex");
    return { userId, username, salt, passwordHash: scryptSync(testPassword, salt, 64).toString("hex"), lastSignInAt: null };
  });
  writeFileSync(path.join(dataDirectory, "accounts.json"), JSON.stringify(accounts), "utf8");
}

function createIsolatedTestWorkspace() {
  testWorkspaceDirectory = mkdtempSync(path.join(projectRoot, ".test-iac-media-app-"));
  const excluded = new Set([".next", ".local", ".git", "node_modules", ".codex", ".agents"]);
  for (const entry of readdirSync(projectRoot)) {
    const name = entry.toLowerCase();
    if (excluded.has(name) || name.startsWith(".test-iac-media-app-") || name === ".env" || name.startsWith(".env.")) continue;
    cpSync(path.join(projectRoot, entry), path.join(testWorkspaceDirectory, entry), { recursive: true });
  }
}

before(async () => {
  createIsolatedTestWorkspace();
  dataDirectory = path.join(testWorkspaceDirectory, ".test-data");
  mkdirSync(dataDirectory, { recursive: true });
  writeTemporaryAccounts();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: testWorkspaceDirectory,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEMO_MODE: "true",
      DEMO_SESSION_SECRET: "integration-test-secret-keep-local",
      IAC_DEMO_DATA_PATH: path.join(dataDirectory, "operations.json"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", captureOutput);
  server.stderr.on("data", captureOutput);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js test server exited before becoming ready (${server.exitCode}).\n${startupOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth`);
      if (response.ok) break;
      lastStartupProbe = `HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`;
      if (response.status >= 500 && /Failed to compile|Module not found|Error:/i.test(startupOutput)) {
        throw new Error(`Next.js returned ${response.status} while compiling the test server.\n${startupOutput}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Next.js returned")) throw error;
      lastStartupProbe = error instanceof Error ? error.message : String(error);
      // Wait for the local server to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const ready = await fetch(`${baseUrl}/api/auth`).catch((error) => { lastStartupProbe = error instanceof Error ? error.message : String(error); return null; });
  if (ready && !ready.ok) lastStartupProbe = `HTTP ${ready.status}: ${(await ready.text()).slice(0, 400)}`;
  assert.ok(ready?.ok, `Next.js development server becomes ready. Last probe: ${lastStartupProbe}\n${startupOutput}`);

  for (const account of testAccounts) cookies[account.userId] = await login(account.username);
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
  }
  if (testWorkspaceDirectory) {
    const tempRoot = `${path.resolve(projectRoot)}${path.sep}`.toLowerCase();
    const target = path.resolve(testWorkspaceDirectory).toLowerCase();
    if (target.startsWith(tempRoot) && path.basename(target).startsWith(".test-iac-media-app-")) rmSync(testWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("sign-in and protected API access use the current demo action and roles", async () => {
  const anonymous = await request("/api/bootstrap");
  assert.equal(anonymous.response.status, 401);

  const invalidCredentials = await request("/api/auth", { method: "POST", body: { action: "demo_login", username: "naqi.test", password: "wrong-password" } });
  assert.equal(invalidCredentials.response.status, 401);

  const { response, json } = await request("/api/bootstrap", { cookie: cookies["demo-naqi"] });
  assert.equal(response.status, 200);
  assert.equal(json.context.user.role, "PTZ Camera Operator");
  assert.equal(json.data.events.length, 13, "crew can see the full upcoming program list");
  assert.ok(json.data.profiles.every((profile) => profile.email === ""), "private team emails are omitted");

  const denied = await action(cookies["demo-naqi"], "create_event", { title: "Unauthorized event" });
  assert.equal(denied.response.status, 403);
});

test("the administrator can publish an event and crew can respond only to their own assignment", async () => {
  const eventInput = {
    title: "Integration Test Program", category: "General", date: dateIn(21), startTime: "18:00", endTime: "20:00",
    setupTime: "16:30", timeZone: "America/New_York", venue: "Test Hall", leadId: "demo-admin",
    description: "Temporary API test event.", livestream: true, recording: true, photography: false,
    publicInfo: "Test event.", privateNotes: "Private test note.",
  };
  const created = await action(cookies["demo-admin"], "create_event", eventInput);
  assert.equal(created.response.status, 200, created.json.error);
  const eventId = created.json.id;

  const published = await action(cookies["demo-admin"], "publish_event", { eventId });
  assert.equal(published.response.status, 200, published.json.error);

  const { json: naqi } = await request("/api/bootstrap", { cookie: cookies["demo-naqi"] });
  const assignment = naqi.data.assignments.find((item) => item.eventId === eventId && item.userId === "demo-naqi");
  assert.ok(assignment, "new events receive the current default crew selection");

  const accepted = await action(cookies["demo-naqi"], "set_event_response", { assignmentId: assignment.id, response: "Accepted" });
  assert.equal(accepted.response.status, 200, accepted.json.error);
  const someoneElses = await action(cookies["demo-zayn"], "set_event_response", { assignmentId: assignment.id, response: "Accepted" });
  assert.equal(someoneElses.response.status, 403);
});

test("checklists are visible to the assigned person and managers only", async () => {
  const item = await action(cookies["demo-admin"], "create_checklist_item", {
    eventId: "event-demo-01", userId: "demo-naqi", label: "Check PTZ camera presets", required: true,
  });
  assert.equal(item.response.status, 200, item.json.error);

  const naqi = await request("/api/bootstrap", { cookie: cookies["demo-naqi"] });
  assert.ok(naqi.json.data.checklistItems.some((entry) => entry.id === item.json.id));
  const zayn = await request("/api/bootstrap", { cookie: cookies["demo-zayn"] });
  assert.ok(!zayn.json.data.checklistItems.some((entry) => entry.id === item.json.id));
  const admin = await request("/api/bootstrap", { cookie: cookies["demo-admin"] });
  assert.ok(admin.json.data.checklistItems.some((entry) => entry.id === item.json.id));
});

test("checklist template names may be reused across program stages, but not within one stage", async () => {
  const name = "API stage-scoped template name";
  const tasks = [{ label: "Check the assigned setup", required: true }];
  const preEvent = await action(cookies["demo-admin"], "create_checklist_template", { name, category: "Pre-event", tasks });
  assert.equal(preEvent.response.status, 200, preEvent.json.error);

  const quran = await action(cookies["demo-admin"], "create_checklist_template", { name, category: "Quran", tasks });
  assert.equal(quran.response.status, 200, quran.json.error);
  assert.notEqual(quran.json.id, preEvent.json.id);

  const duplicateInSameStage = await action(cookies["demo-admin"], "create_checklist_template", { name, category: "Pre-event", tasks });
  assert.equal(duplicateInSameStage.response.status, 409);

  const { json } = await request("/api/bootstrap", { cookie: cookies["demo-admin"] });
  assert.ok(json.data.checklistTemplates.some((template) => template.id === preEvent.json.id && template.category === "Pre-event"));
  assert.ok(json.data.checklistTemplates.some((template) => template.id === quran.json.id && template.category === "Quran"));
});

test("equipment manager controls equipment while borrowers see only their own loans", async () => {
  const created = await action(cookies["demo-ameen"], "create_asset", {
    assetCode: "IAC-TEST-001", name: "Integration Test Camera", category: "Camera", location: "Test room",
    model: "Test model", serial: "TEST-001", condition: "Good", notes: "Temporary API test asset.",
  });
  assert.equal(created.response.status, 200, created.json.error);

  const denied = await action(cookies["demo-naqi"], "update_asset", {
    assetId: created.json.id, assetCode: "IAC-TEST-001", name: "Unauthorized edit", category: "Camera", location: "Test room",
    model: "Test model", serial: "TEST-001", condition: "Good", notes: "",
  });
  assert.equal(denied.response.status, 403);

  const issue = await action(cookies["demo-ameen"], "issue_equipment", {
    assetId: created.json.id, borrowerId: "demo-naqi", handoffDate: dateIn(0), timeZone: "America/New_York",
    dueDate: dateIn(5), checkoutNotes: "Temporary handoff fixture.",
  });
  assert.equal(issue.response.status, 200, issue.json.error);

  const naqi = await request("/api/bootstrap", { cookie: cookies["demo-naqi"] });
  assert.ok(naqi.json.data.loans.some((loan) => loan.id === issue.json.id && loan.borrowerId === "demo-naqi"));
  assert.ok(naqi.json.data.assets.some((asset) => asset.id === created.json.id));
  const zayn = await request("/api/bootstrap", { cookie: cookies["demo-zayn"] });
  assert.ok(!zayn.json.data.loans.some((loan) => loan.id === issue.json.id));
  assert.ok(!zayn.json.data.assets.some((asset) => asset.id === created.json.id));
  const ameen = await request("/api/bootstrap", { cookie: cookies["demo-ameen"] });
  assert.ok(ameen.json.data.assets.some((asset) => asset.id === created.json.id));
  assert.ok(ameen.json.data.loans.some((loan) => loan.id === issue.json.id));
});

test("incident reports stay private to their reporter and management", async () => {
  const incident = await action(cookies["demo-naqi"], "report_incident", {
    category: "Video issue", severity: "High", description: "Test signal dropped during a check.", immediateAction: "Notified the director.",
  });
  assert.equal(incident.response.status, 200, incident.json.error);

  const own = await request("/api/bootstrap", { cookie: cookies["demo-naqi"] });
  assert.ok(own.json.data.incidents.some((entry) => entry.id === incident.json.id));
  const other = await request("/api/bootstrap", { cookie: cookies["demo-zayn"] });
  assert.ok(!other.json.data.incidents.some((entry) => entry.id === incident.json.id));

  const denied = await action(cookies["demo-naqi"], "resolve_incident", { incidentId: incident.json.id, resolution: "Not allowed." });
  assert.equal(denied.response.status, 403);
  const resolved = await action(cookies["demo-admin"], "resolve_incident", { incidentId: incident.json.id, resolution: "Test resolution." });
  assert.equal(resolved.response.status, 200, resolved.json.error);
  const admin = await request("/api/bootstrap", { cookie: cookies["demo-admin"] });
  assert.ok(admin.json.data.incidents.some((entry) => entry.id === incident.json.id && entry.resolution === "Test resolution."));
});

test("logout clears access to protected records", async () => {
  const logout = await request("/api/auth", { method: "POST", cookie: cookies["demo-moqset"], body: { action: "logout" } });
  assert.equal(logout.response.status, 200);
  const cookie = logout.response.headers.get("set-cookie")?.split(";")[0];
  const blocked = await request("/api/bootstrap", { cookie });
  assert.equal(blocked.response.status, 401);
});
