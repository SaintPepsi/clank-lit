# Unify Bug Systems — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use ExecutingPlans to implement this plan task-by-task.

**Goal:** Collapse Clank-lit's two bug systems (core `BUGS` array + `FEATURE_BUGS` map) into one `BUGS` registry with a unified arm → fire → feel → report → investigate → fix lifecycle, so feature bugs become reportable/fixable and adding a bug is one data entry + one inline guard.

**Architecture:** One `BUGS` object keyed by id (core + feature bugs, same shape). A pure gate `bugActive(id)` for render/compute paths, a pure `wouldFire(id)` for display, and an action-layer `bugHits(id)` that registers "felt". Effects stay inline at call sites. Migration uses **backward-compat shims** so every commit keeps the regression harness green; shims are deleted in the final task.

**Tech Stack:** Single self-contained HTML file (`index.html`), no build. Verification via Node + Playwright headless probes (`playthrough.cjs` and new `unify-check.cjs`).

**Design doc:** `docs/plans/2026-06-02-unify-bug-systems-design.md`

**Principles preserved** (from design): Single-Source-of-Truth (one `BUGS[id]` home), Unify-Shared-Interfaces (one lifecycle for all bugs), Data-Drives-Behavior (arm/fire as data), Separation-of-Concerns (pure gate vs. action-feel vs. inline effect). Deviation: single-file constraint overrides File-Organization (no module split).

---

## Conventions for every task

- **Project root:** `/Users/ian.hogers/clank-lit`
- **Playwright env prefix** (required for all node probes):
  ```bash
  export PWROOT=/Users/ian.hogers/.npm/_npx/bc46ece8a1067505/node_modules
  export NODE_PATH=$PWROOT
  ```
- **Regression harness** (must stay green after every task from Task 3 on):
  ```bash
  cd /Users/ian.hogers/clank-lit
  node playthrough.cjs   # expect: 13 assertions ✓, ERRORS (0)
  ```
- **Commit after each task.** End commit messages with the Maple co-author trailer.
- There is **no unit-test framework**; "failing test" = a headless probe asserting behavior that fails before the change and passes after.

---

## Task 1: Write the failing acceptance probe (TDD driver)

**Files:**
- Create: `unify-check.cjs`

This probe asserts the NEW capability: a feature bug can be felt, fixed, and then stops manifesting, and appears in the receipt. It MUST fail today (feature bugs are not in the loop).

**Step 1: Write the probe**

```js
// unify-check.cjs — acceptance test for the unified bug system
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file:///Users/ian.hogers/clank-lit/index.html');
  await p.evaluate(() => { try { localStorage.removeItem('clanklit.v1'); } catch (e) {} });
  await p.reload(); await sleep(1700);                // let cold-open timer fire

  const r = await p.evaluate(() => {
    const out = {};
    // Build a state where the 'notes' feature bug is active.
    state.phase = 'building';
    state.features = ['notes','tags','priority','search']; // cx 4
    state.activeBugs = ['notes']; state.experienced = []; state.fixed = [];
    state.todos = [{ id: 1, text: 'a', note: '' }]; state.nextId = 2;

    // (a) feature bug manifests AND is felt when its action runs
    const before = (state.todos[0].note || '');
    editNote_TESTSHIM(1, 'abcdefghijklmnop');           // see note below
    out.truncated = state.todos[0].note.length === 8;   // effect still applies
    out.felt = state.experienced.includes('notes');     // NEW: it entered the felt loop

    // (b) fixing it suppresses it
    if (typeof markFixed === 'function') markFixed('notes');
    out.fixedSuppresses = (typeof bugActive === 'function') ? bugActive('notes') === false : null;

    // (c) receipt lists the feature bug
    state.phase = 'revealed';
    out.receiptHasFeatureBug = receiptHtml().includes('Task notes');
    return out;
  });

  console.log(JSON.stringify({ r, errs: errs.length ? errs : 'none' }, null, 2));
  const pass = r.truncated && r.felt && r.fixedSuppresses === true && r.receiptHasFeatureBug && !errs.length;
  console.log(pass ? '\nACCEPTANCE PASS ✅' : '\nACCEPTANCE FAIL ❌ (expected before implementation)');
  await b.close();
  process.exit(pass ? 0 : 1);
})();
```

