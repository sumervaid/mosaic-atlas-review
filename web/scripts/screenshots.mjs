// Capture the MOSAIC Atlas screens at 1440x900, device scale 2, into docs/screenshots.
// Needs a running API and a running production web build. Uses installed Google Chrome, so no browser is downloaded.
//
//   API_URL=http://127.0.0.1:8000 WEB_URL=http://127.0.0.1:3000 node scripts/screenshots.mjs
//
// Pass names to capture only some, such as: node scripts/screenshots.mjs setup concept
// Start the API on a fresh MOSAIC_HOME. The setup scene expects no saved key, and the replay scene expects no saved edge.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const WEB_URL = (process.env.WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = process.env.OUT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots");
const only = new Set(process.argv.slice(2));
const TIMEOUT = 180_000;

mkdirSync(OUT, { recursive: true });

async function api(p, init) {
  const res = await fetch(`${API_URL}${p}`, init);
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function hideCaret(page) {
  await page.addStyleTag({ content: "*{caret-color:transparent!important;transition:none!important}" });
}

async function shot(page, name, { fullPage = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await hideCaret(page);
  await page.waitForTimeout(150); // one paint after the last data arrives
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`saved ${file}`);
}

const canvasFilled = (page, min = 1) =>
  page.waitForFunction((n) => Number(document.querySelector('[data-testid="swarm-canvas"]')?.dataset.filled ?? 0) >= n, min, { timeout: TIMEOUT });

/** Find one agent on the map by moving the mouse and reading back the canvas's own hit test, then click it. */
async function clickAgentOnCanvas(page, agent) {
  const canvas = page.getByTestId("swarm-canvas");
  await canvas.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await canvas.boundingBox();
  // Team 1 sits at the top of the ellipse, with its lead at the centre of the cluster.
  for (let y = 4; y < box.height / 2; y += 2) {
    await page.mouse.move(box.x + box.width / 2, box.y + y);
    if ((await canvas.getAttribute("data-hover")) === agent) {
      await page.mouse.click(box.x + box.width / 2, box.y + y);
      return;
    }
  }
  throw new Error(`Could not find ${agent} on the map by hovering.`);
}

const scenes = {
  async "intervene-recorded"(page) {
    await page.goto(`${WEB_URL}/intervene?exp=scale-50-negative-lead&color=difference&step=5`);
    await canvasFilled(page, 50);
    await page.getByTestId("outcome-table").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("paired-messages").waitFor({ timeout: TIMEOUT });
    await shot(page, "intervene-recorded", { fullPage: true });
  },
  async "intervene-agent"(page) {
    await page.goto(`${WEB_URL}/intervene?exp=pilot-negative-lead&color=difference&step=3`);
    await canvasFilled(page, 6);
    await page.getByTestId("paired-messages").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("trace-chart").waitFor({ timeout: TIMEOUT });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await shot(page, "intervene-agent");
  },
  async "intervene-live"(page) {
    await api("/experiments", { method: "POST", headers: { "content-type": "application/json" }, body: '{"template":"test_256"}' });
    const frames = [];
    page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(JSON.parse(f.payload))));
    await page.goto(`${WEB_URL}/intervene?exp=test-256&color=difference`, { waitUntil: "networkidle" });
    await page.getByTestId("swarm-canvas").waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="swarm-canvas"]')?.dataset.agents) === 256, null, { timeout: TIMEOUT });
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await page.getByRole("button", { name: "Select agents" }).click();
    const clear = page.getByRole("button", { name: "Clear", exact: true });
    if (await clear.isEnabled()) await clear.click();
    await clickAgentOnCanvas(page, "A001");
    await page.getByRole("button", { name: "Remove A001 from the selection" }).waitFor();
    await page.getByTestId("fork-button").click();
    await page.getByTestId("fork-progress").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("outcome-table").waitFor({ timeout: TIMEOUT });
    await canvasFilled(page, 200);
    const running = frames.filter((f) => f.status === "running").length;
    if (!running || frames.at(-1)?.status !== "complete") throw new Error(`Progress did not stream. Frames: ${JSON.stringify(frames.slice(-3))}`);
    console.log(`live loop: A001 selected by canvas click, ${frames.length} progress frames over WebSocket, last status ${frames.at(-1).status}`);
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "intervene-live", { fullPage: true });
  },
  async concept(page) {
    await page.goto(`${WEB_URL}/concept?model=gemma-3-4b-it&source=pilot-directions&index=0&exp=scale-50-negative-lead&step=5`);
    await page.getByTestId("density-chart").waitFor({ timeout: TIMEOUT });
    await canvasFilled(page, 50);
    await page.getByTestId("test-run").click();
    await page.getByTestId("test-blocked").waitFor({ timeout: TIMEOUT });
    await shot(page, "concept", { fullPage: true });
  },
  async search(page) {
    await page.goto(`${WEB_URL}/search?mode=inference`);
    await page.getByTestId("inference-run").click();
    await page.getByTestId("inference-results").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await shot(page, "search", { fullPage: true });
  },
  async "steer-recorded"(page) {
    await page.goto(`${WEB_URL}/steer`);
    await page.getByTestId("steer-rounds").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("trace-chart").waitFor({ timeout: TIMEOUT });
    await shot(page, "steer-recorded");
  },
  async contagion(page) {
    const list = await api("/experiments");
    if (!list.live.find((e) => e.id === "test-256")?.forks.length) throw new Error("Run the intervene-live scene first, so a fork exists.");
    await page.goto(`${WEB_URL}/contagion?exp=test-256&feature=3`);
    await page.getByTestId("link-canvas").waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="link-canvas"]')?.dataset.nodes) > 0, null, { timeout: TIMEOUT });
    const canvas = page.getByTestId("link-canvas");
    await canvas.focus();
    // Step 1 of team 1 opens on the lead. Keyboard selection finds it without guessing at pixels.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.getByTestId("replay-button").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("replay-button").click();
    await page.getByRole("button", { name: "Replay without this message" }).waitFor({ timeout: TIMEOUT });
    await page.getByTestId("edge-row").first().waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="link-canvas"]')?.dataset.edges) >= 1, null, { timeout: TIMEOUT });
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(0, 0);
    await page.getByTestId("message-card").waitFor();
    await shot(page, "contagion", { fullPage: true });
  },
  async setup(page) {
    await page.goto(`${WEB_URL}/setup`);
    await page.getByTestId("setup-form").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("setup-problems").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("preview-commands").click();
    await page.getByTestId("machine-card").getByRole("alert").waitFor({ timeout: TIMEOUT });
    await page.evaluate(() => document.activeElement?.blur());
    await shot(page, "setup", { fullPage: true });
  },
  async "steer-live"(page) {
    await page.goto(`${WEB_URL}/steer?tab=live`);
    await page.getByTestId("steer-run").click();
    await page.getByTestId("steer-live-result").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await shot(page, "steer-live");
  },
  // Saves settings, so it follows the setup scene. Needs a fake key and token, written by scripts/record_workflows.sh.
  async "setup-preview"(page) {
    const { DEMO_KEY_PATH, DEMO_TOKEN_PATH } = process.env;
    if (!DEMO_KEY_PATH || !DEMO_TOKEN_PATH) {
      console.log("skipped setup-preview. Set DEMO_KEY_PATH and DEMO_TOKEN_PATH to fake files.");
      return;
    }
    await page.goto(`${WEB_URL}/setup`);
    await page.getByTestId("key-path").fill(DEMO_KEY_PATH);
    await page.getByTestId("hf-path").fill(DEMO_TOKEN_PATH);
    await page.getByTestId("setup-save").click();
    await page.getByTestId("key-info").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("preview-commands").click();
    await page.getByTestId("preview-output").waitFor({ timeout: TIMEOUT });
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await shot(page, "setup-preview", { fullPage: true });
  },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
const failures = [];
try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (only.size && !only.has(name)) continue;
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/status of (404|409|422)/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    try {
      await scene(page);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      await page.screenshot({ path: path.join(tmpdir(), `atlas-failed-${name}.png`) }).catch(() => undefined);
    }
    if (problems.length) failures.push(`${name}: ${problems.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
