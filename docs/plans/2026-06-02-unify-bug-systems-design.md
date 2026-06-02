# Unify Bug Systems — Design

**Date:** 2026-06-02
**Project:** Clank-lit (`index.html`, single self-contained HTML game)

## Problem

Clank-lit has **two parallel bug systems** that don't share an interface:

1. **Core `BUGS`** (array of 3: `delete`, `checkoff`, `ghost`) — armed by a complexity
   threshold (`at`), manifest on a `fires(s)` condition, and are fully wired into the
   felt → notice → `runInvestigation` → `markFixed` loop. These are reportable and fixable.
2. **`FEATURE_BUGS`** (map of 11: search, sorting, filtering, tags, priority, duedates,
   notes, assignees, subtasks, delnested, dnd) — armed by a probabilistic activation roll
   (`rollBugs` / `state.activeBugs`, chance rises with complexity), and hand-wired into
   handlers as inline `featBugOn("x") ? buggy : clean` ternaries. They **only degrade
   silently** — they cannot be felt, reported, investigated, or fixed.

Consequences:

- **Adding a feature-with-bug touches ~5 disjoint spots:** the `FEATURES` row, the
  `FEATURE_BUGS` description, a handler ternary, render wiring, and it *still* won't join
  the fix loop.
- **Three principle smells:** Data-Drives-Behavior (feature-bug arming/lifecycle is split
  across code paths), Single-Source-of-Truth (a bug is described in 3+ places), and
  Unify-Shared-Interfaces (two bug models, only one fixable).
- **A latent bug:** `featBugOn(id)` never checks `state.fixed`, so even if a feature bug
  *could* be "fixed", fixing it would not suppress it.

## Constraints

- **Single self-contained HTML file, no build, no backend.** This is the defining product
  constraint and overrides the File-Organization principle (no splitting into modules).
- Preserve the existing *feel*: early core bugs (delete/checkoff/ghost) reliably appear for
  the trial-and-error teaching beats; feature bugs stay emergent/probabilistic so each
  playthrough degrades differently.
- Keep effects readable: positional/contextual effects (sort-keeps-top, filter-slips-one,
  dnd-lands-one-past) must not be forced into a generic shape.
- Persisted state is `Object.assign(state, JSON.parse(save))`; new state fields must default
  cleanly for old saves. (No new persisted fields are required by this design.)

## Approaches Considered

1. **Single registry, unified lifecycle, inline effects (CHOSEN).** Merge both structures
   into one `BUGS` object keyed by id. Each entry carries its arm strategy (discriminated:
   `threshold` | `roll`), an optional `fires(s)` predicate, a feature link, label, and desc.
   Effects stay inline at the call site but go through one gate helper. *Honors* Unify-Shared-
   Interfaces, Single-Source-of-Truth, Data-Drives-Behavior; respects "When This Doesn't
   Apply" for genuinely contextual effects (Data-Drives-Behavior). Low risk, mechanical migration.