> **Note on `editNote_TESTSHIM`:** `editNote` uses `prompt()`, which is unavailable headless.
> In Step 1 also add a tiny test seam OR drive the note via the same code path. Simplest:
> in the probe, replace the `editNote_TESTSHIM(1, '...')` line with a direct re-creation of
> editNote's body using the public helper once it exists:
> `state.todos[0].note = bugHits('notes') ? 'abcdefghijklmnop'.slice(0,8) : 'abcdefghijklmnop';`
> Until `bugHits` exists this line throws → probe fails (correct for TDD). Keep this inline
> form (no shim function needed).

**Step 2: Run it — expect FAIL**

```bash
cd /Users/ian.hogers/clank-lit
node unify-check.cjs
```
Expected: `ACCEPTANCE FAIL ❌` — `bugHits`/`bugActive` are not defined yet (ReferenceError captured) and `felt`/`fixedSuppresses` are false.

**Step 3: Commit the failing test**

```bash
git add unify-check.cjs
git commit -m "test(clank-lit): failing acceptance probe for unified bug system"
```

---

## Task 2: Replace data + helpers with the unified registry (+ compat shims)

**Files:**
- Modify: `index.html:326-338` (the `BUGS` array → object)
- Modify: `index.html:359-364` (`bugDef`/`armed`/`armedBugs`/`bugFires`)
- Modify: `index.html:466-487` (`FEATURE_BUGS`/`featReq`/`featBugOn`/`bugChance`/`rollBugs`)

**Step 1: Replace the `BUGS` array (lines 326-338) with the unified object**

```js
/* ── Bugs: ONE registry. arm = when capable (threshold|roll); fires = manifests now. ── */
const BUGS = {
  // core gameplay bugs — guaranteed at a complexity threshold, fire on a list condition
  delete:   { arm:{type:'threshold', at:2}, fires:s=>s.todos.length>3,  label:"Deleting a task",
              desc:"wait, deleting a task just removed the bottom one instead?" },
  checkoff: { arm:{type:'threshold', at:3}, fires:s=>s.todos.length>5,  label:"Checking off tasks",
              desc:"ticking a box seems to tick a different task?" },
  ghost:    { arm:{type:'threshold', at:4}, fires:s=>s.todos.length>=7, label:"Adding a task",
              desc:"i think a task vanishes whenever i add a new one?" },
  // feature bugs — emergent (rolled, chance ↑ complexity), fire whenever that action runs
  search:    { arm:{type:'roll'}, feature:"search",    label:"Search",        desc:"matches only the first word of your query" },
  sorting:   { arm:{type:'roll'}, feature:"sorting",   label:"Sorting",       desc:"sorts everything except the top item" },
  filtering: { arm:{type:'roll'}, feature:"filtering", label:"Filtering",     desc:"lets one non-matching task slip through" },
  tags:      { arm:{type:'roll'}, feature:"tags",      label:"Tags",          desc:"adds a random tag instead of the next one" },
  priority:  { arm:{type:'roll'}, feature:"priority",  label:"Priority levels", desc:"skips a level when cycling" },
  duedates:  { arm:{type:'roll'}, feature:"duedates",  label:"Due dates",     desc:"can't land on 'Today' anymore" },
  notes:     { arm:{type:'roll'}, feature:"notes",     label:"Task notes",    desc:"truncates the note to 8 characters" },
  assignees: { arm:{type:'roll'}, feature:"assignees", label:"Assignees",     desc:"assigns the wrong person" },
  subtasks:  { arm:{type:'roll'}, feature:"subtasks",  label:"Sub-tasks",     desc:"checking a sub-task marks the parent done" },
  delnested: { arm:{type:'roll'}, feature:"delnested", label:"Delete nested", desc:"deletes a different nested item" },
  dnd:       { arm:{type:'roll'}, feature:"dnd",       label:"Drag & drop",   desc:"drops one position past the target" },
};
```

