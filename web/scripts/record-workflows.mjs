// Capture PNG frames for the six workflow GIFs. scripts/make_gifs.py assembles them.
// Start from scripts/record_workflows.sh, which prepares a throwaway API home and fake credentials.
//
//   API_URL=... WEB_URL=... FRAMES_DIR=... DEMO_KEY_PATH=... DEMO_TOKEN_PATH=... node scripts/record-workflows.mjs [names]
//
// Every frame is checked before it is kept. A frame fails the run if it shows a home path, or if a test model
// frame has lost its amber banner. Requests that would start or delete a real machine are blocked outright.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const WEB_URL = (process.env.WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const FRAMES = process.env.FRAMES_DIR;
const { DEMO_KEY_PATH, DEMO_TOKEN_PATH } = process.env;
if (!FRAMES || !DEMO_KEY_PATH || !DEMO_TOKEN_PATH) throw new Error("Set FRAMES_DIR, DEMO_KEY_PATH, and DEMO_TOKEN_PATH. See scripts/record_workflows.sh.");
const only = new Set(process.argv.slice(2));
const TIMEOUT = 240_000;
const STATE = 2800; // long enough to read a caption
const QUICK = 1000; // scrubbing and live progress, under one shared caption
const FORBIDDEN = [/\/Users\//, /\/home\//, new RegExp(process.env.USER || "^$", "i"), /~\/keys/, /private_key/, /BEGIN PRIVATE/];

class Recorder {
  constructor(page, name) {
    this.page = page;
    this.name = name;
    this.dir = path.join(FRAMES, name);
    this.frames = [];
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  /** Save the viewport as one frame with its caption. */
  async snap(caption, { hold = STATE, test = false, filled = false } = {}) {
    const { page } = this;
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(180);
    const text = await page.evaluate(() => {
      const values = [...document.querySelectorAll("input, textarea, select")].map((el) => el.value);
      return `${document.body.innerText}\n${values.join("\n")}`;
    });
    for (const bad of FORBIDDEN) if (bad.test(text)) throw new Error(`${this.name}: frame ${this.frames.length} shows ${bad}.`);
    if (test) {
      const box = await page.getByTestId("test-banner").boundingBox();
      if (!box || box.y < 0 || box.y > 200) throw new Error(`${this.name}: frame ${this.frames.length} lost the amber banner.`);
    }
    if (filled) {
      const n = await page.getByTestId("swarm-canvas").getAttribute("data-filled");
      if (!Number(n)) throw new Error(`${this.name}: frame ${this.frames.length} has an empty map.`);
    }
    const file = `${String(this.frames.length).padStart(3, "0")}.png`;
    await page.screenshot({ path: path.join(this.dir, file) });
    this.frames.push({ file, caption, hold_ms: hold });
  }

  /** Keep at most count of the frames captured since an index, evenly spaced, always with the last. */
  thin(start, count) {
    const group = this.frames.slice(start);
    if (group.length <= count) return;
    const kept = Array.from({ length: count }, (_, i) => group[Math.round((i * (group.length - 1)) / (count - 1))]);
    this.frames = [...this.frames.slice(0, start), ...kept];
  }

  save() {
    writeFileSync(path.join(this.dir, "manifest.json"), JSON.stringify(this.frames, null, 1));
    console.log(`${this.name}: ${this.frames.length} frames`);
  }
}

/** A ring around the control about to be used. It marks the click in frames, since a screenshot shows no pointer. */
async function ring(page, box) {
  await page.evaluate(({ x, y, w, h }) => {
    let el = document.getElementById("gif-ring");
    if (!el) {
      el = document.createElement("div");
      el.id = "gif-ring";
      el.style.cssText = "position:fixed;z-index:9999;pointer-events:none;border:2px solid #8EA4F7;border-radius:10px;box-shadow:0 0 0 3px rgba(142,164,247,.25)";
      document.body.appendChild(el);
    }
    Object.assign(el.style, { left: `${x - 4}px`, top: `${y - 4}px`, width: `${w + 8}px`, height: `${h + 8}px`, display: "block" });
  }, { x: box.x, y: box.y, w: box.width, h: box.height });
}

const unring = (page) => page.evaluate(() => { const el = document.getElementById("gif-ring"); if (el) el.style.display = "none"; });

/** Click a control and ring it where it ends up, since a click can shift the layout. */
async function press(page, locator) {
  await unring(page);
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await page.waitForTimeout(150);
  const box = await locator.boundingBox({ timeout: 500 }).catch(() => null);
  if (box) await ring(page, box);
}

/** Ring the panel a caption describes. */
async function outline(page, testid) {
  await ring(page, await page.getByTestId(testid).boundingBox());
}

/** Scroll one section to the top of the frame, clear of the sticky banner when one is showing. */
async function reveal(page, testid, offset = 16) {
  await unring(page);
  await page.getByTestId(testid).evaluate((el, off) => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - off, behavior: "instant" }), offset);
  await page.waitForTimeout(120);
}

