/* ============================================================
   ui.js — renders state into the DOM.
   Layout: sidebar (views / priority lists / tags) · board (rows)
   · detail rail (master-detail editor with drafts).
   All user text is inserted with textContent / createTextNode
   (never innerHTML), so task titles can never inject markup.
   Exposes window.TodoUI.
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.TodoStore;

  var refs = {};

  /** Transient view-only state. */
  var view = {
    draft: null,      /* unsaved rail edits: { id, title, notes, priority, due, tags } */
    selectOnRender: null
  };

  var FILTER_LABELS = { all: 'All tasks', today: 'Today', active: 'Active', completed: 'Completed' };
  var PRIORITY_LABELS = { any: 'All tasks', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

  /* ---------------- tiny DOM builder ---------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'class') {
          node.className = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'dataset') {
          Object.keys(value).forEach(function (k) { node.dataset[k] = String(value[k]); });
        } else if (value === true) {
          node.setAttribute(key, '');
        } else {
          node.setAttribute(key, value);
        }
      });
    }
    var kids = Array.isArray(children) ? children : (children == null ? [] : [children]);
    kids.forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /** The two regions that hold inputs we may need to rebuild mid-typing. */
  function containers() {
    return [refs['task-list'], refs.detail].filter(Boolean);
  }

  function inContainers(node) {
    return containers().some(function (box) { return box.contains(node); });
  }

  function cacheRefs() {
    [
      'today', 'theme-btn', 'theme-icon', 'export-btn', 'import-btn', 'import-file', 'reset-btn',
      'views', 'pri-list', 'tag-list',
      'board-title', 'board-count', 'board-note', 'search', 'search-clear', 'search-hint', 'sort',
      'toggle-all', 'clear-completed',
      'add-form', 'new-task', 'new-priority', 'new-due', 'new-tags',
      'summary-text', 'progress', 'progress-bar',
      'task-list', 'empty', 'empty-title', 'empty-text', 'detail', 'toast-region'
    ].forEach(function (id) {
      refs[id] = document.getElementById(id);
    });
    refs.tabs = Array.prototype.slice.call(document.querySelectorAll('.tab[data-filter]'));
    refs.counts = Array.prototype.slice.call(document.querySelectorAll('.count[data-count]'));
    return refs;
  }

  /* ---------------- focus preservation ----------------
     Both the board and the rail are re-rendered wholesale on every
     store change, so we snapshot the focused control and put the
     caret back afterwards.                                    */

  function cssEscape(value) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(value);
    return String(value).replace(/["\\[\]:]/g, '\\$&');
  }

  function findByFocusKey(key) {
    var escaped = '[data-focus-key="' + cssEscape(key) + '"]';
    var found = null;
    containers().forEach(function (box) {
      if (!found) found = box.querySelector(escaped);
    });
    return found;
  }

  function captureFocus() {
    var node = document.activeElement;
    if (!node || !node.dataset || !node.dataset.focusKey || !inContainers(node)) return null;
    var snapshot = { key: node.dataset.focusKey };
    try {
      if (typeof node.selectionStart === 'number') {
        snapshot.start = node.selectionStart;
        snapshot.end = node.selectionEnd;
      }
    } catch (err) { /* date inputs throw on selection reads in some browsers */ }
    return snapshot;
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    var node = findByFocusKey(snapshot.key);
    if (!node) return;
    try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
    if (view.selectOnRender === snapshot.key && typeof node.select === 'function') {
      node.select();
      view.selectOnRender = null;
    } else if (snapshot.start != null && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(snapshot.start, snapshot.end); } catch (err) { /* not selectable */ }
    }
  }
  /* ---------------- rail drafts ----------------
     The detail rail edits a *copy* of the task. Nothing reaches the
     store until "Save changes", so a half-typed title never lands in
     localStorage, and re-renders re-apply the draft on top.          */

  function snapshotOf(task) {
    return {
      id: task.id,
      title: task.title,
      notes: task.notes,
      priority: task.priority,
      due: task.dueDate || '',
      tags: task.tags.join(', ')
    };
  }

  function draftFor(task) {
    return view.draft && view.draft.id === task.id ? view.draft : null;
  }

  function hasDraft() {
    return !!view.draft;
  }

  function clearDraft() {
    if (!view.draft) return false;
    view.draft = null;
    return true;
  }

  /** Remember one edited field; called on every keystroke in the rail. */
  function editDraft(field, value) {
    var task = S.selectedTask();
    if (!task) return null;
    if (!view.draft || view.draft.id !== task.id) view.draft = snapshotOf(task);
    view.draft[field] = String(value == null ? '' : value);
    if (refs.detail) {
      refs.detail.classList.add('is-dirty');
      var save = refs.detail.querySelector('[data-action="save-task"]');
      if (save) {
        save.classList.add('is-armed');
        save.disabled = false;
      }
      var flag = refs.detail.querySelector('.detail-flag');
      if (flag) flag.textContent = 'Unsaved changes \u2014 press Save.';
    }
    return view.draft;
  }

  function parseTags(value) {
    return String(value == null ? '' : value).split(',');
  }

  /** The draft turned into a store patch, or null when nothing was edited. */
  function draftPatch() {
    if (!view.draft) return null;
    return {
      title: view.draft.title,
      notes: view.draft.notes,
      priority: view.draft.priority,
      dueDate: view.draft.due || null,
      tags: parseTags(view.draft.tags)
    };
  }

  /** Write the draft to the store. Returns the saved task, or null. */
  function commitDraft() {
    var task = S.selectedTask();
    var patch = draftPatch();
    if (!task || !patch) return null;
    clearDraft();
    var saved = S.updateTask(task.id, patch);
    if (saved) saved.expanded = true;
    return saved;
  }

  /** Drop the draft and re-render, so the rail shows the stored values. */
  function revertDraft() {
    if (!clearDraft()) return false;
    render('revert');
    return true;
  }

  /* ---------------- shared widgets ---------------- */

  function chip(label, className) {
    return el('span', { class: 'chip' + (className ? ' ' + className : ''), text: label });
  }

  /** ids carries the data-* ids the delegated click handler reads (id / task). */
  function checkbox(checked, action, focusKey, mixed, ids) {
    var attrs = {
      type: 'button',
      role: 'checkbox',
      class: 'check' + (mixed ? ' mixed' : ''),
      'aria-checked': checked ? 'true' : 'false',
      'data-action': action,
      'data-focus-key': focusKey,
      title: checked ? 'Mark as not done' : 'Mark as done',
      text: checked ? '\u2713' : (mixed ? '\u2013' : '')
    };
    if (ids) {
      Object.keys(ids).forEach(function (key) {
        if (ids[key] != null) attrs['data-' + key] = ids[key];
      });
    }
    return el('button', attrs);
  }
  /* ---------------- board rows ---------------- */

  function metaRow(task) {
    var chips = [];
    if (task.priority !== 'none') {
      chips.push(chip(task.priority.charAt(0).toUpperCase() + task.priority.slice(1), 'pri-' + task.priority));
    }
    var due = S.dueMeta(task);
    if (due) chips.push(chip(due.label, due.tone));
    if (task.subtasks.length) {
      var done = task.subtasks.filter(function (s) { return s.completed; }).length;
      chips.push(chip(done + '/' + task.subtasks.length + ' steps', done === task.subtasks.length ? 'subs full' : 'subs'));
    }
    task.tags.forEach(function (tag) { chips.push(chip(tag, 'tag')); });
    if (task.notes) chips.push(chip('\u00b6', 'note'));
    return el('div', { class: 'task-meta' }, chips);
  }

  function taskRow(task, selectedId) {
    var selected = task.id === selectedId;
    var kids = [];

    if (S.state.prefs.sort === 'manual') {
      kids.push(el('button', {
        type: 'button', class: 'grip', draggable: 'true', 'data-id': task.id,
        title: 'Drag to reorder', 'aria-label': 'Reorder task', text: '\u28ff'
      }));
    }
    kids.push(checkbox(task.completed, 'toggle-task', 'check:' + task.id, false, { id: task.id }));
    kids.push(el('button', {
      type: 'button', class: 'task-title', text: task.title, 'data-action': 'select', 'data-id': task.id,
      'data-focus-key': 'title:' + task.id, title: 'Open the details for this task'
    }));
    kids.push(metaRow(task));
    kids.push(el('button', {
      type: 'button', class: 'chevron', text: '\u203a', 'data-action': 'select', 'data-id': task.id,
      'aria-expanded': selected ? 'true' : 'false',
      title: 'Open task details', 'aria-label': 'Open details for ' + task.title
    }));

    return el('li', {
      class: 'task pri-' + task.priority + (task.completed ? ' is-done' : '') + (selected ? ' is-selected' : ''),
      'data-id': task.id
    }, kids);
  }

  function renderList(tasks) {
    var list = refs['task-list'];
    if (!list) return;
    var selected = S.selectedTask();
    var selectedId = selected ? selected.id : null;
    var fragment = document.createDocumentFragment();
    tasks.forEach(function (task) { fragment.appendChild(taskRow(task, selectedId)); });
    clearNode(list);
    list.appendChild(fragment);
  }

  function renderEmpty(count) {
    var box = refs.empty;
    if (!box) return;
    box.hidden = count > 0;
    if (count > 0) return;
    var filter = S.state.prefs.filter;
    if (S.state.query) {
      refs['empty-title'].textContent = 'No matches';
      refs['empty-text'].textContent = 'Nothing matches \u201c' + S.state.query + '\u201d in this view.';
    } else if (S.state.prefs.priority !== 'any' || S.state.prefs.tag) {
      refs['empty-title'].textContent = 'Nothing in this list';
      refs['empty-text'].textContent = 'Try another list or clear the filters in the sidebar.';
    } else if (filter === 'today') {
      refs['empty-title'].textContent = 'Nothing due today';
      refs['empty-text'].textContent = 'Give a task today\u2019s date and it will show up here.';
    } else if (filter === 'active') {
      refs['empty-title'].textContent = 'Nothing left to do';
      refs['empty-text'].textContent = 'Every task is done \u2014 enjoy the quiet.';
    } else if (filter === 'completed') {
      refs['empty-title'].textContent = 'Nothing done yet';
      refs['empty-text'].textContent = 'Tick a task off and it will show up here.';
    } else {
      refs['empty-title'].textContent = 'No tasks yet';
      refs['empty-text'].textContent = 'Use the \u201cAdd New Task\u201d row above to add one.';
    }
  }
  /* ---------------- sidebar ---------------- */

  function renderViews(counts) {
    var active = S.state.prefs.filter;
    refs.counts.forEach(function (node) {
      node.textContent = String(counts[node.dataset.count] || 0);
    });
    refs.tabs.forEach(function (tab) {
      var on = tab.dataset.filter === active;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-current', on ? 'true' : 'false');
    });
  }

  function facetButton(attrs, label, count, on) {
    attrs.type = 'button';
    attrs.class = 'facet' + (on ? ' is-active' : '');
    attrs['aria-pressed'] = on ? 'true' : 'false';
    return el('button', attrs, [
      el('span', { class: 'facet-label', text: label }),
      el('span', { class: 'count', text: String(count) })
    ]);
  }

  function renderPriorities(counts) {
    var box = refs['pri-list'];
    if (!box) return;
    clearNode(box);
    S.PRIORITY_FILTERS.forEach(function (value) {
      box.appendChild(facetButton(
        { 'data-priority': value, title: 'Show ' + PRIORITY_LABELS[value].toLowerCase() },
        PRIORITY_LABELS[value],
        counts.priority[value],
        S.state.prefs.priority === value
      ));
    });
  }

  function renderTags(counts) {
    var box = refs['tag-list'];
    if (!box) return;
    clearNode(box);
    var active = S.state.prefs.tag;
    if (!counts.tags.length) {
      box.appendChild(el('p', { class: 'facet-empty', text: 'No tags yet \u2014 add them in the details panel.' }));
    } else {
      counts.tags.forEach(function (tag) {
        var on = !!active && tag.name.toLowerCase() === active.toLowerCase();
        box.appendChild(facetButton(
          { 'data-tag': tag.name, title: 'Show tasks tagged ' + tag.name },
          tag.name, tag.active, on
        ));
      });
    }
    if (active) {
      box.appendChild(el('button', {
        type: 'button', class: 'facet clear-facet', 'data-tag': '',
        text: 'Clear tag filter'
      }));
    }
  }

  /* ---------------- board chrome ---------------- */

  function renderSummary(counts) {
    if (!refs['summary-text']) return;
    if (!counts.total) {
      refs['summary-text'].textContent = 'No tasks yet \u2014 add your first one above.';
    } else {
      refs['summary-text'].textContent = counts.active + ' task' + (counts.active === 1 ? '' : 's') + ' left \u00b7 ' +
        counts.completed + ' done \u00b7 ' + counts.percent + '% complete';
    }
    refs.progress.setAttribute('aria-valuenow', String(counts.percent));
    refs['progress-bar'].style.width = counts.percent + '%';
  }

  function boardHeading(visible) {
    var parts = [FILTER_LABELS[S.state.prefs.filter] || 'All tasks'];
    if (S.state.prefs.priority !== 'any') parts.push(PRIORITY_LABELS[S.state.prefs.priority]);
    if (S.state.prefs.tag) parts.push('#' + S.state.prefs.tag);
    refs['board-title'].textContent = parts.join(' \u00b7 ');

    var counts = S.counts();
    refs['board-count'].textContent = visible + ' shown';
    if (counts.overdue) refs['board-note'].textContent = '\u00b7 ' + counts.overdue + ' overdue';
    else if (counts.today) refs['board-note'].textContent = '\u00b7 ' + counts.today + ' due today';
    else refs['board-note'].textContent = counts.total ? '\u00b7 nothing overdue' : '\u00b7 nothing scheduled';
  }

  function renderChrome(tasks, counts) {
    renderViews(counts);
    renderPriorities(counts);
    renderTags(counts);
    renderSummary(counts);
    renderEmpty(tasks.length);
    boardHeading(tasks.length);

    var theme = S.state.prefs.theme;
    refs['theme-icon'].textContent = theme === 'light' ? '\u2600' : theme === 'dark' ? '\u263e' : '\u25d0';
    refs['theme-btn'].title = 'Theme: ' + theme + ' \u2014 click to change';

    if (refs.sort.value !== S.state.prefs.sort) refs.sort.value = S.state.prefs.sort;
    if (refs['search-clear']) refs['search-clear'].hidden = !S.state.query;

    var hint = refs['search-hint'];
    if (hint) {
      if (S.state.query && !tasks.length) {
        hint.textContent = 'Nothing matches \u201c' + S.state.query + '\u201d.';
        hint.hidden = false;
      } else {
        hint.hidden = true;
      }
    }
  }

  function renderToday() {
    if (!refs.today) return;
    var now = new Date();
    var text;
    try {
      text = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
    } catch (err) {
      text = now.toDateString();
    }
    refs.today.textContent = text;
  }
  /* ---------------- detail rail ---------------- */

  function railField(label, control) {
    return el('label', { class: 'field' }, [el('span', { text: label }), control]);
  }

  function prioritySelect(task, value) {
    return el('select', {
      id: 'detail-priority', class: 'text-input', 'data-field': 'priority', 'data-focus-key': 'd:pri',
      'aria-label': 'List (priority) for ' + task.title
    }, S.PRIORITIES.map(function (option) {
      return el('option', {
        value: option,
        text: PRIORITY_LABELS[option],
        selected: value === option ? true : null
      });
    }));
  }

  function subtaskRow(task, sub) {
    return el('li', {
      class: 'subtask' + (sub.completed ? ' is-done' : ''),
      'data-id': sub.id,
      'data-task': task.id
    }, [
      checkbox(sub.completed, 'toggle-sub', 'scheck:' + task.id + ':' + sub.id, false,
        { id: sub.id, task: task.id }),
      el('span', { class: 'subtask-title', text: sub.title }),
      el('button', {
        type: 'button', class: 'act danger', text: '\u00d7', 'data-action': 'delete-sub',
        'data-task': task.id, 'data-id': sub.id, title: 'Delete sub-task', 'aria-label': 'Delete sub-task'
      })
    ]);
  }

  function orderRow(task) {
    function moveButton(label, dir, title) {
      return el('button', {
        type: 'button', class: 'btn ghost', text: label, 'data-action': 'move',
        'data-dir': dir, 'data-id': task.id, title: title
      });
    }
    return el('details', { class: 'detail-order' }, [
      el('summary', { text: 'Reorder in the list' }),
      el('div', { class: 'order-buttons' }, [
        moveButton('\u2191 Up', 'up', 'Move up (Alt + \u2191)'),
        moveButton('\u2193 Down', 'down', 'Move down (Alt + \u2193)'),
        moveButton('To top', 'top', 'Move to the top'),
        moveButton('To bottom', 'bottom', 'Move to the bottom')
      ])
    ]);
  }

  function detailEmpty() {
    return el('div', { class: 'detail-empty', id: 'detail-empty' }, [
      el('h2', { text: 'Nothing selected' }),
      el('p', { text: 'Pick a task on the board to edit its description, list, due date, tags and sub-tasks.' })
    ]);
  }
  function renderDetail() {
    var panel = refs.detail;
    if (!panel) return;
    clearNode(panel);

    var task = S.selectedTask();
    if (!task) {
      panel.classList.remove('is-dirty');
      panel.classList.add('is-empty');   /* lets the layout collapse the rail */
      panel.appendChild(detailEmpty());
      return;
    }

    var draft = draftFor(task);
    var dirty = !!draft;
    var values = {
      title: draft ? draft.title : task.title,
      notes: draft ? draft.notes : task.notes,
      priority: draft ? draft.priority : task.priority,
      due: draft ? draft.due : (task.dueDate || ''),
      tags: draft ? draft.tags : task.tags.join(', ')
    };
    var doneSubs = task.subtasks.filter(function (s) { return s.completed; }).length;

    panel.classList.toggle('is-dirty', dirty);
    panel.classList.remove('is-empty');
    panel.appendChild(el('article', { class: 'detail-card', 'data-id': task.id }, [
      el('header', { class: 'detail-head' }, [
        el('span', { class: 'detail-kicker', text: 'Task details' }),
        el('button', {
          type: 'button', class: 'icon-btn', 'data-action': 'close-detail', text: '\u00d7',
          title: 'Close the details panel', 'aria-label': 'Close details'
        })
      ]),

      railField('Task', el('input', {
        id: 'detail-title', class: 'text-input', type: 'text', maxlength: '200', value: values.title,
        'data-field': 'title', 'data-focus-key': 'd:title', 'aria-label': 'Task title'
      })),

      railField('Description', el('textarea', {
        id: 'detail-notes', class: 'text-input', rows: '4', 'data-field': 'notes',
        'data-focus-key': 'd:notes', placeholder: 'Add notes, links or context\u2026', 'aria-label': 'Description'
      }, values.notes)),

      el('div', { class: 'field-row' }, [
        railField('List', prioritySelect(task, values.priority)),
        railField('Due date', el('input', {
          id: 'detail-due', class: 'text-input', type: 'date', value: values.due,
          'data-field': 'due', 'data-focus-key': 'd:due', 'aria-label': 'Due date'
        }))
      ]),

      railField('Tags', el('input', {
        id: 'detail-tags', class: 'text-input', type: 'text', maxlength: '120', value: values.tags,
        'data-field': 'tags', 'data-focus-key': 'd:tags', placeholder: 'Home, Work',
        'aria-label': 'Tags, separated by commas'
      })),

      el('section', { class: 'detail-subs' }, [
        el('h3', { class: 'detail-sub-head' }, [
          el('span', { text: 'Sub-tasks' }),
          el('span', { class: 'count', text: doneSubs + '/' + task.subtasks.length })
        ]),
        el('ul', { class: 'sub-list', id: 'detail-subs' },
          task.subtasks.map(function (sub) { return subtaskRow(task, sub); })),
        el('div', { class: 'sub-add' }, [
          el('input', {
            class: 'text-input', type: 'text', maxlength: '200', placeholder: 'Add a sub-task and press Enter',
            'data-action': 'add-sub', 'data-id': task.id, 'data-focus-key': 'd:sub',
            'aria-label': 'New sub-task title'
          }),
          el('button', {
            type: 'button', class: 'btn ghost', text: 'Add',
            'data-action': 'add-sub-click', 'data-id': task.id
          })
        ])
      ]),

      orderRow(task),

      el('footer', { class: 'detail-actions' }, [
        el('button', {
          type: 'button', class: 'btn ghost danger', text: 'Delete',
          'data-action': 'delete-task', 'data-id': task.id
        }),
        el('button', {
          type: 'button', class: 'btn primary', text: 'Save changes', id: 'detail-save',
          'data-action': 'save-task', 'data-id': task.id, disabled: !dirty
        })
      ]),

      el('p', {
        class: 'detail-flag',
        text: dirty ? 'Unsaved changes \u2014 press Save.' : 'Saved automatically in this browser.'
      })
    ]));
  }
  /* ---------------- toasts ---------------- */

  function dismissToast(node) {
    if (!node || !node.parentNode) return;
    node.classList.add('is-leaving');
    global.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 200);
  }

  function showToast(message, undoLabel, undoFn) {
    var region = refs['toast-region'];
    if (!region) return null;
    var kids = [el('span', { class: 'toast-text', text: message })];
    if (undoLabel && typeof undoFn === 'function') {
      kids.push(el('button', { type: 'button', class: 'toast-undo', text: undoLabel, 'data-action': 'toast-undo' }));
    }
    var node = el('div', { class: 'toast', role: 'status' }, kids);
    if (typeof undoFn === 'function') node.__undo = undoFn;
    region.appendChild(node);
    while (region.children.length > 3) region.removeChild(region.firstChild);
    global.setTimeout(function () { dismissToast(node); }, undoFn ? 6000 : 3200);
    return node;
  }

  /** Wired to clicks on a toast's "Undo" button. */
  function undoToast(node) {
    var toast = node && node.closest ? node.closest('.toast') : null;
    if (!toast || typeof toast.__undo !== 'function') return false;
    var undo = toast.__undo;
    delete toast.__undo;
    dismissToast(toast);
    undo();
    return true;
  }

  function warnIfStorageUnavailable() {
    if (S.state.storageOk || view.warned) return false;
    view.warned = true;
    showToast('Storage is unavailable in this browser \u2014 tasks will not be saved between visits.');
    return true;
  }

  /* ---------------- render ---------------- */

  function render(reason) {
    if (!refs['task-list'] || !document.body.contains(refs['task-list'])) cacheRefs();
    var snapshot = reason === 'init' ? null : captureFocus();
    var tasks = S.visibleTasks();
    var counts = S.counts();
    renderToday();
    renderChrome(tasks, counts);
    renderList(tasks);
    renderDetail();
    restoreFocus(snapshot);
  }

  function focusElement(id) {
    var node = refs[id];
    if (!node) return false;
    try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
    if (typeof node.select === 'function' && node.select) {
      try { node.select(); } catch (err) { /* search input selects, buttons do not */ }
    }
    return true;
  }

  function closeDetail() {
    if (!S.selectedTask()) return false;
    clearDraft();
    S.selectTask(null);
    render();
    return true;
  }

  global.TodoUI = {
    refs: refs,
    view: view,
    cacheRefs: cacheRefs,
    render: render,
    renderToday: renderToday,
    focusElement: focusElement,
    closeDetail: closeDetail,
    hasDraft: hasDraft,
    draftPatch: draftPatch,
    editDraft: editDraft,
    commitDraft: commitDraft,
    revertDraft: revertDraft,
    showToast: showToast,
    undoToast: undoToast,
    warnIfStorageUnavailable: warnIfStorageUnavailable
  };
})(typeof window !== 'undefined' ? window : globalThis);