**Step 2: Replace the helper block at lines 359-364** (`bugDef`/`armed`/`armedBugs`/`bugFires`).
Keep `complexity` (line 359-360) as-is. Replace the four helper lines with the new core +
compat shims:

```js
const bug      = (id) => BUGS[id];                                  // single lookup
const armed    = (s, id) => {                                       // pure: threshold|roll
  const b = BUGS[id]; if (!b) return false;
  return b.arm.type === 'roll' ? s.activeBugs.includes(id) : complexity(s) >= b.arm.at;
};
const bugActive = (id) => {                                         // pure GATE (render/compute safe)
  const b = BUGS[id]; if (!b) return false;
  if (state.fixed.includes(id)) return false;                       // closes latent fix-suppression bug
  if (b.feature && !has(b.feature)) return false;
  return armed(state, id);
};
const wouldFire = (id) => {                                         // pure: armed+fires, NO side effect
  const b = BUGS[id]; if (!b) return false;
  return bugActive(id) && (b.fires ? b.fires(state) : true);
};
const bugHits   = (id) => { const w = wouldFire(id); if (w) triggerBug(id); return w; }; // ACTION layer: auto-felt
const armedBugs = (s) => Object.keys(BUGS).filter(id => armed(s, id));
```

> `triggerBug` is defined later in the file (hoisting via `function triggerBug` declaration —
> verify it remains a `function` declaration, not a `const`, so `bugHits` can reference it).
> It currently is `function triggerBug(id)` at ~line 860 — OK.

**Step 3: Replace the `FEATURE_BUGS` block (lines 466-487)** with `bugChance` + new
`rollBugs` + temporary shims so un-migrated call sites still run:

```js
const bugChance = () => Math.min(0.9, complexity(state) * 0.05);   // rises with every feature added
function rollBugs() {                                              // only roll-type bugs whose feature is present
  const c = bugChance();
  Object.keys(BUGS).forEach(id => {
    const b = BUGS[id];
    if (b.arm.type !== 'roll') return;
    if (b.feature && !has(b.feature)) return;
    if (!state.activeBugs.includes(id) && Math.random() < c) state.activeBugs.push(id);
  });
}
// ── TEMPORARY compat shims (removed in the final task) ──
const featBugOn    = (id) => bugActive(id);                        // was: FEATURE_BUGS check
const FEATURE_BUGS = Object.fromEntries(                           // derived, for un-migrated inspector code
  Object.entries(BUGS).filter(([,b]) => b.feature).map(([id,b]) => [id, b.desc]));
const bugDef       = (id) => BUGS[id];                             // old name
const bugFires     = (_s, id) => wouldFire(id);                    // old (s,id) signature, pure
```

> `needsMet` (line 460) and `featReq` (line 479) are unrelated to bugs — leave `needsMet`;
> check `featReq` usages with `grep -n "featReq" index.html`. If unused, delete it in this step.

**Step 4: Verify the file still loads and regression is green**

```bash
cd /Users/ian.hogers/clank-lit
node playthrough.cjs            # expect 13 ✓, ERRORS (0)
node -e "require('fs').readFileSync('index.html')"  # sanity: file readable
```
Expected: 13/13, 0 errors (shims preserve old behavior). The acceptance probe may now get
past the ReferenceError but still FAIL on `felt` (handlers not yet migrated) — that's correct.

