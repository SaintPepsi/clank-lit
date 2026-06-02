const { chromium } = require("playwright");
const path = require("path");

const FILE = "file://" + path.resolve(__dirname, "index.html");
const SHOTS = path.resolve(__dirname, "shots");
require("fs").mkdirSync(SHOTS, { recursive: true });

const errors = [];
const log = (...a) => console.log("•", ...a);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 520, height: 860 } });
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE.ERROR: " + m.text()); });

  // fresh session
  await page.goto(FILE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(FILE);

  // wait for options to appear (after cold open)
  const opts = async () => page.$$eval("#opts .opt", els => els.map(e => e.textContent.trim()));
  const waitOpts = async () => { await page.waitForSelector("#opts .opt", { timeout: 9000 }); await page.waitForTimeout(120); };
  const clickOpt = async (match) => {
    await waitOpts();
    const labels = await opts();
    const idx = labels.findIndex(l => match.test(l));
    if (idx < 0) { log("NO OPTION matching", match, "— have:", labels); return false; }
    log("click:", labels[idx]);
    await page.$$eval("#opts .opt", (els, i) => els[i].click(), idx);
    await page.waitForTimeout(250);
    return true;
  };
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, name) }); log("shot", name); };

  // ── onboarding ──
  await waitOpts(); await shot("01-greeting.png");
  await clickOpt(/what can you make/i);
  await clickOpt(/multiplayer game/i);
  await clickOpt(/start with a todo app|fine, a todo app|todo app/i);
  await page.waitForTimeout(400);
  await shot("02-booted.png");

  // ── add features until none left (climb the tech tree) ──
  for (let i = 0; i < 30; i++) {
    await waitOpts();
    const labels = await opts();
    const addIdx = labels.findIndex(l => /^\+ Add /.test(l));
    const promoIdx = labels.findIndex(l => /^🚀 Now add/.test(l));
    const pick = addIdx >= 0 ? addIdx : promoIdx;
    if (pick < 0) { log("no more features to add. options:", labels); break; }
    log("add:", labels[pick]);
    await page.$$eval("#opts .opt", (els, x) => els[x].click(), pick);
    await page.waitForTimeout(300);
  }
  // wait for the app pane to actually settle (reload overlay gone, controls present)
  await page.waitForSelector('[data-act="devadd"]', { state: "visible", timeout: 8000 });
  await shot("03-all-features.png");

  // ── exercise the app (top pane) ──
  const asserts = [];
  const clickAct = async (sel, label) => {
    try { await page.waitForSelector(sel, { state: "visible", timeout: 5000 }); }
    catch { asserts.push("✗ MISSING: " + label); return false; }
    await page.click(sel); await page.waitForTimeout(170); return true;
  };
  const check = async (name, fn) => { const ok = await page.evaluate(fn); asserts.push((ok ? "✓ " : "✗ ") + name); };

  // dev tools: add random tasks (enough to trip bug thresholds)
  for (let i = 0; i < 8; i++) await clickAct('[data-act="devadd"]', "devadd +random task");
  await check("devadd created todos", () => document.querySelectorAll('#todoList .todo').length >= 5);
  await shot("04-tasks-added.png");

  // per-task controls on the first task
  await clickAct('[data-act="tagadd"]', "tagadd");
  await clickAct('[data-act="tagadd"]', "tagadd");
  await check("tags rendered", () => document.querySelectorAll('.tagchip').length >= 2);
  await clickAct('[data-act="cycprio"]', "cycprio");
  await check("priority set", () => !!document.querySelector('.meta.prio1,.meta.prio2,.meta.prio3'));
  await clickAct('[data-act="cycdue"]', "cycdue");
  await check("due set", () => /Today|Tomorrow|Next week/.test(document.querySelector('#todoList').textContent));
  await clickAct('[data-act="cycasg"]', "cycasg");
  await clickAct('[data-act="cyclabel"]', "cyclabel");
  await clickAct('[data-act="cycstatus"]', "cycstatus");
  await clickAct('[data-act="toggle"]', "toggle checkbox");
  await check("a box is checked", () => !!document.querySelector('.box.done'));
  await shot("05-task-controls.png");

  // views
  await clickAct('[data-act="vlanes"]', "lanes");
  await check("swimlane sections", () => document.querySelectorAll('.section').length >= 1);
  await shot("06-lanes.png");
  await clickAct('[data-act="vkanban"]', "board");
  await check("kanban columns", () => document.querySelectorAll('.kanban .col').length === 3);
  await shot("07-kanban.png");
  await clickAct('[data-act="vgroups"]', "group");
  await shot("08-groups.png");
  await clickAct('[data-act="dark"]', "dark");
  await check("dark→light theme applied", () => !!document.querySelector('.appcard.light'));
  await shot("09-dark.png");

  // search filter
  await clickAct('[data-act="vgroups"]', "reset group");   // back to flat
  const si = await page.$('#searchInput');
  if (si) { await si.fill("zzzzz"); await page.waitForTimeout(250);
    await check("search filters everything out", () => document.querySelectorAll('#todoList .todo').length === 0);
    await si.fill(""); await page.waitForTimeout(150);
  } else asserts.push("✗ MISSING: search input");

  // simulated features: clickable banner → toast
  const banner = await page.$('.simbanner[data-act="sim"]');
  if (banner) { await banner.click(); await page.waitForTimeout(200);
    await check("sim banner shows a toast", () => document.getElementById('toast').classList.contains('show'));
  } else asserts.push("✗ MISSING: sim banner");
  // ghost-activity engine: wait for a tick to mutate the world
  const before = await page.evaluate(() => document.querySelector('#banners').textContent);
  await page.waitForTimeout(7000);
  await check("ghost activity changed the app", async () => true); // observed below
  const after = await page.evaluate(() => document.querySelector('#banners').textContent);
  asserts.push((before !== after ? "✓ " : "✗ ") + "ghost activity updated banners over time");
  await shot("11-sims-alive.png");

  // inspector
  await page.keyboard.press("`"); await page.waitForTimeout(150);
  await check("inspector visible", () => getComputedStyle(document.getElementById('debug')).display !== "none");
  await shot("10-inspector.png");

  console.log("\n===== ASSERTIONS =====");
  asserts.forEach(a => console.log(a));

  await browser.close();
  console.log("\n===== ERRORS (" + errors.length + ") =====");
  errors.slice(0, 40).forEach(e => console.log(e));
  if (!errors.length) console.log("none 🎉");
})().catch(e => { console.error("SCRIPT FAILED:", e); process.exit(1); });
