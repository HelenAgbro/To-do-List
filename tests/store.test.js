/* ============================================================
   tests/store.test.js — logic tests for js/store.js.
   Run with:  node tests/store.test.js
   No dependencies: the store is loaded into a sandboxed context
   with a fake localStorage, so it can be exercised outside a browser.
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var STORE_PATH = path.join(__dirname, '..', 'js', 'store.js');
var STORE_SOURCE = fs.readFileSync(STORE_PATH, 'utf8');

/* ---------------- tiny test runner ---------------- */

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed++;
    console.log('  \u2717 ' + name + '\n      ' + err.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  if (a !== b) throw new Error((message || 'values differ') + ' — got ' + a + ', expected ' + b);
}

/* ---------------- sandbox helper ---------------- */

function fakeStorage(seed) {
  var map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: function (key) { return map.has(key) ? map.get(key) : null; },
    setItem: function (key, value) { map.set(key, String(value)); },
    removeItem: function (key) { map.delete(key); },
    clear: function () { map.clear(); },
    get length() { return map.size; },
    _dump: function () { return Object.fromEntries(map); }
  };
}

/** Load a fresh copy of store.js with an in-memory localStorage. */
function newStore(seed) {
  var storage = fakeStorage(seed);
  var sandbox = { localStorage: storage, console: console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STORE_SOURCE, sandbox, { filename: 'store.js' });
  sandbox.TodoStore.fakeStorage = storage;
  return sandbox.TodoStore;
}

function isoDay(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + offsetDays);
  var m = String(d.getMonth() + 1);
  var day = String(d.getDate());
  return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
}

function titles(store) {
  return store.state.tasks.map(function (t) { return t.title; });
}

/** Titles in the order the user actually sees them (filter + sort applied). */
function visibleTitles(store) {
  return store.visibleTasks().map(function (t) { return t.title; });
}

/* ============================================================
   tests
   ============================================================ */

console.log('\nstore.js');

test('first run seeds a demo list with sub-tasks', function () {
  var store = newStore();
  store.init();
  assertEqual(store.state.tasks.length, 3, 'demo task count');
  assertEqual(store.state.tasks[0].subtasks.length, 2, 'demo sub-task count');
  assert(store.state.tasks[0].expanded === true, 'first demo task starts expanded');
  assertEqual(store.state.tasks[0].tags, ['Personal'], 'demo task carries a tag');
});

test('second run loads from storage instead of re-seeding', function () {
  var first = newStore();
  first.init();
  first.addTask({ title: 'Persisted task' });
  var before = titles(first);
  var dump = first.fakeStorage._dump();

  var second = newStore(dump);
  second.init();
  assertEqual(titles(second), before, 'reloaded titles');
  assertEqual(second.state.tasks.length, 4, 'reloaded task count');
});

test('addTask trims input, ignores blank titles and prepends', function () {
  var store = newStore();
  store.init();
  store.wipe();
  assert(store.addTask({ title: '   ' }) === null, 'blank title rejected');
  var task = store.addTask({ title: '  Buy   milk  ', priority: 'high', dueDate: isoDay(1) });
  assertEqual(task.title, 'Buy milk', 'whitespace collapsed');
  assertEqual(task.priority, 'high', 'priority kept');
  assertEqual(store.state.tasks.length, 1, 'one task stored');
  store.addTask({ title: 'Second' });
  assertEqual(titles(store), ['Second', 'Buy milk'], 'newest task first');
});

test('updateTask patches fields and rejects bad values', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Original' });
  store.updateTask(task.id, { title: 'Renamed', notes: 'Line 1\nLine 2 ', priority: 'urgent', dueDate: 'nope' });
  assertEqual(task.title, 'Renamed', 'title updated');
  assertEqual(task.notes, 'Line 1\nLine 2', 'notes trimmed, newline kept');
  assertEqual(task.priority, 'none', 'unknown priority falls back to none');
  assertEqual(task.dueDate, null, 'invalid date cleared');

  store.updateTask(task.id, { title: '   ' });
  assertEqual(task.title, 'Renamed', 'blank rename keeps the old title');

  store.updateTask(task.id, { dueDate: isoDay(3), expanded: true });
  assertEqual(task.dueDate, isoDay(3), 'valid date stored');
  assert(task.expanded === true, 'expanded flag stored');
});