**Step 5: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): unified BUGS registry + helpers (compat shims keep callers green)"
```

---

## Task 3: Migrate the 3 core firing sites to `bugHits`

**Files:**
- Modify: `index.html` — `applyGhost` (~879), `toggleTodo` (~882-884), `delTodo` (~889)

**Step 1: Replace the core fire+trigger pairs.** Each currently reads `bugFires(state, ID)`
then separately calls `triggerBug(ID)`. Collapse to one `bugHits(ID)` (which triggers felt):

```js
// applyGhost (~879):
function applyGhost() {                         // ghost: with 7+ items, adding silently drops the oldest
  if (bugHits("ghost") && state.todos.length > 1) { state.todos.shift(); }
}
// toggleTodo (~882):
function toggleTodo(id) {
  if (bugHits("checkoff")) {                     // checks the LAST task instead of the one clicked
    const last = state.todos[state.todos.length - 1]; if (last) last.done = !last.done;
    renderTodos(); return;
  }
  const t = state.todos.find(x => x.id === id); if (t) t.done = !t.done; renderTodos();
}
// delTodo (~889):
function delTodo(id) {                          // delete: with >3 items, always removes the bottom one
  if (bugHits("delete")) { state.todos.pop(); }
  else state.todos = state.todos.filter(x => x.id !== id);
  renderTodos();
}
```

> Note `applyGhost`'s fire condition `s.todos.length>=7` lives in `BUGS.ghost.fires`; the extra
> `&& state.todos.length > 1` guard is the *effect* precondition (need an item to shift) — keep it.

**Step 2: Run regression**

```bash
node playthrough.cjs   # expect 13 ✓, 0 errors — core bugs behave identically
```

**Step 3: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): core bug firing via bugHits"
```

---

## Task 4: Migrate value-swap feature-bug handlers to `bugHits`

**Files:**
- Modify: `index.html` — `dnd` reorder (~616), `editNote` (~626), `cycAsg` (~629), `toggleSub` (~632), `delSub` (~633), `tagAdd` (~903), `cycPrio` (~916), `cycDue` (~919)

These are the user-action handlers. Swap `featBugOn(id)` → `bugHits(id)` so each registers
"felt" when the buggy branch runs. (Effect code unchanged.)

**Step 1: Edit each site** (replace `featBugOn("x")` with `bugHits("x")`):

```js
// ~616 (drag reorder):  if (bugHits("dnd")) ti = Math.min(ts.length, ti + 1);
// ~626 editNote:        t.note = bugHits("notes") ? v.slice(0,8) : v;
// ~629 cycAsg:          ...(bugHits("assignees")?2:1))%o.length];
// ~632 toggleSub:       if (bugHits("subtasks")) p.done = true;
// ~633 delSub:          p.children = bugHits("delnested") ? (p.children||[]).slice(1) : (p.children||[]).filter(x=>x.id!==cid);
// ~903 tagAdd:          const lbl = (bugHits("tags") ? pick(avail) : avail[0]).label;
// ~916 cycPrio:         t.priority = ((t.priority||0) + (bugHits("priority")?2:1)) % 4;
// ~919 cycDue:          const opts = bugHits("duedates") ? [null,"Tomorrow","Next week"] : [null,"Today","Tomorrow","Next week"];
```

> `bugHits` calls `triggerBug` only when the buggy branch is taken — so feeling is tied to the
> action, exactly once per action, never during render.

**Step 2: Run regression + acceptance probe**

```bash
node playthrough.cjs     # 13 ✓, 0 errors
node unify-check.cjs      # 'felt' should now be TRUE; 'fixedSuppresses' TRUE; may still FAIL on receipt (Task 6)
```

