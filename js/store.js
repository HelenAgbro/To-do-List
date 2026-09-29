/* ============================================================
   store.js — state, persistence and every mutation of the data.
   Plain script (no ES modules) so the app also works from file://
   Exposes window.TodoStore.
   ============================================================ */
(function (global) {
  'use strict';

  var TASKS_KEY = 'todo.list.v1';
  var PREFS_KEY = 'todo.prefs.v1';
  var SEED_KEY = 'todo.seeded.v1';

  var PRIORITIES = ['none', 'low', 'medium', 'high'];
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2, none: 3 };
  var FILTERS = ['all', 'today', 'active', 'completed'];
  var PRIORITY_FILTERS = ['any', 'high', 'medium', 'low', 'none'];
  var SORTS = ['manual', 'dueDate', 'priority', 'title', 'created'];
  var TAGS_MAX = 6;
  var TAG_MAX_LENGTH = 24;

  /* ---------------- helpers ---------------- */

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** Trim ends and collapse inner whitespace — used for single-line titles. */
  function cleanLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** Trim ends only — used for multi-line notes. */
  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+$/, '').replace(/^\s+/, '');
  }

  /** Local (not UTC) calendar day as YYYY-MM-DD. */
  function todayStr(date) {
    var d = date || new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function readJson(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (raw == null) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------- normalisation / factories ---------------- */

  function normalizePriority(value) {
    return PRIORITIES.indexOf(value) === -1 ? 'none' : value;
  }

  function normalizeDueDate(value) {
    return (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? value : null;
  }

  /** Tags are short single-line labels, trimmed and capped in length. */
  function cleanTag(value) {
    return cleanLine(value).slice(0, TAG_MAX_LENGTH);
  }

  /** Normalised tag list: no blanks, no duplicates (case-insensitive), at most TAGS_MAX. */
  function normalizeTags(raw) {
    var out = [];
    var seen = {};
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var tag = cleanTag(raw[i]);
      if (!tag) continue;
      var key = tag.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      if (out.length >= TAGS_MAX) break;
      out.push(tag);
    }
    return out;
  }

  function hasTag(task, tag) {
    var needle = cleanTag(tag).toLowerCase();
    if (!needle) return false;
    for (var i = 0; i < task.tags.length; i++) {
      if (task.tags[i].toLowerCase() === needle) return true;
    }
    return false;
  }

  function makeSubtask(raw) {
    raw = raw || {};
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('s'),
      title: cleanLine(raw.title) || 'Untitled sub-task',
      completed: !!raw.completed
    };
  }

  function makeTask(raw) {
    raw = raw || {};
    var subtasks = Array.isArray(raw.subtasks) ? raw.subtasks.map(makeSubtask) : [];
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('t'),
      title: cleanLine(raw.title) || 'Untitled task',
      notes: cleanText(raw.notes),
      completed: !!raw.completed,
      priority: normalizePriority(raw.priority),
      dueDate: normalizeDueDate(raw.dueDate),
      tags: normalizeTags(raw.tags),
      expanded: !!raw.expanded,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
      subtasks: subtasks
    };
  }

  function cloneTask(task) {
    return {
      id: task.id,
      title: task.title,
      notes: task.notes,
      completed: task.completed,
      priority: task.priority,
      dueDate: task.dueDate,
      tags: (task.tags || []).slice(),
      expanded: task.expanded,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      subtasks: task.subtasks.map(function (s) {
        return { id: s.id, title: s.title, completed: s.completed };
      })
    };
  }

  /** Keep parent state in step with its sub-tasks. */
  function syncParent(task) {
    if (!task.subtasks.length) return;
    task.completed = task.subtasks.every(function (s) { return s.completed; });
  }

  function indexOfTask(tasks, id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return i;
    return -1;
  }

  function clampIndex(index, length) {
    if (index < 0) return 0;
    if (index > length) return length;
    return index;
  }

  /* ---------------- state ---------------- */

  var state = {
    tasks: [],
    prefs: { theme: 'auto', filter: 'all', sort: 'manual', priority: 'any', tag: null },
    query: '',
    storageOk: true
  };

  var listeners = [];

  function persist() {
    var okTasks = writeJson(TASKS_KEY, state.tasks);
    var okPrefs = writeJson(PREFS_KEY, state.prefs);
    state.storageOk = okTasks && okPrefs;
    return state.storageOk;
  }

  function emit(reason) {
    for (var i = 0; i < listeners.length; i++) listeners[i](reason);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function normalizePrefs(raw) {
    raw = raw || {};
    return {
      theme: ['light', 'dark', 'auto'].indexOf(raw.theme) === -1 ? 'auto' : raw.theme,
      filter: FILTERS.indexOf(raw.filter) === -1 ? 'all' : raw.filter,
      sort: SORTS.indexOf(raw.sort) === -1 ? 'manual' : raw.sort,
      priority: PRIORITY_FILTERS.indexOf(raw.priority) === -1 ? 'any' : raw.priority,
      tag: cleanTag(raw.tag) || null
    };
  }

  function demoTasks() {
    var soon = new Date(Date.now() + 2 * 86400000);
    return [
      {
        title: 'Welcome — try the features',
        notes: 'Click a task to open its details, tags and sub-tasks on the right.',
        priority: 'high',
        dueDate: todayStr(),
        tags: ['Personal'],
        expanded: true,
        subtasks: [
          { title: 'Tick a sub-task', completed: false },
          { title: 'Add one of your own below', completed: false }
        ]
      },
      {
        title: 'Plan the week ahead',
        priority: 'medium',
        dueDate: todayStr(soon),
        tags: ['Work'],
        subtasks: [{ title: 'Pick the three most important items', completed: false }]
      },
      {
        title: 'Read a chapter of a book',
        notes: 'Sample task that is already done — press “Clear done” to remove it.',
        completed: true,
        tags: ['Personal', 'Reading'],
        subtasks: [{ title: 'Read chapter 1', completed: true }]
      }
    ];
  }

  function init() {
    var storedTasks = readJson(TASKS_KEY, null);
    state.prefs = normalizePrefs(readJson(PREFS_KEY, null));
    if (Array.isArray(storedTasks)) {
      state.tasks = storedTasks.map(makeTask);
    } else if (!readJson(SEED_KEY, false)) {
      state.tasks = demoTasks().map(makeTask);
      writeJson(SEED_KEY, true);
      persist();
    } else {
      state.tasks = [];
    }
    emit('init');
    return api;
  }

  /* ---------------- task mutations ---------------- */

  function findTask(id) {
    var i = indexOfTask(state.tasks, id);
    return i === -1 ? null : state.tasks[i];
  }

  function addTask(input) {
    input = input || {};
    var title = cleanLine(input.title);
    if (!title) return null;
    var task = makeTask({
      title: title,
      notes: input.notes,
      priority: input.priority,
      dueDate: input.dueDate,
      tags: input.tags
    });
    state.tasks.unshift(task);
    persist();
    emit('add');
    return task;
  }

  function updateTask(id, patch) {
    var task = findTask(id);
    if (!task) return null;
    patch = patch || {};
    if ('title' in patch) {
      var title = cleanLine(patch.title);
      if (title) task.title = title;
    }
    if ('notes' in patch) task.notes = cleanText(patch.notes);
    if ('priority' in patch) task.priority = normalizePriority(patch.priority);
    if ('dueDate' in patch) task.dueDate = normalizeDueDate(patch.dueDate);
    if ('tags' in patch) task.tags = normalizeTags(patch.tags);
    if ('expanded' in patch) task.expanded = !!patch.expanded;
    task.updatedAt = nowIso();
    persist();
    emit('update');
    return task;
  }

  function toggleTask(id, force) {
    var task = findTask(id);
    if (!task) return null;
    var next = (typeof force === 'boolean') ? force : !task.completed;
    task.completed = next;
    // A parent check cascades down, so a ticked task never shows unticked work.
    for (var i = 0; i < task.subtasks.length; i++) task.subtasks[i].completed = next;
    task.updatedAt = nowIso();
    persist();
    emit('toggle');
    return task;
  }

  function deleteTask(id) {
    var index = indexOfTask(state.tasks, id);
    if (index === -1) return null;
    var removed = state.tasks.splice(index, 1)[0];
    persist();
    emit('delete');
    return { task: removed, index: index };
  }

  function restoreTask(task, index) {
    if (!task) return null;
    var at = clampIndex(index == null ? state.tasks.length : index, state.tasks.length);
    state.tasks.splice(at, 0, makeTask(task));
    persist();
    emit('restore');
    return state.tasks[at];
  }

  function markAll(completed) {
    if (!state.tasks.length) return null;
    var snapshot = state.tasks.map(cloneTask);
    state.tasks.forEach(function (task) {
      task.completed = completed;
      task.subtasks.forEach(function (s) { s.completed = completed; });
      task.updatedAt = nowIso();
    });
    persist();
    emit('markAll');
    return snapshot;
  }

  function restoreAll(snapshot) {
    if (!Array.isArray(snapshot)) return null;
    state.tasks = snapshot.map(makeTask);
    persist();
    emit('restore');
    return state.tasks;
  }

  function clearCompleted() {
    var removed = [];
    var kept = [];
    state.tasks.forEach(function (task, i) {
      if (task.completed) removed.push({ task: cloneTask(task), index: i });
      else kept.push(task);
    });
    if (!removed.length) return null;
    state.tasks = kept;
    persist();
    emit('clearCompleted');
    return removed;
  }

  function restoreMany(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;
    entries.slice().sort(function (a, b) { return a.index - b.index; }).forEach(function (entry) {
      state.tasks.splice(clampIndex(entry.index, state.tasks.length), 0, makeTask(entry.task));
    });
    persist();
    emit('restore');
    return state.tasks;
  }

  /* ---------------- ordering ---------------- */

  /** Nudge a task up/down (or straight to the top/bottom) in the manual order. */
  function moveTask(id, direction) {
    var from = indexOfTask(state.tasks, id);
    if (from === -1) return false;
    var last = state.tasks.length - 1;
    var to = direction === 'up' ? from - 1
      : direction === 'down' ? from + 1
      : direction === 'top' ? 0
      : direction === 'bottom' ? last
      : from;
    if (to < 0 || to > last || to === from) return false;
    var moved = state.tasks.splice(from, 1)[0];
    state.tasks.splice(to, 0, moved);
    persist();
    emit('move');
    return true;
  }

  /** Drop `dragId` immediately before/after `targetId` (used by drag & drop). */
  function moveRelative(dragId, targetId, place) {
    if (dragId === targetId) return false;
    var from = indexOfTask(state.tasks, dragId);
    var targetAt = indexOfTask(state.tasks, targetId);
    if (from === -1 || targetAt === -1) return false;
    var moved = state.tasks.splice(from, 1)[0];
    var adjusted = indexOfTask(state.tasks, targetId);
    state.tasks.splice(clampIndex(place === 'after' ? adjusted + 1 : adjusted, state.tasks.length), 0, moved);
    persist();
    emit('move');
    return true;
  }

  /* ---------------- sub-task mutations ---------------- */

  function findSubtask(task, subId) {
    if (!task) return null;
    for (var i = 0; i < task.subtasks.length; i++) {
      if (task.subtasks[i].id === subId) return task.subtasks[i];
    }
    return null;
  }

  function indexOfSubtask(task, subId) {
    if (!task) return -1;
    for (var i = 0; i < task.subtasks.length; i++) {
      if (task.subtasks[i].id === subId) return i;
    }
    return -1;
  }

  function addSubtask(taskId, title) {
    var task = findTask(taskId);
    var clean = cleanLine(title);
    if (!task || !clean) return null;
    var sub = makeSubtask({ title: clean });
    task.subtasks.push(sub);
    syncParent(task);
    task.updatedAt = nowIso();
    persist();
    emit('subtask');
    return sub;
  }

  function toggleSubtask(taskId, subId) {
    var task = findTask(taskId);
    var sub = findSubtask(task, subId);
    if (!sub) return null;
    sub.completed = !sub.completed;
    syncParent(task);
    task.updatedAt = nowIso();
    persist();
    emit('subtask');
    return sub;
  }

  function updateSubtask(taskId, subId, patch) {
    var task = findTask(taskId);
    var sub = findSubtask(task, subId);
    if (!sub) return null;
    if (patch && 'title' in patch) {
      var title = cleanLine(patch.title);
      if (title) sub.title = title;
    }
    task.updatedAt = nowIso();
    persist();
    emit('subtask');
    return sub;
  }

  function deleteSubtask(taskId, subId) {
    var task = findTask(taskId);
    var index = indexOfSubtask(task, subId);
    if (index === -1) return null;
    var removed = task.subtasks.splice(index, 1)[0];
    syncParent(task);
    task.updatedAt = nowIso();
    persist();
    emit('subtask');
    return { subtask: removed, index: index };
  }

  function restoreSubtask(taskId, subtask, index) {
    var task = findTask(taskId);
    if (!task || !subtask) return null;
    task.subtasks.splice(clampIndex(index == null ? task.subtasks.length : index, task.subtasks.length), 0, makeSubtask(subtask));
    syncParent(task);
    task.updatedAt = nowIso();
    persist();
    emit('subtask');
    return task;
  }

  /* ---------------- preferences ---------------- */

  function setFilter(value) {
    if (FILTERS.indexOf(value) === -1) return null;
    state.prefs.filter = value;
    persist();
    emit('prefs');
    return state.prefs;
  }

  /** Sidebar "lists": narrow the board down to one priority. */
  function setPriorityFilter(value) {
    if (PRIORITY_FILTERS.indexOf(value) === -1) return null;
    state.prefs.priority = value;
    persist();
    emit('prefs');
    return state.prefs;
  }

  /** Sidebar "tags": null / '' clears the tag facet. */
  function setTagFilter(value) {
    state.prefs.tag = cleanTag(value) || null;
    persist();
    emit('prefs');
    return state.prefs;
  }

  /** Open a task in the detail panel (only one task is open at a time). */
  function selectTask(id) {
    var found = false;
    state.tasks.forEach(function (task) {
      var open = task.id === id;
      if (open) found = true;
      task.expanded = open;
    });
    persist();
    emit('select');
    return found ? findTask(id) : null;
  }

  /** The task currently open in the detail panel, or null. */
  function selectedTask() {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].expanded) return state.tasks[i];
    }
    return null;
  }

  function setSort(value) {
    if (SORTS.indexOf(value) === -1) return null;
    state.prefs.sort = value;
    persist();
    emit('prefs');
    return state.prefs;
  }

  function setTheme(value) {
    if (['light', 'dark', 'auto'].indexOf(value) === -1) return null;
    state.prefs.theme = value;
    persist();
    emit('prefs');
    return state.prefs;
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
    return setTheme(next);
  }

  function setQuery(value) {
    state.query = String(value == null ? '' : value);
    emit('query');
    return state.query;
  }

  /* ---------------- derived data ---------------- */

  function daysUntil(dueDate) {
    var due = dueDate.split('-');
    var today = todayStr().split('-');
    var a = Date.UTC(+due[0], +due[1] - 1, +due[2]);
    var b = Date.UTC(+today[0], +today[1] - 1, +today[2]);
    return Math.round((a - b) / 86400000);
  }

  function formatDate(dueDate) {
    var parts = dueDate.split('-');
    var date = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    } catch (err) {
      return dueDate;
    }
  }

  /** {label, tone} for the due-date chip, or null when there is no due date. */
  function dueMeta(task) {
    if (!task || !task.dueDate) return null;
    var diff = daysUntil(task.dueDate);
    var label = formatDate(task.dueDate);
    if (task.completed) return { label: label, tone: '' };
    if (diff < 0) {
      return { label: (diff === -1 ? '1 day late' : (-diff) + ' days late') + ' \u00b7 ' + label, tone: 'due-over' };
    }
    if (diff === 0) return { label: 'Due today', tone: 'due-today' };
    if (diff === 1) return { label: 'Due tomorrow', tone: 'due-soon' };
    return { label: label, tone: '' };
  }

  function matchesQuery(task, needle) {
    if (!needle) return true;
    var haystack = (task.title + ' \u0001 ' + task.notes + ' \u0001 ' + task.tags.join(' ') + ' \u0001 ' +
      task.subtasks.map(function (s) { return s.title; }).join(' ')).toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  function bySortKind(kind) {
    if (kind === 'dueDate') {
      return function (a, b) {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      };
    }
    if (kind === 'priority') {
      return function (a, b) {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        var rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (rank) return rank;
        return a.title.localeCompare(b.title);
      };
    }
    if (kind === 'title') {
      return function (a, b) {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return a.title.localeCompare(b.title);
      };
    }
    if (kind === 'created') {
      return function (a, b) {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      };
    }
    return null; /* manual: keep the stored order */
  }

  /** Tasks that pass the active view + priority/tag facets + search, in the active sort order. */
  function visibleTasks() {
    var filter = state.prefs.filter;
    var needle = state.query.trim().toLowerCase();
    var priority = state.prefs.priority;
    var tag = state.prefs.tag;
    var list = [];
    for (var i = 0; i < state.tasks.length; i++) {
      var task = state.tasks[i];
      if (filter === 'active' && task.completed) continue;
      if (filter === 'completed' && !task.completed) continue;
      if (filter === 'today' && (!task.dueDate || daysUntil(task.dueDate) !== 0)) continue;
      if (priority !== 'any' && task.priority !== priority) continue;
      if (tag && !hasTag(task, tag)) continue;
      if (!matchesQuery(task, needle)) continue;
      list.push(task);
    }
    var sorter = bySortKind(state.prefs.sort);
    if (sorter) list.sort(sorter);
    return list;
  }

  function counts() {
    var total = state.tasks.length;
    var completed = 0, overdue = 0, today = 0, subtasks = 0, subtasksDone = 0;
    var byPriority = { any: total, none: 0, low: 0, medium: 0, high: 0 };
    var tagMap = {};
    state.tasks.forEach(function (task) {
      var late = task.dueDate ? daysUntil(task.dueDate) : null;
      if (task.completed) completed++;
      else if (late !== null && late < 0) overdue++;
      if (late === 0) today++;
      byPriority[task.priority]++;
      task.tags.forEach(function (name) {
        var key = name.toLowerCase();
        if (!tagMap[key]) tagMap[key] = { name: name, total: 0, active: 0 };
        tagMap[key].total++;
        if (!task.completed) tagMap[key].active++;
      });
      subtasks += task.subtasks.length;
      task.subtasks.forEach(function (s) { if (s.completed) subtasksDone++; });
    });
    var tags = Object.keys(tagMap).map(function (key) { return tagMap[key]; }).sort(function (a, b) {
      if (a.total !== b.total) return b.total - a.total;
      return a.name.localeCompare(b.name);
    });
    return {
      total: total,
      active: total - completed,
      completed: completed,
      overdue: overdue,
      today: today,
      subtasks: subtasks,
      subtasksDone: subtasksDone,
      percent: total ? Math.round((completed / total) * 100) : 0,
      priority: byPriority,
      tags: tags
    };
  }

  /* ---------------- import / export ---------------- */

  function exportText() {
    return JSON.stringify({
      app: 'todo-list',
      version: 2,
      exportedAt: nowIso(),
      tasks: state.tasks
    }, null, 2);
  }

  /** mode: "merge" (default, skips duplicate ids) or "replace". */
  function importText(text, mode) {
    var parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch (err) {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null);
    if (!list) return { ok: false, error: 'No task list found in that file.' };
    var incoming = list.map(makeTask);
    if (!incoming.length) return { ok: false, error: 'That file contains no tasks.' };

    if (mode === 'replace') {
      state.tasks = incoming;
    } else {
      var known = {};
      state.tasks.forEach(function (t) { known[t.id] = true; });
      var fresh = incoming.filter(function (t) { return !known[t.id]; });
      if (!fresh.length) return { ok: false, error: 'Those tasks are already in your list.' };
      state.tasks = fresh.concat(state.tasks);
      incoming = fresh;
    }
    persist();
    emit('import');
    return { ok: true, count: incoming.length };
  }

  function wipe() {
    var snapshot = state.tasks.map(cloneTask);
    state.tasks = [];
    writeJson(SEED_KEY, true); /* never re-seed the demo list after an explicit wipe */
    persist();
    emit('wipe');
    return snapshot;
  }

  /* ---------------- public API ---------------- */

  var api = {
    PRIORITIES: PRIORITIES,
    PRIORITY_RANK: PRIORITY_RANK,
    PRIORITY_FILTERS: PRIORITY_FILTERS,
    FILTERS: FILTERS,
    SORTS: SORTS,
    TAGS_MAX: TAGS_MAX,
    state: state,
    init: init,
    subscribe: subscribe,
    todayStr: todayStr,
    formatDate: formatDate,
    dueMeta: dueMeta,
    counts: counts,
    visibleTasks: visibleTasks,
    addTask: addTask,
    updateTask: updateTask,
    toggleTask: toggleTask,
    deleteTask: deleteTask,
    restoreTask: restoreTask,
    markAll: markAll,
    restoreAll: restoreAll,
    clearCompleted: clearCompleted,
    restoreMany: restoreMany,
    moveTask: moveTask,
    moveRelative: moveRelative,
    addSubtask: addSubtask,
    toggleSubtask: toggleSubtask,
    updateSubtask: updateSubtask,
    deleteSubtask: deleteSubtask,
    restoreSubtask: restoreSubtask,
    setFilter: setFilter,
    setPriorityFilter: setPriorityFilter,
    setTagFilter: setTagFilter,
    selectTask: selectTask,
    selectedTask: selectedTask,
    setSort: setSort,
    setTheme: setTheme,
    cycleTheme: cycleTheme,
    setQuery: setQuery,
    exportText: exportText,
    importText: importText,
    wipe: wipe
  };

  global.TodoStore = api;

})(typeof window !== 'undefined' ? window : globalThis);