test('tags are normalised, deduplicated and searchable', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Groceries', tags: [' Home ', 'home', '', 'Urgent'] });
  assertEqual(task.tags, ['Home', 'Urgent'], 'trimmed, deduplicated, blanks dropped');

  store.updateTask(task.id, { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assertEqual(task.tags.length, store.TAGS_MAX, 'capped at TAGS_MAX');

  store.updateTask(task.id, { tags: ['x'.repeat(40)] });
  assertEqual(task.tags[0].length, 24, 'long tags are truncated');

  store.updateTask(task.id, { tags: ['Receipts'] });
  store.addTask({ title: 'Unrelated' });
  store.setQuery('receipt');
  assertEqual(store.visibleTasks().length, 1, 'tags are searchable');
  store.setQuery('');

  assertEqual(store.counts().tags.map(function (t) { return t.name + ':' + t.total; }),
    ['Receipts:1'], 'tag counts feed the sidebar');
  assertEqual(store.addTask({ title: 'No tags' }).tags, [], 'tasks default to no tags');
});

test('toggling a parent ticks every sub-task too', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Parent' });
  store.addSubtask(task.id, 'One');
  store.addSubtask(task.id, 'Two');

  store.toggleTask(task.id);
  assert(task.completed === true, 'parent completed');
  assert(task.subtasks.every(function (s) { return s.completed; }), 'all sub-tasks completed');

  store.toggleTask(task.id);
  assert(task.completed === false, 'parent reopened');
  assert(task.subtasks.every(function (s) { return !s.completed; }), 'all sub-tasks reopened');
});

test('sub-tasks drive the parent state in both directions', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Parent' });
  var a = store.addSubtask(task.id, 'A');
  var b = store.addSubtask(task.id, 'B');

  store.toggleSubtask(task.id, a.id);
  assert(task.completed === false, 'parent still open with work left');
  assertEqual(store.counts().subtasksDone, 1, 'one sub-task done');

  store.toggleSubtask(task.id, b.id);
  assert(task.completed === true, 'parent completes when the last sub-task is done');

  store.toggleSubtask(task.id, a.id);
  assert(task.completed === false, 'parent reopens when a sub-task is unchecked');

  store.updateSubtask(task.id, b.id, { title: 'B renamed' });
  assertEqual(task.subtasks[1].title, 'B renamed', 'sub-task renamed');
});

test('sub-task validation and deletion with undo', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Parent' });
  assert(store.addSubtask(task.id, '   ') === null, 'blank sub-task rejected');
  var keep = store.addSubtask(task.id, 'Keep me');
  var drop = store.addSubtask(task.id, 'Drop me');

  var removed = store.deleteSubtask(task.id, drop.id);
  assertEqual(removed.index, 1, 'removed index reported');
  assertEqual(task.subtasks.length, 1, 'only one sub-task left');

  store.restoreSubtask(task.id, removed.subtask, removed.index);
  assertEqual(task.subtasks.map(function (s) { return s.title; }), ['Keep me', 'Drop me'], 'restored in place');
  assert(store.deleteSubtask(task.id, 'missing') === null, 'unknown sub-task is a no-op');
});

test('deleteTask reports the index so undo can restore the position', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'A' });
  store.addTask({ title: 'B' });
  store.addTask({ title: 'C' });
  assertEqual(titles(store), ['C', 'B', 'A'], 'setup order');

  var gone = store.deleteTask(store.state.tasks[1].id);
  assertEqual(titles(store), ['C', 'A'], 'middle task removed');
  assert(store.deleteTask('nope') === null, 'unknown id returns null');

  store.restoreTask(gone.task, gone.index);
  assertEqual(titles(store), ['C', 'B', 'A'], 'restored at the old index');
});

test('markAll / restoreAll round-trips every task', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var one = store.addTask({ title: 'One' });
  store.addTask({ title: 'Two' });
  store.addSubtask(one.id, 'Sub');

  assert(store.markAll(true) !== null, 'snapshot returned');
  assert(store.state.tasks.every(function (t) { return t.completed; }), 'tasks completed');
  assert(one.subtasks.every(function (s) { return s.completed; }), 'sub-tasks completed');
  assertEqual(store.counts().completed, 2, 'counted as done');

  store.toggleTask(one.id);
  assert(one.subtasks.every(function (s) { return !s.completed; }), 'unticking cascades down again');

  var empty = newStore();
  empty.init();
  empty.wipe();
  assert(empty.markAll(true) === null, 'no-op on an empty list');
});