const toTop = (page) => page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

const mapFilled = (page, min = 1) =>
  page.waitForFunction((n) => Number(document.querySelector('[data-testid="swarm-canvas"]')?.dataset.filled ?? 0) >= n, min, { timeout: TIMEOUT });

const mapAgents = (page, n) =>
  page.waitForFunction((x) => Number(document.querySelector('[data-testid="swarm-canvas"]')?.dataset.agents ?? 0) === x, n, { timeout: TIMEOUT });

/** Sweep the mouse along a line and read back the map's own hit test. Clicks the first agent accepted. */
async function clickAgentOnLine(page, accept, line) {
  const canvas = page.getByTestId("swarm-canvas");
  const box = await canvas.boundingBox();
  for (let t = 0; t <= 1; t += 0.004) {
    const x = box.x + box.width * (line.x0 + (line.x1 - line.x0) * t);
    const y = box.y + box.height * (line.y0 + (line.y1 - line.y0) * t);
    await page.mouse.move(x, y);
    const id = await canvas.getAttribute("data-hover");
    if (id && accept(id)) {
      await page.mouse.click(x, y);
      return id;
    }
  }
  throw new Error("Found no matching agent on the line.");
}

const scenes = {
  async "01-recorded-session"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/intervene`);
    await mapFilled(page, 6);
    await page.getByTestId("paired-messages").waitFor({ timeout: TIMEOUT });
    await rec.snap("Researchers open the Intervene screen, where recorded sessions from Gemma 3 4B appear first as real data in a read-only view.", { filled: true });

    await ring(page, await page.getByTestId("experiment-select").boundingBox());
    await page.getByTestId("experiment-select").selectOption("scale-50-negative-lead");
    await mapFilled(page, 50);
    await page.getByTestId("paired-messages").waitFor({ timeout: TIMEOUT });
    await rec.snap("Researchers choose the recorded comparison with fifty AI agents, with the lead steered toward negative affect in the treatment branch.", { filled: true });

    await press(page, page.getByRole("button", { name: "Control", exact: true }));
    await rec.snap("Choosing \"Control\" colours each AI agent on the map by concept activation in the control branch at the current step.", { filled: true });
    await press(page, page.getByRole("button", { name: "Treatment", exact: true }));
    await rec.snap("Choosing \"Treatment\" colours the map by activation in the steered branch, with an orange ring around the intervened lead.", { filled: true });
    await press(page, page.getByRole("button", { name: "Difference", exact: true }));
    await rec.snap("Choosing \"Difference\" colours each AI agent by treatment minus control, with the legend printing the colour range in activation units.", { filled: true });

    const scrubCaption = "Researchers drag the step scrubber through the ten recorded rounds to follow the difference across all fifty AI agents.";
    await unring(page);
    const slider = page.getByLabel("Step", { exact: true });
    for (const i of ["0", "2", "4", "6", "9"]) {
      await slider.fill(i);
      await rec.snap(scrubCaption, { hold: QUICK, filled: true });
    }

    await reveal(page, "front-card", 60);
    await outline(page, "front-card");
    await rec.snap("The divergence front reports the share of AI agents with messages differing from the paired control at each step of this comparison.");
    await outline(page, "hop-card");
    await rec.snap("The effect by hop panels separate the intervened lead from the 49 AI agents one hop away, each panel with a separate vertical scale.");
    await reveal(page, "outcomes-card");
    await outline(page, "outcomes-card");
    await rec.snap("The outcome table lists control, treatment, and difference values with 95 percent intervals, using colour and filled dots for intervals excluding zero.");

    await toTop(page);
    await page.waitForTimeout(150);
    const id = await clickAgentOnLine(page, (x) => x !== "Jesse", { x0: 0.98, x1: 0.55, y0: 0.5, y1: 0.5 });
    await page.getByTestId("agent-card").getByText(`Agent comparison. ${id}`, { exact: false }).waitFor({ timeout: TIMEOUT }).catch(() => undefined);
    await rec.snap(`Researchers click ${id} on the map to choose this AI agent for the comparison panel further down the screen.`, { filled: true });

    await page.getByTestId("paired-messages").waitFor({ timeout: TIMEOUT });
    await reveal(page, "agent-card");
    await outline(page, "paired-messages");
    await rec.snap(`The "Agent comparison" panel pairs control and treatment messages for ${id}, with a marked button at the first divergence between branches.`);
    const stepButtons = page.getByRole("group", { name: "Step of the message pair" }).getByRole("button");
    await press(page, stepButtons.nth(4));
    await rec.snap("Choosing a later step shows the paired messages from this round, above the activation trace for both branches of the session.");
    await unring(page);
  },

  async "02-fork-and-compare"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/intervene`);
    await mapFilled(page, 6);
    await page.selectOption("#template", "test_256");
    await ring(page, await page.locator("#template").boundingBox());
    await rec.snap("Researchers choose the template with 256 AI agents on the test model, in the bar at the top of the Intervene screen.", { filled: true });

    await press(page, page.getByTestId("new-experiment"));
    await mapAgents(page, 256);
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("no-fork").waitFor({ timeout: TIMEOUT });
    await rec.snap("Choosing \"New test experiment\" creates 256 AI agents on a tiny CPU model, with hollow markers showing readings still to arrive.", { test: true });
    await outline(page, "test-banner");
    await rec.snap("The amber banner marks every test model screen, because random weights produce noise with zero scientific meaning.", { test: true });

    await press(page, page.getByRole("button", { name: "All leads" }));
    await rec.snap("The shortcut buttons select a whole team, all leads, or the coordinator with one click, shown here with all fifteen leads.", { test: true });
    await press(page, page.getByRole("button", { name: "Clear", exact: true }));
    await unring(page);
    const clicked = await clickAgentOnLine(page, (x) => x === "A001", { x0: 0.5, x1: 0.5, y0: 0.01, y1: 0.5 });
    await page.getByRole("button", { name: `Remove ${clicked} from the selection` }).waitFor();
    await rec.snap(`After clearing the shortcut selection, researchers click the lead of team 1 on the map, adding ${clicked} to the "1. Agents" card.`, { test: true });

    await press(page, page.getByRole("button", { name: "Clamp", exact: true }));
    await rec.snap("The \"Clamp\" operation fixes a chosen feature at a target value inside the selected AI agents across the chosen window of steps.", { test: true });
    await press(page, page.getByRole("button", { name: "Ablate", exact: true }));
    await rec.snap("The \"Ablate\" operation sets a chosen feature to zero inside the selected AI agents at each position with an active feature.", { test: true });
    await press(page, page.getByRole("button", { name: "Add vector", exact: true }));
    await page.getByTestId("alpha").fill("300");
    await rec.snap("The \"Add vector\" operation adds a named steering vector, shown here as test-vector with alpha 300 from step 1 onward.", { test: true });

    await page.getByTestId("replicates").fill("2");
    await page.getByTestId("snapshot-step").fill("1");
    await page.getByTestId("watch-feature").selectOption("3");
    await reveal(page, "controls-card", 60);
    await rec.snap("Researchers set two paired replicates, a fork at step 1, and watch feature 3, with shared seeds and batch-invariant decoding switched on.", { test: true });

    await press(page, page.getByTestId("fork-button"));
    await page.getByTestId("fork-progress").waitFor({ timeout: TIMEOUT });
    await rec.snap("Choosing \"Fork and compare\" saves a snapshot at the fork step before launching paired control and treatment branches.", { test: true });
    await unring(page);

    const start = rec.frames.length;
    const progress = "Live progress arrives over a WebSocket, naming the current branch, the current step, and the count of finished branches.";
    while (!(await page.getByTestId("outcome-table").isVisible())) {
      await rec.snap(progress, { hold: QUICK, test: true });
      await page.waitForTimeout(2200);
    }
    rec.thin(start, 8);

    await mapFilled(page, 200);
    await toTop(page);
    await page.mouse.move(0, 0);
    await rec.snap("The map fills with measured differences after the fork, with visible colour concentrated in team 1 around the intervened lead.", { test: true, filled: true });
    await reveal(page, "front-card", 90);
    await outline(page, "log-verification");
    await rec.snap("The log verification line confirms an intact signed log across all four compared branches of this fork.", { test: true });
    await outline(page, "front-card");
    await rec.snap("The divergence front reports the share of AI agents differing from control, beside the measured control against control noise floor.", { test: true });
    await outline(page, "hop-card");
    await rec.snap("The effect by hop panels report the change in activation by distance from the intervened lead, as a software check on test model noise.", { test: true });
    await reveal(page, "outcomes-card", 60);
    await outline(page, "outcomes-card");
    await rec.snap("The outcome table lists each rate with a 95 percent interval, with the \"Not measured\" label marking the said versus represented gap.", { test: true });
    await reveal(page, "agent-card", 60);
    await rec.snap("These numbers verify the software on the test model alone, with scientific results requiring a GPU model.", { test: true });
  },

  async "03-concepts-and-search"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/concept?model=gemma-3-4b-it&source=pilot-directions&index=0`);
    await page.getByTestId("density-chart").waitFor({ timeout: TIMEOUT });
    await mapFilled(page, 50);
    await rec.snap("The Concepts screen opens on the recorded negative affect direction, with explanations, activation density, and top activations in one view.");
    await press(page, page.getByTestId("test-run"));
    await page.getByTestId("test-blocked").waitFor({ timeout: TIMEOUT });
    await rec.snap("Testing new text on a recorded direction returns a plain notice, because recorded sessions contain zero model weights.");
    await reveal(page, "top-activations");
    await outline(page, "top-activations");
    await rec.snap("The top activations list shows recorded messages with the highest projection on this direction, labelled by AI agent, step, and seed.");
    await reveal(page, "across-swarm");
    await outline(page, "across-swarm");
    await rec.snap("The \"Across the swarm\" panel maps activation for fifty AI agents at one step, beside role means and the mean by step.", { filled: true });
    await unring(page);
    const slider = page.getByLabel("Step", { exact: true });
    const scrubCaption = "Researchers drag the step scrubber to follow activation in the treatment branch of seed 1 through the recorded rounds.";
    for (const i of ["0", "3", "6", "9"]) {
      await slider.fill(i);
      await page.getByTestId("step-label").getByText(new RegExp(`step ${Number(i) + 1}$`)).waitFor({ timeout: TIMEOUT });
      await rec.snap(scrubCaption, { hold: QUICK, filled: true });
    }

    await toTop(page);
    await press(page, page.getByRole("link", { name: "Search", exact: true }));
    await page.getByTestId("explanation-results").getByRole("link").first().waitFor({ timeout: TIMEOUT });
    await rec.snap("The Search screen opens on explanations, with the recorded direction listed as the sole named concept at this stage.");
    await press(page, page.getByRole("tab", { name: "Search via inference" }));
    await page.getByTestId("inference-run").waitFor();
    await rec.snap("The \"Search via inference\" tab accepts free text, with the test model answering because GPU models remain unloaded on this machine.");
    await press(page, page.getByTestId("inference-run"));
    await page.getByTestId("inference-results").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await unring(page);
    await rec.snap("The search returns active features under the amber banner, because random weights produce these activations as noise.", { test: true });
    await press(page, page.getByTestId("token-strip").getByRole("button").first());
    await rec.snap("Clicking one token narrows the feature list to features peaking on this token, shown here with the first token.", { test: true });
    await press(page, page.getByTestId("inference-results").locator("tbody a").first());
    await page.getByTestId("neighbours").getByRole("link").first().waitFor({ timeout: TIMEOUT });
    await page.waitForTimeout(1500); // the swarm panel loads last
    await unring(page);
    await toTop(page);
    await rec.snap("Researchers follow a feature link into the Concepts screen, with cosine neighbours and logits from the random test dictionary.", { test: true });
  },

  async "04-steer"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/steer`);
    await page.getByTestId("steer-rounds").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("trace-chart").waitFor({ timeout: TIMEOUT });
    await rec.snap("The Steer screen opens on the \"Recorded\" tab, with real default and steered messages from the pilot placed side by side by round.");
    await page.evaluate(() => window.scrollBy({ top: 560, behavior: "instant" }));
    await rec.snap("Each round pairs the default message with the steered message under one seed, beside the activation chart for this AI agent.");
    await toTop(page);
    await ring(page, await page.getByTestId("steer-agent").boundingBox());
    const options = await page.getByTestId("steer-agent").locator("option").evaluateAll((els) => els.map((e) => e.value));
    await page.getByTestId("steer-agent").selectOption(options[1]);
    await page.getByTestId("steer-rounds").getByText("Round 1", { exact: true }).waitFor({ timeout: TIMEOUT });
    await page.waitForTimeout(400);
    await rec.snap("Choosing another AI agent shows messages from a team member, with the panel naming the lead as the direct recipient of the change.");
    await press(page, page.getByRole("tab", { name: "Live" }));
    await page.getByTestId("steer-run").waitFor();
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await rec.snap("The \"Live\" tab sends one prompt twice to a loaded model, with the amber banner marking the test model on this machine.", { test: true });
    await press(page, page.getByTestId("steer-run"));
    await page.getByTestId("steer-live-result").waitFor({ timeout: TIMEOUT });
    await unring(page);
    await rec.snap("The test model returns noise in both columns, confirming the steering path in software, with readable text requiring a GPU model.", { test: true });
  },

  async "05-contagion-replay"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/contagion?exp=scale-50-negative-lead`);
    await page.getByTestId("link-canvas").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("contagion-empty").waitFor({ timeout: TIMEOUT });
    await rec.snap("Recorded sessions show messages alone in the Contagion tracer, because edge weights originate only from replays on a loaded model.");

    await ring(page, await page.getByTestId("contagion-experiment").boundingBox());
    await page.getByTestId("contagion-experiment").selectOption("test-256");
    await page.getByTestId("test-banner").waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="link-canvas"]')?.dataset.nodes) > 0, null, { timeout: TIMEOUT });
    await page.getByTestId("contagion-feature").selectOption("3");
    await page.waitForTimeout(500);
    await unring(page);
    await rec.snap("The Contagion tracer on a forked test experiment lists messages by AI agent and step, opening on team 1 for legibility.", { test: true });

    await page.getByTestId("link-canvas").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.getByTestId("replay-button").waitFor({ timeout: TIMEOUT });
    await page.evaluate(() => document.activeElement?.blur());
    await toTop(page);
    await rec.snap("Researchers select the message from A001 at step 1, opening the \"Node connections\" panel with an empty list of measured edges.", { test: true });

    await ring(page, await page.getByTestId("replay-button").boundingBox());
    await page.getByTestId("replay-button").click();
    await rec.snap("Choosing \"Replay without this message\" repeats the session with this message removed, reading recipient A000 on the next step.", { test: true });
    await page.getByRole("button", { name: "Replay without this message" }).waitFor({ timeout: TIMEOUT });
    await page.getByTestId("edge-row").first().waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="link-canvas"]')?.dataset.edges) >= 1, null, { timeout: TIMEOUT });
    await unring(page);
    await rec.snap("The measured edge appears on the graph, weighted by activation with the message minus activation after removing the message.", { test: true });

    await page.getByTestId("replay-recipient").selectOption("A002");
    await ring(page, await page.getByTestId("replay-button").boundingBox());
    await page.getByTestId("replay-button").click();
    await page.getByRole("button", { name: "Replay without this message" }).waitFor({ timeout: TIMEOUT });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="link-canvas"]')?.dataset.edges) >= 2, null, { timeout: TIMEOUT });
    await unring(page);
    await rec.snap("A second replay for recipient A002 adds a second measured edge from this message to a different reader on the team.", { test: true });

    const prune = page.getByTestId("contagion-prune");
    await prune.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, el.max);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await toTop(page);
    await outline(page, "contagion-prune");
    await rec.snap("The pruning slider hides edges below a chosen absolute weight, leaving the strongest measured edge on the graph at the top setting.", { test: true });
    await unring(page);
    await rec.snap("These weights verify the replay software on the test model alone, because random weights produce noise with zero scientific meaning.", { test: true });
  },

  async "06-google-cloud-setup"(rec) {
    const { page } = rec;
    await page.goto(`${WEB_URL}/setup`);
    await page.getByTestId("setup-problems").waitFor({ timeout: TIMEOUT });
    await rec.snap("The Setup screen lists each remaining requirement before a machine can start, with file paths alone stored for credentials.");
    await page.getByTestId("key-path").fill(DEMO_KEY_PATH);
    await ring(page, await page.getByTestId("key-path").boundingBox());
    await rec.snap("Researchers enter the path to a service account key file, shown here as an obviously fake demonstration key.");
    await page.getByTestId("hf-path").fill(DEMO_TOKEN_PATH);
    await ring(page, await page.getByTestId("hf-path").boundingBox());
    await rec.snap("Researchers enter the path to a file with a Hugging Face token, shown here as a fake demonstration file.");
    await press(page, page.getByTestId("setup-save"));
    await page.getByTestId("key-info").waitFor({ timeout: TIMEOUT });
    await rec.snap("Saving checks the key file, shows the non-secret account and project, and clears the list of requirements.");
    await press(page, page.getByTestId("preview-commands"));
    await page.getByTestId("preview-output").waitFor({ timeout: TIMEOUT });
    await rec.snap("Choosing \"Preview commands\" lists each command for review, with zero changes to Google Cloud and zero cost.");
    await reveal(page, "machine-card");
    await outline(page, "preview-output");
    await rec.snap("The tunnel command at the end of the preview connects the local interface to the API on the machine through SSH.");
    await unring(page);
    await rec.snap("This recording stops at the preview, with a complete session on a GPU recorded in docs/live-check.");
  },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "dark" });
// A recording must never touch a real machine, whichever control a future edit presses.
await context.route("**/compute/gcp/**", async (route) => {
  const url = route.request().url();
  const body = route.request().postData() ?? "";
  if (url.endsWith("/down") || /"dry_run"\s*:\s*false/.test(body)) {
    await route.abort();
    throw new Error("Blocked a request to change a real machine.");
  }
  await route.continue();
});
let failed = false;
try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (only.size && !only.has(name)) continue;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const rec = new Recorder(page, name);
    try {
      await scene(rec);
      rec.save();
      if (errors.length) throw new Error(errors.join("; "));
    } catch (err) {
      failed = true;
      console.error(`${name}: ${err.message}`);
      await page.screenshot({ path: path.join(FRAMES, `failed-${name}.png`) }).catch(() => undefined);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
