# To-do List

A fast, offline to-do list with sub-tasks, priorities, due dates, drag-and-drop
reordering and keyboard shortcuts.

* **Zero dependencies** — plain HTML, CSS and classic (non-module) JavaScript.
* **No build step** — open `index.html` and it runs.
* **No network** — everything lives in `localStorage` on the user's machine.
* **No `innerHTML`** — all rendering goes through a small `el()` builder, so task
  text can never inject markup.

## Quick start

Double-click `index.html`, or serve the folder if you prefer a real origin:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

The app works from `file://` too: `js/*.js` are classic scripts (no ES modules),
so no server or bundler is required. If a browser blocks storage on `file://`,
the app still runs for the session and shows a one-off warning toast.

## Features

**Tasks**

* Add a task with a title, priority (none/low/medium/high) and optional due date.
* Tick the round checkbox to complete; ticking again reopens it.
* Inline rename: the pencil button or a double-click on the title. `Enter` saves,
  `Esc` cancels, clicking away commits.
* Reorder by dragging the grip handle (manual sort) or with `Alt` + `↑` / `↓`,
  plus per-task "To top" / "To bottom" shortcuts in the task actions.
* Delete with an undo toast, or expand a task for notes, priority, due date and
  sub-tasks.

**Sub-tasks**

* Add, rename, tick and delete sub-tasks inside an expanded task.
* Completing a parent completes every sub-task under it.
* Completing *all* sub-tasks completes the parent automatically; a partly
  finished parent shows a mixed checkbox state and stays open.

**Finding work**

* Live search over task titles, sub-task titles and notes.
* Filters: All / Active / Done, each with a live count.
* Sort: manual order, due date, priority, title A–Z, newest first.
* Summary line ("2 tasks left · 1 done · 1/4 sub-tasks") and a progress bar.

**Bulk actions & data**

* Mark all done, Clear done and Delete everything — each reversible from the
  undo toast for 6 seconds.
* Theme button cycles light → dark → auto (follows the OS setting).
* Export every task to a JSON file; import merges a JSON file back in.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `N` or `+` | Focus the new-task field |
| `/` | Focus search |
| `?` | Toggle the shortcut help |
| `Enter` | Save a rename, add a task or add a sub-task |
| `Esc` | Cancel a rename, leave a field or clear the search |
| `Alt` + `↑` / `↓` | Move the focused task up or down |
| Double-click a title | Start editing it |

## Data, backup and privacy

Everything is stored in the browser's `localStorage` under three keys:

| Key | Contents |
| --- | --- |
| `todo.list.v1` | The task list (tasks, sub-tasks, notes, priorities, due dates, order) |
| `todo.prefs.v1` | Theme, active filter and sort order |
| `todo.seeded.v1` | Flag that the demo list has already been offered once |

Corrupt or hand-edited values are ignored instead of breaking the boot, and the
demo list is only seeded on a first run that has no stored data.

**Export** writes a portable snapshot:

```json
{
  "app": "todo-list",
  "version": 1,
  "exportedAt": "2026-01-31T09:15:00.000Z",
  "tasks": [ { "id": "t1", "title": "Plan the week ahead", "subtasks": [] } ]
}
```

**Import** reads that shape back and *merges* it: new ids are added at the top of
the list, ids that already exist are skipped, and anything that is not a valid
snapshot is rejected with an explanatory toast. Nothing is ever sent anywhere —
there is no analytics, no fetch and no third-party asset.

## Project layout

```
index.html          markup for the whole app (toolbar, add bar, list, footer)
css/styles.css      theming via CSS variables, light + dark, responsive layout
js/store.js         state, persistence, ordering, summary  -> window.TodoStore
js/ui.js            DOM builder, rendering, toasts, focus  -> window.TodoUI
js/app.js           event wiring, shortcuts, import/export -> boots the app
tests/store.test.js logic tests for the store (Node, no dependencies)
tests/e2e.html      in-browser end-to-end run that drives the real app
```

`store.js` never touches the DOM and `ui.js` never mutates state, so the store is
testable in Node and the UI is a pure function of state. `app.js` is the only
place that connects the two: it subscribes to store events and calls `UI.render()`.

## Tests

**Logic tests** (22 assertions, no dependencies — the store is loaded into a
sandboxed VM context with a fake `localStorage`):

```sh
node tests/store.test.js
# -> 22 passed, 0 failed
```

**End-to-end tests** — `tests/e2e.html` loads the real `index.html` in an iframe
and drives it with synthetic DOM events (clicks, keystrokes, drag events), then
prints a `PASS`/`FAIL` line per step and a final `E2E: N passed, M failed`
summary into `#log`. Open the file in a browser to watch it run, or read the
result headlessly:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --allow-file-access-from-files \
  --user-data-dir=/tmp/chrome-todo-profile --virtual-time-budget=20000 \
  --dump-dom "file://$PWD/tests/e2e.html" > /tmp/e2e-dom.html

grep -o 'E2E: [0-9]* passed, [0-9]* failed' /tmp/e2e-dom.html
# -> E2E: 62 passed, 0 failed
```

The e2e run covers boot/rendering, add, rename, delete + undo, completion,
parent/sub-task cascades, sub-task editing, search, filters, every sort option,
mark-all, clear-done, drag-and-drop reordering, global shortcuts, the theme
cycle and localStorage persistence. `--allow-file-access-from-files` is required
so the harness can reach the `file://` iframe's document.

## Browser support

Any current Chrome, Edge, Safari or Firefox: the app uses `localStorage`, CSS
custom properties, `hidden`, `closest()`, drag events and `FileReader` — no
transpiling and no polyfills. Accessibility is built in: real buttons, labelled
inputs, `role="progressbar"`, `aria-live` for the summary and toasts, visible
focus rings and full keyboard reachability.