test('clearCompleted removes finished work and restores it in order', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'Active one' });
  var done = store.addTask({ title: 'Done one' });
  store.addTask({ title: 'Active two' });
  var alsoDone = store.addTask({ title: 'Done two' });
  store.toggleTask(done.id);
  store.toggleTask(alsoDone.id);
  var before = titles(store);

  var removed = store.clearCompleted();
  assertEqual(titles(store), ['Active two', 'Active one'], 'only active tasks left');

  store.restoreMany(removed);
  assertEqual(titles(store), before, 'undo rebuilds the original order');
  assert(store.restoreMany([]) === null, 'empty restore is a no-op');
});

test('wipe empties the list and never re-seeds on the next visit', function () {
  var store = newStore();
  store.init();
  assertEqual(store.state.tasks.length, 3, 'demo seeded');
  store.wipe();
  assertEqual(store.state.tasks.length, 0, 'everything removed');

  var reloaded = newStore(store.fakeStorage._dump());
  reloaded.init();
  assertEqual(reloaded.state.tasks.length, 0, 'still empty after reload');
});

console.log('\nordering');

test('moveTask nudges tasks up, down and to the ends', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'A' });
  store.addTask({ title: 'B' });
  store.addTask({ title: 'C' });
  var a = store.state.tasks[2].id;
  var b = store.state.tasks[1].id;
  var c = store.state.tasks[0].id;

  assert(store.moveTask(c, 'down') === true, 'moved down');
  assertEqual(titles(store), ['B', 'C', 'A'], 'after moving down');
  assert(store.moveTask(c, 'up') === true, 'moved back up');
  assertEqual(titles(store), ['C', 'B', 'A'], 'after moving up');
  assert(store.moveTask(a, 'top') === true, 'moved to top');
  assertEqual(titles(store), ['A', 'C', 'B'], 'after moving to top');
  assert(store.moveTask(a, 'bottom') === true, 'moved to bottom');
  assertEqual(titles(store), ['C', 'B', 'A'], 'after moving to bottom');
  assert(store.moveTask(a, 'down') === false, 'cannot move past the end');
  assert(store.moveTask('nope', 'up') === false, 'unknown id is a no-op');
  assert(b !== null, 'ids captured');
});

test('moveRelative drops before and after a target', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'A' });
  store.addTask({ title: 'B' });
  store.addTask({ title: 'C' });
  var a = store.state.tasks[2].id;
  var b = store.state.tasks[1].id;
  var c = store.state.tasks[0].id;

  assert(store.moveRelative(a, c, 'after') === true, 'moved A after C');
  assertEqual(titles(store), ['C', 'A', 'B'], 'after drop');
  assert(store.moveRelative(b, c, 'before') === true, 'moved B before C');
  assertEqual(titles(store), ['B', 'C', 'A'], 'before drop');
  assert(store.moveRelative(a, a, 'before') === false, 'dropping onto itself is a no-op');
  assert(store.moveRelative(a, 'missing', 'before') === false, 'unknown target is a no-op');
});

console.log('\nfilters, search and sort');

test('filters keep only the matching tasks', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'Open task' });
  var done = store.addTask({ title: 'Done task' });
  store.toggleTask(done.id);

  assertEqual(store.visibleTasks().length, 2, 'all');
  store.setFilter('active');
  assertEqual(store.visibleTasks().map(function (t) { return t.title; }), ['Open task'], 'active only');
  store.setFilter('completed');
  assertEqual(store.visibleTasks().map(function (t) { return t.title; }), ['Done task'], 'completed only');
  assert(store.setFilter('bogus') === null, 'unknown filter rejected');
  assertEqual(store.state.prefs.filter, 'completed', 'filter unchanged after a bad value');
  store.setFilter('all');
});

test('the Today view shows work due today', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'Due today', dueDate: isoDay(0) });
  store.addTask({ title: 'Due tomorrow', dueDate: isoDay(1) });
  store.addTask({ title: 'No date' });

  store.setFilter('today');
  assertEqual(visibleTitles(store), ['Due today'], 'only today');
  assertEqual(store.counts().today, 1, 'counted for the sidebar');
  store.setFilter('all');
});