2. **Keep two structures + adapter layer.** Leave `BUGS` and `FEATURE_BUGS` as-is; add an
   `allBugs()` normalizer the loop reads through. *Rejected:* still two sources of truth
   (the exact thing we're fixing), the adapter is glue that drifts, and adding a feature
   still means editing two places. Does not make feature work easier.

3. **Unified registry + data-driven effects.** Like (1) but move each bug's transform into
   the registry as a pure `apply(ctx)` function. *Rejected:* forces positional effects
   (sort/filter/dnd) into one `(input) -> output` signature — false sharing — for marginal
   gain over (1). The user explicitly scoped to unifying the *lifecycle*, not the effects.

## Chosen Approach

**Approach 1.** One `BUGS` registry; unified arm/fire/feel/report/fix lifecycle for every
bug; effects remain inline but flow through a single pure gate (`bugActive`) plus an
action-layer helper (`bugHits`) that auto-registers "felt".

## Architecture

### Data Model — one registry, one shape

```js
// arm: when the bug becomes CAPABLE of firing.  fires: does it manifest THIS interaction.
const BUGS = {
  // core gameplay bugs — guaranteed at a complexity threshold, fire on a list condition
  delete:   { arm:{type:'threshold', at:2}, fires:s=>s.todos.length>3,  label:"Deleting a task",
              desc:"deleting a task removed the bottom one instead?" },
  checkoff: { arm:{type:'threshold', at:3}, fires:s=>s.todos.length>5,  label:"Checking off tasks",
              desc:"ticking a box ticks a different task?" },
  ghost:    { arm:{type:'threshold', at:4}, fires:s=>s.todos.length>=7, label:"Adding a task",
              desc:"a task vanishes whenever I add a new one?" },

  // feature bugs — emergent (rolled, chance rises with complexity), fire whenever the action runs
  search:    { arm:{type:'roll'}, feature:"search",    label:"Search",      desc:"matches only the first word of your query" },
  sorting:   { arm:{type:'roll'}, feature:"sorting",   label:"Sorting",     desc:"sorts everything except the top item" },
  filtering: { arm:{type:'roll'}, feature:"filtering", label:"Filtering",   desc:"lets one non-matching task slip through" },
  tags:      { arm:{type:'roll'}, feature:"tags",      label:"Tags",        desc:"adds a random tag instead of the next one" },
  priority:  { arm:{type:'roll'}, feature:"priority",  label:"Priority",    desc:"skips a level when cycling" },
  duedates:  { arm:{type:'roll'}, feature:"duedates",  label:"Due dates",   desc:"can't land on 'Today' anymore" },
  notes:     { arm:{type:'roll'}, feature:"notes",     label:"Task notes",  desc:"truncates the note to 8 characters" },
  assignees: { arm:{type:'roll'}, feature:"assignees", label:"Assignees",   desc:"assigns the wrong person" },
  subtasks:  { arm:{type:'roll'}, feature:"subtasks",  label:"Sub-tasks",   desc:"checking a sub-task marks the parent done" },
  delnested: { arm:{type:'roll'}, feature:"delnested", label:"Delete nested", desc:"deletes a different nested item" },
  dnd:       { arm:{type:'roll'}, feature:"dnd",       label:"Drag & drop", desc:"drops one position past the target" },
};
```

Notes:
- A bug with no `feature` is core (no feature-presence requirement).
- A bug with no `fires` defaults to "fires whenever its action runs while active".
- The tag-alignment bug (currently a separate per-tag `tagAlignChance` roll stored in
  `t.badTags`) is **out of scope** for this unification — it is a per-instance visual roll,
  not a feature-level flag. Left as-is; noted in Open Questions.

### Helper API (the ergonomics layer)

```js
const bug    = id => BUGS[id];
const armed  = (s, id) => {                      // pure
  const b = BUGS[id]; if (!b) return false;
  return b.arm.type === 'roll'
    ? s.activeBugs.includes(id)
    : complexity(s) >= b.arm.at;
};
const bugActive = id => {                         // pure GATE — safe in render/compute
  const b = BUGS[id]; if (!b) return false;
  if (state.fixed.includes(id)) return false;     // <-- closes the latent fix-suppression bug
  if (b.feature && !has(b.feature)) return false;
  return armed(state, id);
};
const bugHits = id => {                           // ACTION layer — auto-registers "felt"
  const b = BUGS[id];
  const will = bugActive(id) && (b.fires ? b.fires(state) : true);
  if (will) triggerBug(id);
  return will;
};
function rollBugs() {                             // only roll-type bugs whose feature is present
  const c = bugChance();
  Object.keys(BUGS).forEach(id => {
    const b = BUGS[id];
    if (b.arm.type !== 'roll') return;
    if (b.feature && !has(b.feature)) return;
    if (!state.activeBugs.includes(id) && Math.random() < c) state.activeBugs.push(id);
  });
}
```

### Data Flow — gate vs. hits (the key separation)

- **Render / compute paths** (`visibleTodos` search-sort-filter, inspector, `receiptHtml`):
  use **`bugActive(id)`** — pure, no side effects. Rendering the degraded output must not
  mark a bug "felt"; viewing is not acting.
- **User-action handlers** (toggleTodo, delTodo, applyGhost, tagAdd, cycPrio, cycDue,
  editNote, cycAsg, toggleSub, delSub, dnd reorder, and the search/sort/filter *handlers*):
  use **`bugHits(id)`** — registers "felt" when the buggy branch actually runs, feeding the
  notice → investigate → fix loop.

Value-swap effects read `bugHits(id) ? buggy : clean`. Search/sort/filter compute their
effect in `visibleTodos` via `bugActive`, and register felt in their input/cycle handlers
via `bugHits` (so the bug is felt when the user searches/sorts/filters, not on every render).

## Adding a New Bug (Recipe)

The payoff: adding a bug is **1 data entry + 1 inline guard**. Everything else is automatic.

**Step 1 — Add one registry entry** (the single source of truth):

```js
// feature bug (emergent — only after that feature is added; chance rises with complexity)
duplicate: { arm:{type:'roll'}, feature:"recurring",
             label:"Recurring tasks", desc:"creates two copies instead of one" },

// OR core bug (guaranteed once complexity hits `at`; optional fire condition)
phantom:   { arm:{type:'threshold', at:5}, fires:s=>s.todos.length>10,
             label:"Saving", desc:"edits don't stick after a reload?" },
```

Three data decisions: **arm** (`roll` = feature-scoped + probabilistic, or `threshold` =
guaranteed at complexity `at`), optional **`fires(s)`** (omit = fires whenever its action
runs), and the **`feature`** link if feature-scoped.

**Step 2 — Guard the effect at the action site** with one helper call:

```js
// value-swap effect (most bugs):
function doRecurring(id){
  const copies = bugHits("duplicate") ? 2 : 1;   // buggy branch + auto-registers "felt"
  ...
}

// render-computed effect (search/sort/filter style):
//   visibleTodos():  if (bugActive("duplicate")) …   ← pure gate, no side effect
//   the handler:     bugHits("duplicate")            ← marks felt when the user acts
```

**Wired automatically** (no extra code) because everything consults the registry:

| Concern | Handled by |
| --- | --- |
| Arming (roll or threshold) | `armed` / `rollBugs` |
| Feeling it (enters `experienced`) | `bugHits` |
| Reportable via "I've noticed an issue" | existing notice loop |
| Investigate-and-fix | `runInvestigation` / `markFixed` |
| Fix actually suppresses it | `bugActive`'s `fixed` check |
| Appears in the receipt + inspector | both iterate `Object.values(BUGS)` |

**What is NOT automated:** the *effect itself*. The buggy behaviour is inherently bespoke —
you write "what breaks" and pick the handler that feels it. This is deliberate (inline
effects over a forced one-size signature). The refactor removes everything *except* that one
creative decision.

## Error Handling

- Unknown bug id → all helpers return `false` (no throw); a missing registry entry simply
  means "no bug here".
- A feature bug whose feature was never added can never be armed (`bugActive` feature guard)
  and is never rolled (`rollBugs` feature guard).
- `runInvestigation` already targets `state.experienced[last]`; with feature bugs now able
  to enter `experienced`, no change is needed — it naturally fixes whatever was most recently
  felt. `markFixed` removes from `experienced` and adds to `fixed`; `bugActive`'s `fixed`
  check then suppresses it everywhere (render and action).

## Testing Strategy

- **Unit (pure):** `armed` (threshold vs. roll), `bugActive` (fixed-guard, feature-guard),
  `rollBugs` (only rolls roll-type present-feature bugs; chance rises with complexity).
- **Integration (headless, existing harness):**
  - Drive a feature bug active → perform its action → assert it manifests AND becomes
    `experienced`.
  - Report it (notice) → `runInvestigation` success → assert it lands in `fixed` and then
    **stops manifesting** (the latent-bug regression).
  - Assert `receiptHtml` now lists feature bugs in the truth table.
- **Regression:** the full 13-assertion playthrough must still pass; the give-up ending
  e2e must still reach `revealed`.

## Principles Applied

- **Unify Shared Interfaces** — one bug interface; the felt/report/investigate/fix loop and
  rendering operate on any bug regardless of origin.
- **Single Source of Truth** — each bug has exactly one home (`BUGS[id]`); label, desc, arm,
  fire, and feature link live together.
- **Data Drives Behavior** — arm strategy and fire condition are data; adding a bug is adding
  a registry row, not new code branches.
- **Separation of Concerns** — pure gate (`bugActive`) for compute/render, action helper
  (`bugHits`) for felt-registration, effect stays at the call site where its context lives.
- **Pure Functions for Testability** — `armed` / `bugActive` are pure predicates over state.
- **Deviations:** **File Organization** ("split >300-line files") is explicitly overridden by
  the single-self-contained-HTML product constraint — we section internally instead.
  **Data-Drives-Behavior for effects** is deliberately *not* taken to its limit (effects stay
  inline) under "When This Doesn't Apply: genuinely unique / positional behavior" — forcing
  sort/filter/dnd into one transform signature would be false sharing.

## Resolved (implemented)

- **Fixed bugs are terminal — confirmed.** A fixed bug never re-arms: `bugActive(id)`
  short-circuits on `state.fixed.includes(id)`, and `rollBugs` never clears `fixed`. This
  matches core-bug behavior and applies uniformly to feature bugs now.
- **Feature bugs are fully in the lifecycle.** As shipped, a feature bug is armed by
  `rollBugs`, felt via `bugHits` in its action handler, reported through `noticeUtterance`,
  fixed by `runInvestigation`/`markFixed`, suppressed by `bugActive`'s `fixed` guard, and
  listed in both the inspector (`renderDebug`) and the receipt (`receiptHtml`).

## Open Questions

- **Tag-alignment bug** (`tagAlignChance` / `t.badTags`): keep as a separate per-instance
  visual roll (current behavior), or eventually express it as a registry bug with a
  per-tag activation? Left out of this pass to avoid scope creep — still the one bug not
  on the unified registry.
