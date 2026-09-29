/* ============================================================
   app.js — wires the DOM to the store: events, drag & drop,
   undo toasts, import/export and keyboard shortcuts.
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.TodoStore;
  var UI = global.TodoUI;
  var refs = UI.refs;

  function isBlank(value) {
    return !value || !String(value).replace(/\s+/g, '');
  }

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function storageWarning() {
    if (!S.state.storageOk) UI.warnIfStorageUnavailable();
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', S.state.prefs.theme);
  }

  /* ---------------- adding ---------------- */

  function submitNewTask(event) {
    event.preventDefault();
    var input = refs['new-task'];
    var created = S.addTask({
      title: input.value,
      priority: refs['new-priority'].value,
      dueDate: refs['new-due'].value
    });
    if (!created) {
      input.focus();
      return;
    }
    input.value = '';
    refs['new-due'].value = '';
    input.focus();
    storageWarning();
  }

  function addSubtaskFromInput(taskId, input) {
    if (!input) return;
    if (isBlank(input.value)) {
      input.focus();
      return;
    }
    S.addSubtask(taskId, input.value);
    var fresh = refs['task-list'].querySelector('[data-action="add-sub"][data-id="' + taskId + '"]');
    if (fresh) {
      fresh.value = '';
      fresh.focus();
    }
    storageWarning();
  }

  /* ---------------- commit helpers ----------------
     closeEdit() runs *before* the write so that "blur commits" and a
     click on another control can never apply the same edit twice.     */

  function commitTaskTitle(input) {
    var id = input.dataset.id;
    if (UI.view.editingTask !== id) return;
    var value = input.value;
    UI.closeEdit();
    if (!isBlank(value)) S.updateTask(id, { title: value });
    storageWarning();
  }

  function commitSubTitle(input) {
    var taskId = input.dataset.task;
    var subId = input.dataset.id;
    if (!UI.view.editingSub || UI.view.editingSub.subId !== subId) return;
    var value = input.value;
    UI.closeEdit();
    if (!isBlank(value)) S.updateSubtask(taskId, subId, { title: value });
    storageWarning();
  }

  function removeTask(id) {
    var removed = S.deleteTask(id);
    if (!removed) return;
    UI.showToast('Deleted \u201c' + removed.task.title + '\u201d', 'Undo', function () {
      S.restoreTask(removed.task, removed.index);
    });
    storageWarning();
  }

  function removeSubtask(taskId, subId) {
    var removed = S.deleteSubtask(taskId, subId);
    if (!removed) return;
    UI.showToast('Deleted sub-task \u201c' + removed.subtask.title + '\u201d', 'Undo', function () {
      S.restoreSubtask(taskId, removed.subtask, removed.index);
    });
    storageWarning();
  }

  /* ---------------- delegated list events ---------------- */

  function onListClick(event) {
    var target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !refs['task-list'].contains(target)) return;

    var action = target.dataset.action;
    var id = target.dataset.id;
    var taskId = target.dataset.task || id;
    var task;

    switch (action) {
      case 'toggle-task':
        S.toggleTask(id);
        break;
      case 'expand':
        task = S.state.tasks.filter(function (t) { return t.id === id; })[0];
        if (task) S.updateTask(id, { expanded: !task.expanded });
        break;
      case 'edit-task':
        UI.beginEditTask(id);
        break;
      case 'delete-task':
        removeTask(id);
        break;
      case 'toggle-sub':
        S.toggleSubtask(taskId, id);
        break;
      case 'edit-sub':
        UI.beginEditSub(taskId, id);
        break;
      case 'delete-sub':
        removeSubtask(taskId, id);
        break;
      case 'add-sub-click':
        addSubtaskFromInput(id, refs['task-list'].querySelector('[data-action="add-sub"][data-id="' + id + '"]'));
        break;
      case 'move':
        S.moveTask(id, target.dataset.dir);
        break;
      case 'clear-due':
        S.updateTask(id, { dueDate: null });
        break;
      default:
        break; /* grip and inputs are handled by the drag / key handlers */
    }
    storageWarning();
  }

  function onListKeydown(event) {
    var target = event.target;
    var action = target.dataset ? target.dataset.action : null;
    if (!action) return;

    if (event.key === 'Enter') {
      if (action === 'add-sub') {
        event.preventDefault();
        addSubtaskFromInput(target.dataset.id, target);
      } else if (action === 'save-task-title') {
        event.preventDefault();
        commitTaskTitle(target);
      } else if (action === 'save-sub-title') {
        event.preventDefault();
        commitSubTitle(target);
      }
    } else if (event.key === 'Escape') {
      if (action === 'save-task-title' || action === 'save-sub-title') {
        event.preventDefault();
        UI.closeEdit();
      } else if (action === 'add-sub') {
        target.value = '';
        target.blur();
      }
    }
  }

  /** Blur commits a rename; after Escape the edit mode is gone so this no-ops. */
  function onListFocusOut(event) {
    var action = event.target.dataset ? event.target.dataset.action : null;
    if (action === 'save-task-title') commitTaskTitle(event.target);
    else if (action === 'save-sub-title') commitSubTitle(event.target);
  }

  var notesTimer = null;

  function onListInput(event) {
    var target = event.target;
    if (target.dataset && target.dataset.action === 'set-notes') {
      var id = target.dataset.id;
      var value = target.value;
      global.clearTimeout(notesTimer);
      notesTimer = global.setTimeout(function () {
        S.updateTask(id, { notes: value });
        storageWarning();
      }, 350);
    }
  }

  function onListChange(event) {
    var target = event.target;
    var action = target.dataset ? target.dataset.action : null;
    if (action === 'set-priority') S.updateTask(target.dataset.id, { priority: target.value });
    else if (action === 'set-due') S.updateTask(target.dataset.id, { dueDate: target.value });
    else return;
    storageWarning();
  }

  /* ---------------- drag to reorder (manual sort only) ---------------- */

  var drag = { id: null };

  function clearDropHints() {
    Array.prototype.forEach.call(refs['task-list'].querySelectorAll('.drop-before, .drop-after'), function (node) {
      node.classList.remove('drop-before', 'drop-after');
    });
  }

  function onDragStart(event) {
    var grip = event.target.closest ? event.target.closest('.grip[draggable="true"]') : null;
    if (!grip) {
      event.preventDefault();
      return;
    }
    drag.id = grip.dataset.id;
    var item = grip.closest('.task');
    if (item) item.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', drag.id); } catch (err) { /* older browsers */ }
    }
  }

  /** Nearest list item to the pointer — also works in the gaps and past the last row. */
  function nearestItem(clientY) {
    var items = refs['task-list'].children;
    var best = null;
    var bestDistance = Infinity;
    var bestPlace = 'before';
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.id === drag.id) continue;
      var box = items[i].getBoundingClientRect();
      var middle = box.top + box.height / 2;
      var distance = Math.abs(clientY - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = items[i];
        bestPlace = clientY < middle ? 'before' : 'after';
      }
    }
    return best ? { item: best, place: bestPlace } : null;
  }

  function onDragOver(event) {
    if (!drag.id) return;
    clearDropHints();
    var target = nearestItem(event.clientY);
    if (!target) return;
    target.item.classList.add(target.place === 'before' ? 'drop-before' : 'drop-after');
    if (event.preventDefault) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }
  }

  function onDrop(event) {
    if (!drag.id) return;
    if (event.preventDefault) event.preventDefault();
    var target = nearestItem(event.clientY);
    if (target) {
      S.moveRelative(drag.id, target.item.dataset.id, target.place);
      storageWarning();
    }
    endDrag();
  }

  function endDrag() {
    drag.id = null;
    clearDropHints();
    Array.prototype.forEach.call(refs['task-list'].querySelectorAll('.is-dragging'), function (node) {
      node.classList.remove('is-dragging');
    });
  }

  /* ---------------- toolbar / chrome controls ---------------- */

  function onFilterClick(event) {
    var tab = event.target.closest ? event.target.closest('.tab[data-filter]') : null;
    if (tab) S.setFilter(tab.dataset.filter);
  }

  function onSearchInput(event) {
    S.setQuery(event.target.value);
  }

  function clearSearch() {
    refs.search.value = '';
    S.setQuery('');
    refs.search.focus();
  }

  function onToggleAll() {
    var snapshot = S.markAll(true);
    if (!snapshot) return;
    UI.showToast('Marked every task as done', 'Undo', function () {
      S.restoreAll(snapshot);
    });
    storageWarning();
  }

  function onClearCompleted() {
    var removed = S.clearCompleted();
    if (!removed) return;
    UI.showToast('Removed ' + plural(removed.length, 'completed task'), 'Undo', function () {
      S.restoreMany(removed);
    });
    storageWarning();
  }

  function onReset() {
    var total = S.state.tasks.length;
    if (!total) return;
    if (!global.confirm('Delete all ' + plural(total, 'task') + '? You will have 6 seconds to undo.')) return;
    var snapshot = S.wipe();
    UI.showToast('Deleted ' + plural(total, 'task'), 'Undo', function () {
      S.restoreAll(snapshot);
    });
    storageWarning();
  }

  function exportJson() {
    var text = S.exportText();
    try {
      var blob = new global.Blob([text], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var link = global.document.createElement('a');
      link.href = url;
      link.download = 'tasks-' + S.todayStr() + '.json';
      global.document.body.appendChild(link);
      link.click();
      global.document.body.removeChild(link);
      global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1500);
      UI.showToast('Exported ' + plural(S.state.tasks.length, 'task') + ' as JSON.');
    } catch (err) {
      UI.showToast('Export is not supported in this browser.');
    }
  }

  function onImportFile(event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = ''; /* allow re-picking the same file later */
    if (!file) return;
    if (typeof global.FileReader !== 'function') {
      UI.showToast('Import is not supported in this browser.');
      return;
    }
    var reader = new global.FileReader();
    reader.onload = function () {
      var result = S.importText(String(reader.result), 'merge');
      UI.showToast(result.ok ? 'Imported ' + plural(result.count, 'task') + '.' : 'Import failed: ' + result.error);
      storageWarning();
    };
    reader.onerror = function () {
      UI.showToast('Could not read that file.');
    };
    reader.readAsText(file);
  }

  /* ---------------- global keyboard shortcuts ---------------- */

  function onGlobalKeydown(event) {
    var active = global.document.activeElement;
    var tag = active && active.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      !!(active && active.isContentEditable);

    /* Alt + arrows reorder the task that currently has focus */
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      var item = active && active.closest ? active.closest('.task') : null;
      if (item && item.dataset.id) {
        event.preventDefault();
        S.moveTask(item.dataset.id, event.key === 'ArrowUp' ? 'up' : 'down');
        storageWarning();
      }
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Escape') {
      if (active && active.dataset && active.dataset.action &&
          active.dataset.action.indexOf('save-') === 0) {
        return; /* the list handler already cancelled this rename */
      }
      if (UI.view.editingTask || UI.view.editingSub) {
        UI.closeEdit();
      } else if (typing && active.blur) {
        active.blur();
      }
      return;
    }

    if (typing) return;

    if (event.key === 'n' || event.key === 'N' || event.key === '+') {
      event.preventDefault();
      refs['new-task'].focus();
    } else if (event.key === '/') {
      event.preventDefault();
      refs.search.focus();
      refs.search.select();
    } else if (event.key === '?') {
      event.preventDefault();
      var details = global.document.querySelector('.foot details');
      if (details) details.open = !details.open;
    }
  }

  /* ---------------- boot ---------------- */

  function wire() {
    refs['add-form'].addEventListener('submit', submitNewTask);

    refs['task-list'].addEventListener('click', onListClick);
    refs['task-list'].addEventListener('keydown', onListKeydown);
    refs['task-list'].addEventListener('focusout', onListFocusOut);
    refs['task-list'].addEventListener('input', onListInput);
    refs['task-list'].addEventListener('change', onListChange);
    refs['task-list'].addEventListener('dragstart', onDragStart);
    refs['task-list'].addEventListener('dragover', onDragOver);
    refs['task-list'].addEventListener('dragleave', clearDropHints);
    refs['task-list'].addEventListener('drop', onDrop);
    refs['task-list'].addEventListener('dragend', endDrag);

    global.document.querySelector('.controls').addEventListener('click', onFilterClick);
    refs.search.addEventListener('input', onSearchInput);
    refs['search-clear'].addEventListener('click', clearSearch);
    refs.sort.addEventListener('change', function () { S.setSort(refs.sort.value); });
    refs['toggle-all'].addEventListener('click', onToggleAll);
    refs['clear-completed'].addEventListener('click', onClearCompleted);
    refs['theme-btn'].addEventListener('click', function () {
      S.cycleTheme();
      applyTheme();
    });
    refs['export-btn'].addEventListener('click', exportJson);
    refs['import-btn'].addEventListener('click', function () { refs['import-file'].click(); });
    refs['import-file'].addEventListener('change', onImportFile);
    refs['reset-btn'].addEventListener('click', onReset);

    global.document.addEventListener('keydown', onGlobalKeydown);
  }

  function boot() {
    UI.cacheRefs();
    wire();
    S.subscribe(function () { UI.render(); });
    S.init();               /* reads storage and emits "init" → first paint */
    applyTheme();
    UI.renderToday();
    storageWarning();
    try { refs['new-task'].focus(); } catch (err) { /* ignore */ }
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(typeof window !== 'undefined' ? window : globalThis);