test('priority and tag facets narrow the board', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'Fix the sink', priority: 'high', tags: ['Home'] });
  store.addTask({ title: 'Ship the release', priority: 'high', tags: ['Work'] });
  store.addTask({ title: 'Water the plants', priority: 'low', tags: ['Home'] });

  store.setPriorityFilter('high');
  assertEqual(visibleTitles(store), ['Ship the release', 'Fix the sink'], 'priority facet');
  store.setTagFilter('home');
  assertEqual(visibleTitles(store), ['Fix the sink'], 'priority + tag combined (case-insensitive)');
  assert(store.setPriorityFilter('bogus') === null, 'unknown priority rejected');
  assertEqual(store.state.prefs.priority, 'high', 'priority unchanged after a bad value');

  store.setTagFilter(null);
  assertEqual(store.state.prefs.tag, null, 'tag facet cleared');
  store.setPriorityFilter('any');
  assertEqual(visibleTitles(store), ['Water the plants', 'Ship the release', 'Fix the sink'], 'facets off again');

  var counts = store.counts();
  assertEqual([counts.priority.high, counts.priority.low, counts.priority.none], [2, 1, 0], 'priority counts');
  assertEqual(counts.tags.map(function (t) { return t.name + ':' + t.total; }),
    ['Home:2', 'Work:1'], 'tag counts, busiest first');
});

test('selectTask opens exactly one task at a time', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var a = store.addTask({ title: 'A' });
  var b = store.addTask({ title: 'B' });

  store.selectTask(a.id);
  assertEqual(store.state.tasks.map(function (t) { return t.expanded; }), [false, true], 'only A is open');
  store.selectTask(b.id);
  assertEqual(store.state.tasks.map(function (t) { return t.expanded; }), [true, false], 'only B is open');
  assert(store.selectTask(null) === null, 'clearing the selection reports nothing selected');
  assert(store.state.tasks.every(function (t) { return !t.expanded; }), 'every task closed');
});

test('search matches titles, notes and sub-task titles', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Groceries' });
  store.addSubtask(task.id, 'Oat milk');
  store.updateTask(task.id, { notes: 'check the coupon' });
  store.addTask({ title: 'Unrelated' });

  store.setQuery('grocer');
  assertEqual(store.visibleTasks().length, 1, 'title match');
  store.setQuery('OAT MILK');
  assertEqual(store.visibleTasks().length, 1, 'sub-task match, case-insensitive');
  store.setQuery('coupon');
  assertEqual(store.visibleTasks().length, 1, 'notes match');
  store.setQuery('  ');
  assertEqual(store.visibleTasks().length, 2, 'blank query matches everything');
  store.setQuery('nothing here');
  assertEqual(store.visibleTasks().length, 0, 'no matches');
  store.setQuery('');
});

test('sorting keeps completed work at the bottom', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var low = store.addTask({ title: 'Low', priority: 'low' });
  var high = store.addTask({ title: 'High', priority: 'high' });
  var medDone = store.addTask({ title: 'Med done', priority: 'medium' });
  store.toggleTask(medDone.id);
  store.updateTask(low.id, { dueDate: isoDay(5) });
  store.updateTask(high.id, { dueDate: isoDay(1) });

  store.setSort('priority');
  assertEqual(visibleTitles(store), ['High', 'Low', 'Med done'], 'priority order, done last');
  store.setSort('dueDate');
  assertEqual(visibleTitles(store), ['High', 'Low', 'Med done'], 'due-date order, done last');
  store.setSort('title');
  assertEqual(visibleTitles(store), ['High', 'Low', 'Med done'], 'alphabetical, done last');
  store.setSort('created');
  assertEqual(visibleTitles(store), ['High', 'Low', 'Med done'], 'newest first, done last');
  store.setSort('manual');
  assertEqual(visibleTitles(store), ['Med done', 'High', 'Low'], 'manual order restored');
  assert(store.setSort('bogus') === null, 'unknown sort rejected');
});

console.log('\nderived data and persistence');