**Step 3: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): feature-bug handlers feel via bugHits"
```

---

## Task 5: Migrate render-compute bugs (search/sort/filter) — pure gate + handler felt

**Files:**
- Modify: `index.html` — `visibleTodos` (493, 497, 504)
- Modify: the search input handler, `cycSort` (~631), `cycFilter` (~632) — locate with `grep -n "cycSort\|cycFilter\|state.q =\|oninput" index.html`

**Step 1: In `visibleTodos`, swap `featBugOn` → `bugActive`** (pure — computing the degraded
list must not mark felt):

```js
if (bugActive("search")) q = (q.trim().split(/\s+/)[0] || "");          // 493
const slip = bugActive("filtering") ? ts[0] : null;                      // 497
if (bugActive("sorting") && ts.length) { const head = ts[0]; ts = [head, ...ts.slice(1).sort(cmp)]; } // 504
```

**Step 2: Register "felt" in the action handlers** (the user *acting* is what's felt). Add a
`bugHits` call where the user changes each control, guarded so it only fires when the bug
would actually manifest:

```js
// search input handler (where state.q is set): after setting state.q —
if (state.q) bugHits("search");
// cycSort: after computing new state.sortBy —
if (state.sortBy !== "manual") bugHits("sorting");
// cycFilter: after computing new state.filterTag —
if (state.filterTag) bugHits("filtering");
```

> `bugHits` internally checks `bugActive` + fire condition, so these are safe no-ops when the
> bug isn't active. They run in handlers (not render), so felt is registered once per action.

**Step 3: Run regression + targeted probe**

```bash
node playthrough.cjs   # 13 ✓ (search-filters-everything-out assertion still holds), 0 errors
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): search/sort/filter use pure gate + handler-level feel"
```

---

## Task 6: Migrate the inspector to one unified bug section

**Files:**
- Modify: `index.html:748-766` (`renderDebug` bug rendering)

**Step 1: Replace the two bug sections (core `BUGS.map` at 748-752 and the `FEATURE_BUGS`
block at 762-766) with ONE section** iterating `Object.entries(BUGS)`, using pure `armed`/
`wouldFire`/`bugActive` (no side effects in render):

```js
const bugs = Object.entries(BUGS).map(([id, b]) => {
  const armd = armed(state, id), firing = wouldFire(id);
  const felt = state.experienced.includes(id), fixd = state.fixed.includes(id);
  const gated = b.feature && !has(b.feature);
  const armWhen = b.arm.type === 'roll' ? `roll · ${b.feature}` : `at${b.arm.at}`;
  const tags = [armd?"armed":"", firing?"FIRING":"", felt?"felt":"", fixd?"fixed":"", gated?"(feature off)":""]
    .filter(Boolean).join(" · ");
  return `<div class="${fixd?"g":firing?"r":armd?"y":"d"}">${b.label}
    <span class="dim">${armWhen}${b.fires?" · conditional":""}</span><br>&nbsp;&nbsp;${tags||"dormant"}</div>`;
}).join("");
```

**Step 2: Update the `el.innerHTML` template** — replace the two `<div class="dsec">BUGS</div>…`
and `<div class="dsec">FEATURE BUGS …</div>…` blocks (lines 761-766) with a single:

```js
    <div class="dsec">BUGS (roll chance ${Math.round(bugChance()*100)}% on add)</div>${bugs}
```

**Step 3: Run + visually confirm inspector**

```bash
node playthrough.cjs   # 13 ✓ incl. "inspector visible", 0 errors
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): single unified bug section in inspector"
```

---

## Task 7: Migrate the receipt + remaining `bugDef`/`armed(obj)` callers

**Files:**
- Modify: `index.html:963-974` (`receiptHtml`)
- Modify: `index.html:993` (`noticeUtterance` uses `bugDef(id).desc`)

**Step 1: `receiptHtml` — iterate `Object.entries(BUGS)` and call `armed(state, id)`:**

```js
const rows = Object.entries(BUGS).map(([id, b]) => {
  const fixedOk = state.fixed.includes(id);
  const broke   = armed(state, id) && !fixedOk && (!b.feature || has(b.feature));
  const felt    = state.experienced.includes(id);
  let note, said;
  if (fixedOk)    { note = " — you actually fixed it"; said = "AI said ✅"; }
  else if (broke) { note = felt ? " — broke (you noticed)" : " — broke silently"; said = "AI said ✅"; }
  else            { note = " — fine"; said = "—"; }
  return `<div class="row"><span style="${fixedOk?"color:var(--accent)":""}" class="${broke?"broke":""}">${b.label}${note}</span><span class="said">${said}</span></div>`;
}).join("");
const broken = Object.keys(BUGS).filter(id => armed(state, id) && !state.fixed.includes(id)
  && (!BUGS[id].feature || has(BUGS[id].feature))).length;
