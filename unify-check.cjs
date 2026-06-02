/* unify-check.cjs — FAILING acceptance probe (TDD driver) for the unified bug system.
 *
 * Drives the unified-bug-system refactor of Clank-lit. It exercises the NEW API
 * surface that does not exist yet:
 *   bug(id), armed(s,id), bugActive(id), wouldFire(id), bugHits(id)
 *
 * Expected verdict TODAY: ACCEPTANCE FAIL ❌  (bugHits / bugActive are undefined).
 * It goes GREEN once the refactor lands.
 *
 * Run:
 *   cd /Users/ian.hogers/clank-lit
 *   PWROOT=/Users/ian.hogers/.npm/_npx/bc46ece8a1067505/node_modules \
 *     NODE_PATH=$PWROOT node unify-check.cjs
 */
const { chromium } = require("playwright");
const path = require("path");

const FILE = "file://" + path.resolve(__dirname, "index.html");

const pageErrors = [];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 520, height: 860 } });
  page.on("pageerror", e => pageErrors.push("PAGEERROR: " + (e && e.message ? e.message : String(e))));

  // ── fresh session ──
  await page.goto(FILE);
  await page.evaluate(() => localStorage.removeItem("clanklit.v1"));
  await page.goto(FILE);
  // a 1400ms cold-open timer flips phase='onboarding' on fresh boot — wait it out.
  await page.waitForTimeout(1700);

  // Default summary so a hard crash inside evaluate still prints a verdict.
  let summary = {
    truncated: false,
    felt: false,
    fixedSuppresses: false,
    receiptHasFeatureBug: false,
    evalError: null,
  };

  try {
    summary = await page.evaluate(() => {
      const out = {
        truncated: false,
        felt: false,
        fixedSuppresses: false,
        receiptHasFeatureBug: false,
        evalError: null,
      };

      // ── in-page state where the `notes` FEATURE bug is active ──
      state.phase = "building";
      state.features = ["notes", "tags", "priority", "search"]; // complexity 4
      state.activeBugs = ["notes"];
      state.experienced = [];
      state.fixed = [];
      state.todos = [{ id: 1, text: "a", note: "" }];
      state.nextId = 2;

      // (a) notes bug effect applies AND is felt. Run the note-edit code path inline
      // (editNote() uses prompt(), unavailable headless). bugHits('notes') is the
      // NEW action-layer helper — undefined today → this throws (expected failure).
      state.todos[0].note = bugHits("notes") ? "abcdefghijklmnop".slice(0, 8) : "abcdefghijklmnop";
      out.truncated = state.todos[0].note.length === 8;
      out.felt = state.experienced.includes("notes");

      // (b) fixing the bug must suppress it via the pure gate.
      markFixed("notes");
      out.fixedSuppresses = bugActive("notes") === false;

      // (c) unified receipt surfaces the (former) feature bug.
      state.phase = "revealed";
      out.receiptHasFeatureBug = receiptHtml().includes("Task notes");

      return out;
    });
  } catch (e) {
    summary.evalError = (e && e.message ? e.message : String(e));
  }

  await browser.close();

  // A captured page error (e.g. ReferenceError: bugHits is not defined) is
  // expected today and counts toward a FAIL.
  const pass =
    summary.truncated &&
    summary.felt &&
    summary.fixedSuppresses &&
    summary.receiptHasFeatureBug &&
    !summary.evalError &&
    pageErrors.length === 0;

  console.log("\n===== UNIFY ACCEPTANCE PROBE =====");
  console.log(JSON.stringify({ ...summary, pageErrors }, null, 2));
  console.log("\n" + (pass ? "ACCEPTANCE PASS ✅" : "ACCEPTANCE FAIL ❌"));
  process.exit(pass ? 0 : 1);
})().catch(e => {
  // Last-resort guard: still print a verdict + non-zero exit if the harness itself dies.
  console.log("\n===== UNIFY ACCEPTANCE PROBE =====");
  console.log(JSON.stringify({
    truncated: false, felt: false, fixedSuppresses: false,
    receiptHasFeatureBug: false, harnessError: String(e && e.message || e), pageErrors,
  }, null, 2));
  console.log("\nACCEPTANCE FAIL ❌");
  process.exit(1);
});
