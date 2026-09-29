/* ============================================================
   ui.js — renders state into the DOM.
   All user text is inserted with textContent / createTextNode
   (never innerHTML), so task titles can never inject markup.
   Exposes window.TodoUI.
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.TodoStore;

  var refs = {};

  /** Transient view-only state (which row is in "rename" mode). */
  var view = {
    editingTask: null,
    editingSub: null,      /* { taskId, subId } */
    selectOnRender: null   /* focus-key that should be fully selected once rendered */
  };

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

  function cacheRefs() {
    [
      'today', 'theme-btn', 'theme-icon', 'export-btn', 'import-btn', 'import-file', 'reset-btn',
      'add-form', 'new-task', 'new-priority', 'new-due',
      'summary-text', 'progress', 'progress-bar', 'toggle-all',
      'search', 'search-clear', 'sort', 'clear-completed',
      'task-list', 'empty', 'empty-title', 'empty-text', 'toast-region'
    ].forEach(function (id) {
      refs[id] = document.getElementById(id);
    });
    refs.tabs = Array.prototype.slice.call(document.querySelectorAll('.tab[data-filter]'));
    refs.counts = Array.prototype.slice.call(document.querySelectorAll('.count[data-count]'));
    return refs;
  }

  /* ---------------- focus + draft preservation ----------------
     The list is re-rendered wholesale on every change. To keep typing
     (and the caret) intact we remember the focused control and any
     half-typed text, then put both back afterwards.              */

  function captureFocus() {
    var node = document.activeElement;
    if (!node || !node.dataset || !node.dataset.focusKey || !refs['task-list'].contains(node)) return null;
    var snapshot = { key: node.dataset.focusKey, tag: node.tagName };
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
    var node = refs['task-list'].querySelector('[data-focus-key="' + cssEscape(snapshot.key) + '"]');
    if (!node) return;
    try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
    if (view.selectOnRender === snapshot.key && typeof node.select === 'function') {
      node.select();
      view.selectOnRender = null;
    } else if (snapshot.start != null && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(snapshot.start, snapshot.end); } catch (err) { /* not selectable */ }
    }
  }

  function cssEscape(value) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(value);
    return String(value).replace(/["\\\[\]:]/g, '\\$&');
  }

  function captureDrafts() {
    var drafts = {};
    Array.prototype.forEach.call(refs['task-list'].querySelectorAll('[data-draft]'), function (node) {
      if (node.value) drafts[node.dataset.focusKey] = node.value;
    });
    return drafts;
  }

  function restoreDrafts(drafts) {
    Object.keys(drafts).forEach(function (key) {
      var node = refs['task-list'].querySelector('[data-focus-key="' + cssEscape(key) + '"]');
      if (node && typeof node.value === 'string' && node.value === '') node.value = drafts[key];
    });
  }

  /* ---------------- edit-mode helpers ---------------- */

  function beginEditTask(id) {
    if (view.editingTask === id && !view.editingSub) return false;
    view.editingTask = id;
    view.editingSub = null;
    view.selectOnRender = 'edit:t:' + id;
    render('edit');
    return true;
  }

  function beginEditSub(taskId, subId) {
    if (view.editingTask !== taskId) view.editingTask = taskId;
    if (view.editingSub && view.editingSub.subId === subId && view.editingTask === taskId) return false;
    view.editingSub = { taskId: taskId, subId: subId };
    view.selectOnRender = 'edit:s:' + taskId + ':' + subId;
    render('edit');
    return true;
  }

  function closeEdit() {
    if (!view.editingTask && !view.editingSub) return false;
    var wasEditing = !!(view.editingTask || view.editingSub);
    view.editingTask = null;
    view.editingSub = null;
    view.selectOnRender = null;
    if (wasEditing) render('edit');
    return wasEditing;
  }

  /* ---------------- list rendering ---------------- */

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

  function titleNode(task) {
    if (view.editingTask === task.id) {
      return el('input', {
        class: 'edit-input',
        type: 'text',
        maxlength: '200',
        value: task.title,
        'data-action': 'save-task-title',
        'data-id': task.id,
        'data-focus-key': 'edit:t:' + task.id,
        'aria-label': 'Edit task title'
      });
    }
    return el('button', {
      type: 'button',
      class: 'task-title',
      text: task.title,
      'data-action': 'edit-task',
      'data-id': task.id,
      'data-focus-key': 'title:' + task.id,
      title: 'Click to edit'
    });
  }

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
    if (task.notes) chips.push(chip('\u00b6 notes', 'note'));
    return el('div', { class: 'task-meta' }, chips);
  }

  function orderControls(task) {
    return el('div', { class: 'detail-grid' }, [
      el('span', { class: 'field', text: 'Order' }),
      el('button', {
        type: 'button', class: 'act', text: '\u2191', 'data-action': 'move', 'data-dir': 'up',
        'data-id': task.id, title: 'Move up (Alt + \u2191)', 'aria-label': 'Move task up'
      }),
      el('button', {
        type: 'button', class: 'act', text: '\u2193', 'data-action': 'move', 'data-dir': 'down',
        'data-id': task.id, title: 'Move down (Alt + \u2193)', 'aria-label': 'Move task down'
      }),
      el('button', {
        type: 'button', class: 'btn ghost', text: 'To top', 'data-action': 'move', 'data-dir': 'top',
        'data-id': task.id, title: 'Move to the top of the list'
      }),
      el('button', {
        type: 'button', class: 'btn ghost', text: 'To bottom', 'data-action': 'move', 'data-dir': 'bottom',
        'data-id': task.id, title: 'Move to the bottom of the list'
      })
    ]);
  }

  function subtaskRow(taskId, sub) {
    var editing = !!(view.editingSub && view.editingSub.subId === sub.id);
    return el('li', {
      class: 'subtask' + (sub.completed ? ' is-done' : '') + (editing ? ' is-editing' : ''),
      'data-id': sub.id,
      'data-task': taskId
    }, [
      checkbox(sub.completed, 'toggle-sub', 'scheck:' + taskId + ':' + sub.id, false,
        { id: sub.id, task: taskId }),
      editing
        ? el('input', {
            class: 'edit-input',
            type: 'text',
            maxlength: '200',
            value: sub.title,
            'data-action': 'save-sub-title',
            'data-task': taskId,
            'data-id': sub.id,
            'data-focus-key': 'edit:s:' + taskId + ':' + sub.id,
            'aria-label': 'Edit sub-task title'
          })
        : el('button', {
            type: 'button',
            class: 'subtask-title',
            text: sub.title,
            'data-action': 'edit-sub',
            'data-task': taskId,
            'data-id': sub.id,
            'data-focus-key': 'stitle:' + taskId + ':' + sub.id,
            title: 'Click to edit'
          }),
      el('button', {
        type: 'button', class: 'act danger', text: '\u00d7', 'data-action': 'delete-sub',
        'data-task': taskId, 'data-id': sub.id, title: 'Delete sub-task', 'aria-label': 'Delete sub-task'
      })
    ]);
  }

  function detailsPanel(task) {
    var done = task.subtasks.filter(function (s) { return s.completed; }).length;

    var fields = el('div', { class: 'detail-grid' }, [
      el('span', { class: 'field' }, [
        el('span', { text: 'Priority' }),
        el('select', {
          'data-action': 'set-priority', 'data-id': task.id, 'data-focus-key': 'pri:' + task.id,
          'aria-label': 'Priority for ' + task.title
        }, S.PRIORITIES.map(function (value) {
          return el('option', {
            value: value,
            text: value.charAt(0).toUpperCase() + value.slice(1),
            selected: task.priority === value ? true : null
          });
        }))
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Due' }),
        el('input', {
          type: 'date', value: task.dueDate || '',
          'data-action': 'set-due', 'data-id': task.id, 'data-focus-key': 'due:' + task.id,
          'aria-label': 'Due date for ' + task.title
        })
      ]),
      el('button', {
        type: 'button', class: 'btn ghost', text: '\u00d7 Clear due date',
        'data-action': 'clear-due', 'data-id': task.id, hidden: task.dueDate ? null : true
      })
    ]);

    return el('div', { class: 'task-details' }, [
      fields,
      el('textarea', {
        class: 'notes',
        placeholder: 'Notes (optional)',
        'data-action': 'set-notes',
        'data-id': task.id,
        'data-draft': 'notes',
        'data-focus-key': 'notes:' + task.id,
        'aria-label': 'Notes for ' + task.title,
        text: task.notes
      }),
      el('div', { class: 'subtask-head' }, [
        el('span', { text: 'Sub-tasks' }),
        el('span', { text: task.subtasks.length ? done + ' of ' + task.subtasks.length + ' done' : 'none yet' })
      ]),
      el('ul', { class: 'subtask-list' }, task.subtasks.map(function (sub) {
        return subtaskRow(task.id, sub);
      })),
      el('div', { class: 'add-subtask' }, [
        el('input', {
          type: 'text', maxlength: '200', placeholder: 'Add a sub-task and press Enter',
          'data-action': 'add-sub', 'data-id': task.id, 'data-draft': 'addsub',
          'data-focus-key': 'addsub:' + task.id, 'aria-label': 'New sub-task for ' + task.title
        }),
        el('button', {
          type: 'button', class: 'btn', text: 'Add', 'data-action': 'add-sub-click', 'data-id': task.id
        })
      ]),
      orderControls(task)
    ]);
  }

  function taskItem(task, options) {
    var open = !!task.expanded;
    var mixed = !task.completed && task.subtasks.length > 0 &&
      task.subtasks.some(function (s) { return s.completed; });

    return el('li', {
      class: 'task' + (task.completed ? ' is-done' : '') + (open ? ' is-open' : '') +
        (view.editingTask === task.id ? ' is-editing' : ''),
      'data-id': task.id
    }, [
      el('div', { class: 'task-main' }, [
        el('button', {
          type: 'button', class: 'grip', text: '\u2807', draggable: options.sortable ? 'true' : null,
          'data-action': 'grip', 'data-id': task.id,
          title: 'Drag to reorder \u00b7 Alt + \u2191 / \u2193',
          'aria-label': 'Drag handle for ' + task.title
        }),
        checkbox(task.completed, 'toggle-task', 'check:' + task.id, mixed, { id: task.id }),
        el('div', { class: 'task-body' }, [titleNode(task), metaRow(task)]),
        el('div', { class: 'task-actions' }, [
          el('button', {
            type: 'button', class: 'act expand', 'data-action': 'expand', 'data-id': task.id,
            'data-focus-key': 'expand:' + task.id,
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': (open ? 'Hide details for ' : 'Show details for ') + task.title,
            title: open ? 'Hide details' : 'Details, notes and sub-tasks',
            text: ''
          }, el('span', { class: 'caret', 'aria-hidden': 'true', text: '\u25b8' })),
          el('button', {
            type: 'button', class: 'act', text: '\u270e', 'data-action': 'edit-task', 'data-id': task.id,
            title: 'Edit title', 'aria-label': 'Edit ' + task.title
          }),
          el('button', {
            type: 'button', class: 'act danger', text: '\u00d7', 'data-action': 'delete-task', 'data-id': task.id,
            title: 'Delete task', 'aria-label': 'Delete ' + task.title
          })
        ])
      ]),
      open ? detailsPanel(task) : null
    ]);
  }

  function renderList(tasks) {
    var list = refs['task-list'];
    clearNode(list);
    var sortable = S.state.prefs.sort === 'manual' && !S.state.query.trim();
    tasks.forEach(function (task) {
      list.appendChild(taskItem(task, { sortable: sortable }));
    });
  }

  /* ---------------- chrome: summary, tabs, empty state ---------------- */

  function renderSummary(counts) {
    var box = refs['summary-text'];
    clearNode(box);
    box.appendChild(el('strong', { text: String(counts.active) }));
    box.appendChild(document.createTextNode(counts.active === 1 ? ' task left' : ' tasks left'));
    box.appendChild(el('span', { class: 'sep', text: '\u00b7' }));
    box.appendChild(document.createTextNode(counts.completed + ' done'));
    if (counts.subtasks) {
      box.appendChild(el('span', { class: 'sep', text: '\u00b7' }));
      box.appendChild(document.createTextNode(counts.subtasksDone + '/' + counts.subtasks + ' sub-tasks'));
    }
    if (counts.overdue) {
      box.appendChild(el('span', { class: 'sep', text: '\u00b7' }));
      box.appendChild(el('span', { class: 'overdue', text: counts.overdue + ' overdue' }));
    }

    refs['progress-bar'].style.width = counts.percent + '%';
    refs.progress.setAttribute('aria-valuenow', String(counts.percent));
    refs['toggle-all'].disabled = counts.total === 0 || counts.active === 0;
    refs['clear-completed'].disabled = counts.completed === 0;
  }

  function renderTabs(counts) {
    refs.tabs.forEach(function (tab) {
      var isActive = tab.dataset.filter === S.state.prefs.filter;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    var values = { all: counts.total, active: counts.active, completed: counts.completed };
    refs.counts.forEach(function (node) {
      node.textContent = values[node.dataset.count] == null ? '' : String(values[node.dataset.count]);
    });
  }

  function renderEmpty(visibleCount) {
    var filter = S.state.prefs.filter;
    var query = S.state.query.trim();
    var total = S.state.tasks.length;
    var show = visibleCount === 0;

    refs.empty.hidden = !show;
    refs['task-list'].hidden = show;
    if (!show) return;

    if (query) {
      refs['empty-title'].textContent = 'No matches';
      refs['empty-text'].textContent = 'Nothing matches \u201c' + query + '\u201d.';
    } else if (!total) {
      refs['empty-title'].textContent = 'All clear';
      refs['empty-text'].textContent = 'Add your first task above to get started.';
    } else if (filter === 'active') {
      refs['empty-title'].textContent = 'Nothing left to do';
      refs['empty-text'].textContent = 'Every task is done \u2014 enjoy the quiet.';
    } else if (filter === 'completed') {
      refs['empty-title'].textContent = 'Nothing done yet';
      refs['empty-text'].textContent = 'Tick a task off and it will show up here.';
    } else {
      refs['empty-title'].textContent = 'No tasks yet';
      refs['empty-text'].textContent = 'Use the box above to add one.';
    }
  }

  function renderChrome(tasks, counts) {
    renderSummary(counts);
    renderTabs(counts);
    renderEmpty(tasks.length);

    var theme = S.state.prefs.theme;
    refs['theme-icon'].textContent = theme === 'light' ? '\u2600' : theme === 'dark' ? '\u263e' : '\u25d0';
    refs['theme-btn'].title = 'Theme: ' + theme + ' \u2014 click to change';

    if (refs.sort.value !== S.state.prefs.sort) refs.sort.value = S.state.prefs.sort;
    refs['search-clear'].hidden = !S.state.query;
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

  /* ---------------- render ---------------- */

  function render() {
    if (!refs['task-list']) return;
    var tasks = S.visibleTasks();
    var counts = S.counts();
    var focus = captureFocus();
    var drafts = captureDrafts();

    renderToday();
    renderList(tasks);
    renderChrome(tasks, counts);

    restoreDrafts(drafts);
    restoreFocus(focus);
  }

  /* ---------------- toasts ---------------- */

  function showToast(message, actionLabel, onAction) {
    if (!refs['toast-region']) return null;
    var button = actionLabel ? el('button', { type: 'button', class: 'btn', text: actionLabel }) : null;
    var toast = el('div', { class: 'toast' }, [el('span', { class: 'msg', text: message }), button]);
    refs['toast-region'].appendChild(toast);

    var timer = global.setTimeout(dismiss, 6000);
    function dismiss() {
      global.clearTimeout(timer);
      if (!toast.parentNode) return;
      toast.classList.add('out');
      global.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 200);
    }
    if (button && typeof onAction === 'function') {
      button.addEventListener('click', function () {
        dismiss();
        onAction();
      });
    }
    return dismiss;
  }

  function warnIfStorageUnavailable() {
    if (!S.state.storageOk) {
      showToast('This browser blocks storage, so changes will be lost when you reload.');
    }
  }

  /* ---------------- public API ---------------- */

  global.TodoUI = {
    refs: refs,
    view: view,
    el: el,
    cacheRefs: cacheRefs,
    render: render,
    renderToday: renderToday,
    beginEditTask: beginEditTask,
    beginEditSub: beginEditSub,
    closeEdit: closeEdit,
    showToast: showToast,
    warnIfStorageUnavailable: warnIfStorageUnavailable
  };

})(typeof window !== 'undefined' ? window : globalThis);