```

**Step 2: `noticeUtterance` (line 993)** — `bugDef(id)` already shimmed to `BUGS[id]`; once
shims are removed (Task 8) it must use `bug(id)`. Change now to `bug(id).desc`:

```js
const pool = state.experienced.map(id => bug(id).desc);
```

**Step 3: Run regression + acceptance probe (now expect PASS)**

```bash
node playthrough.cjs   # 13 ✓, 0 errors
node unify-check.cjs    # ACCEPTANCE PASS ✅  (truncated, felt, fixedSuppresses, receiptHasFeatureBug)
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): receipt + notice iterate unified registry; feature bugs now reportable/fixable"
```

---

## Task 8: Remove the compat shims; final full verification

**Files:**
- Modify: `index.html` — delete the shim block added in Task 2 Step 3
  (`featBugOn`, `FEATURE_BUGS`, `bugDef`, `bugFires`)

**Step 1: Confirm no remaining callers of the shims**

```bash
cd /Users/ian.hogers/clank-lit
grep -n "featBugOn\|FEATURE_BUGS\|bugDef\|bugFires(" index.html
```
Expected: only the shim *definitions* themselves. If any call sites remain, migrate them
(`featBugOn`→`bugActive` in render / `bugHits` in actions; `bugDef`→`bug`; `bugFires(s,id)`→
`wouldFire(id)`) before deleting.

**Step 2: Delete the four shim lines.**

**Step 3: Full verification suite**

```bash
node playthrough.cjs    # 13 ✓, ERRORS (0)
node unify-check.cjs     # ACCEPTANCE PASS ✅
```

Also re-run the give-up ending e2e (from the prior session) to confirm the ending still
reaches `revealed` — recreate it if not saved:
- Set `state.phase='building'`, features with cx≥3, `state.complaints=3`; click "I give up" ×3
  (polling until idle); assert `state.phase==='revealed'` and receipt rendered, 0 page errors.

**Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(clank-lit): drop compat shims — bug system fully unified"
```

---

## Task 9: Update the design doc's Open Questions + sync to live (gated on approval)

**Files:**
- Modify: `docs/plans/2026-06-02-unify-bug-systems-design.md` (resolve the
  "fixed bugs re-arm?" open question with the implemented decision: `fixed` is terminal)

**Step 1:** Note in the design doc that feature bugs, once fixed, do not re-arm (matches core).

**Step 2: Commit the doc.**

**Step 3 (DO NOT auto-run — ask first):** Per the no-auto-deploy rule, ask the user
"Deploy now?" before syncing `index.html` to `~/clank-lit` and pushing. Only on explicit
approval: `cp index.html ~/clank-lit/index.html`, commit, `git push origin main`, then verify
the live site with a headless run of `unify-check.cjs` against `https://saintpepsi.github.io/clank-lit/`.

---

## Risk notes

- **`triggerBug` hoisting:** `bugHits` (defined ~line 365) references `triggerBug` (defined
  ~line 860). Works because `triggerBug` is a `function` declaration (hoisted). If it is ever
  converted to `const`, `bugHits` breaks — keep it a function declaration.
- **`activeBugs` persistence:** unchanged; `rollBugs` still pushes ids into `state.activeBugs`.
  No new persisted fields, so old saves load cleanly via `Object.assign`.
- **Object iteration order:** define core bugs first in `BUGS` so inspector/receipt display
  order matches the previous array order.
- **Cold-open timer:** headless probes must `sleep(1700)` after `reload()` before seizing
  `state` (a 1400ms boot timer sets `phase='onboarding'`), per the prior session's finding.
```