test('counts track totals, overdue work and progress', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var a = store.addTask({ title: 'A', dueDate: isoDay(-2) });
  store.addTask({ title: 'B' });
  store.addSubtask(a.id, 'Sub one');
  store.addSubtask(a.id, 'Sub two');
  store.toggleSubtask(a.id, a.subtasks[0].id);

  var c = store.counts();
  assertEqual([c.total, c.active, c.completed, c.overdue], [2, 2, 0, 1], 'totals and overdue');
  assertEqual([c.subtasks, c.subtasksDone], [2, 1], 'sub-task totals');
  assertEqual(c.percent, 0, 'no progress yet');

  store.toggleTask(store.state.tasks[1].id);
  assertEqual(store.counts().percent, 50, 'half done');
});

test('due dates get a label and a tone', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var late = store.addTask({ title: 'Late', dueDate: isoDay(-1) });
  var today = store.addTask({ title: 'Today', dueDate: isoDay(0) });
  var tomorrow = store.addTask({ title: 'Tomorrow', dueDate: isoDay(1) });
  var later = store.addTask({ title: 'Later', dueDate: isoDay(9) });
  var none = store.addTask({ title: 'No date' });
  store.setQuery('');

  assertEqual(store.dueMeta(late).tone, 'due-over', 'overdue tone');
  assert(/late/.test(store.dueMeta(late).label), 'overdue label mentions lateness');
  assertEqual(store.dueMeta(today).label, 'Due today', 'today label');
  assertEqual(store.dueMeta(today).tone, 'due-today', 'today tone');
  assertEqual(store.dueMeta(tomorrow).tone, 'due-soon', 'tomorrow tone');
  assertEqual(store.dueMeta(later).tone, '', 'future date has a plain tone');
  assert(store.dueMeta(none) === null, 'no due date, no chip');
});

test('preferences survive a reload', function () {
  var store = newStore();
  store.init();
  store.setTheme('dark');
  store.setSort('title');
  store.setFilter('active');
  assert(store.setTheme('neon') === null, 'unknown theme rejected');
  assertEqual(store.cycleTheme().theme, 'auto', 'cycles to auto after dark');

  var reloaded = newStore(store.fakeStorage._dump());
  reloaded.init();
  assertEqual(reloaded.state.prefs,
    { theme: 'auto', filter: 'active', sort: 'title', priority: 'any', tag: null }, 'prefs reloaded');
});

test('subscribers are told why they were re-rendered', function () {
  var store = newStore();
  var reasons = [];
  store.subscribe(function (reason) { reasons.push(reason); });
  store.init();
  var task = store.addTask({ title: 'Ping' });
  store.toggleTask(task.id);
  store.setQuery('p');
  assertEqual(reasons, ['init', 'add', 'toggle', 'query'], 'event order');
});

console.log('\nimport / export');

test('export then import into an empty list keeps every field', function () {
  var store = newStore();
  store.init();
  store.wipe();
  var task = store.addTask({ title: 'Ship it', priority: 'high', dueDate: isoDay(2), tags: ['Release'] });
  store.updateTask(task.id, { notes: 'with care' });
  store.addSubtask(task.id, 'Write the notes');
  var text = store.exportText();

  var target = newStore();
  target.init();
  target.wipe();
  var result = target.importText(text, 'replace');
  assertEqual(result, { ok: true, count: 1 }, 'import succeeded');
  var copy = target.state.tasks[0];
  assertEqual([copy.title, copy.notes, copy.priority, copy.dueDate],
    ['Ship it', 'with care', 'high', isoDay(2)], 'fields copied');
  assertEqual(copy.tags, ['Release'], 'tags copied');
  assertEqual(copy.subtasks.map(function (s) { return s.title; }), ['Write the notes'], 'sub-tasks copied');
});

test('merge import skips duplicates and reports bad files', function () {
  var store = newStore();
  store.init();
  store.wipe();
  store.addTask({ title: 'Shared' });
  assertEqual(store.importText(store.exportText(), 'merge').ok, false, 'duplicates refused');

  var other = newStore();
  other.init();
  other.wipe();
  other.addTask({ title: 'Fresh' });
  var merged = store.importText(other.exportText(), 'merge');
  assertEqual(merged, { ok: true, count: 1 }, 'new task merged');
  assertEqual(titles(store), ['Fresh', 'Shared'], 'merged task went to the top');

  assertEqual(store.importText('{not json', 'merge').ok, false, 'invalid JSON rejected');
  assertEqual(store.importText('{"tasks": []}', 'merge').ok, false, 'empty payload rejected');
});

/* ============================================================
   summary
   ============================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);

