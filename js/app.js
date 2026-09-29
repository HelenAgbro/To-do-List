/* ============================================================
   app.js — the controller: it wires DOM events to the store and
   keeps the view's own concerns (draft edits in the detail rail,
   focus, drag & drop, undo toasts, import/export, shortcuts).
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
    global.document.documentElement.setAttribute('data-theme', S.state.prefs.theme);
  }

  function taskById(id) {
    var list = S.state.tasks;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function focusNewTask() {
    UI.focusElement('new-task');
  }

  function focusRailTitle() {
    var input = refs.detail && refs.detail.querySelector('#detail-title');
    if (input) input.focus();
  }

  /* ---------------- adding ---------------- */

  function submitNewTask(event) {
    event.preventDefault();
    var input = refs['new-task'];
    var created = S.addTask({
      title: input.value,
      priority: refs['new-priority'].value,
      dueDate: refs['new-due'].value,
      tags: refs['new-tags'].value.split(',')
    });
    if (!created) {
      input.focus();
      return;
    }
    input.value = '';
    refs['new-due'].value = '';
    refs['new-tags'].value = '';
    /* Open the fresh task so notes, tags and sub-tasks can be added right away. */
    S.selectTask(created.id);
    input.focus();
    storageWarning();
  }

  /* ---------------- deletes ---------------- */

  function removeTask(id) {
    var removed = S.deleteTask(id);
    if (!removed) return;
    UI.showToast('Deleted \u201c' + removed.task.title + '\u201d', 'Undo', function () {
      S.restoreTask(removed.task, removed.index);
    });
    focusNewTask();
    storageWarning();
  }

  function removeSubtask(taskId, subId) {
    var removed = S.deleteSubtask(taskId, subId);
    if (!removed) return;
    UI.showToast('Deleted sub-task \u201c' + removed.subtask.title + '\u201d', 'Undo', function () {
      S.restoreSubtask(taskId, removed.subtask, removed.index);
    });
    var input = railSubInput(taskId);
    if (input) input.focus();
    storageWarning();
  }

  function railSubInput(taskId) {
    if (!refs.detail) return null;
    return refs.detail.querySelector('[data-action="add-sub"][data-id="' + taskId + '"]');
  }

  function addSubtaskFromInput(taskId, input) {
    if (!input) return;
    if (isBlank(input.value)) {
      input.focus();
      return;
    }
    S.addSubtask(taskId, input.value);
    var fresh = railSubInput(taskId);
    if (fresh) {
      fresh.value = '';
      fresh.focus();
    }
    storageWarning();
  }

  /** Write the rail draft (if any) and report what happened. */
  function saveDraft() {
    var patch = UI.draftPatch();
    if (!patch) {
      UI.render();
      return null;
    }
    if (isBlank(patch.title)) {
      UI.showToast('A task needs a title before it can be saved.');
      focusRailTitle();
      return null;
    }
    var saved = UI.commitDraft();
    if (saved) UI.showToast('Saved \u201c' + saved.title + '\u201d.');
    storageWarning();
    return saved;
  }
  /* ---------------- board (task rows) ---------------- */

  function onBoardClick(event) {
    var target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !refs['task-list'].contains(target)) return;

    var action = target.dataset.action;
    var id = target.dataset.id;
    var open = S.selectedTask();

    if (action === 'toggle-task') {
      S.toggleTask(id);
    } else if (action === 'select') {
      /* Clicking the open task again closes the rail. */
      S.selectTask(open && open.id === id ? null : id);
    } else if (action === 'move') {
      S.moveTask(id, target.dataset.dir);
    } else {
      return; /* the grip is handled by the drag handlers */
    }
    storageWarning();
  }

  /* ---------------- detail rail ---------------- */

  function onRailClick(event) {
    var target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !refs.detail || !refs.detail.contains(target)) return;

    var action = target.dataset.action;
    var id = target.dataset.id;
    var taskId = target.dataset.task || id;

    switch (action) {
      case 'toggle-sub':
        S.toggleSubtask(taskId, id);
        break;
      case 'delete-sub':
        removeSubtask(taskId, id);
        break;
      case 'add-sub-click':
        addSubtaskFromInput(taskId, railSubInput(taskId));
        break;
      case 'delete-task':
        removeTask(id);
        break;
      case 'close-detail':
        UI.closeDetail();
        break;
      case 'save-task':
        saveDraft();
        break;
      case 'move':
        S.moveTask(id, target.dataset.dir);
        break;
      default:
        break;
    }
    storageWarning();
  }

  function onRailInput(event) {
    var field = event.target.dataset ? event.target.dataset.field : null;
    if (field) UI.editDraft(field, event.target.value);
  }

  function onRailChange(event) {
    var field = event.target.dataset ? event.target.dataset.field : null;
    if (field) UI.editDraft(field, event.target.value);
  }

  function onRailKeydown(event) {
    var target = event.target;
    var action = target.dataset ? target.dataset.action : null;

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      var open = S.selectedTask();
      if (open) {
        event.preventDefault();
        S.moveTask(open.id, event.key === 'ArrowUp' ? 'up' : 'down');
        storageWarning();
      }
      return;
    }

    if (event.key === 'Enter') {
      if (action === 'add-sub') {
        event.preventDefault();
        addSubtaskFromInput(target.dataset.id, target);
      } else if (target.tagName === 'INPUT' && target.dataset && target.dataset.field) {
        event.preventDefault(); /* Enter saves instead of submitting anything */
        saveDraft();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      if (UI.hasDraft()) {
        UI.revertDraft();
        UI.showToast('Changes reverted.');
      } else {
        UI.closeDetail();
      }
      storageWarning();
    }
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

  /* ---------------- sidebar: views, lists and tags ---------------- */

  function onViewsClick(event) {
    var tab = event.target.closest ? event.target.closest('.tab[data-filter]') : null;
    if (tab) S.setFilter(tab.dataset.filter);
  }

  function onPriorityClick(event) {
    var facet = event.target.closest ? event.target.closest('.facet[data-priority]') : null;
    if (facet) S.setPriorityFilter(facet.dataset.priority);
  }

  function onTagClick(event) {
    var facet = event.target.closest ? event.target.closest('.facet[data-tag]') : null;
    if (!facet) return;
    var value = facet.dataset.tag;
    /* Clicking the tag that is already on clears it. */
    S.setTagFilter(value && value === S.state.prefs.tag ? '' : value);
  }
  /* ---------------- search & toolbar ---------------- */

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
    focusNewTask();
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

  /** Clicks on a toast's "Undo" button. */
  function onToastClick(event) {
    var button = event.target.closest ? event.target.closest('[data-action="toast-undo"]') : null;
    if (button) UI.undoToast(button);
  }
  /* ---------------- global keyboard shortcuts ---------------- */

  function onGlobalKeydown(event) {
    var active = global.document.activeElement;
    var tag = active && active.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      !!(active && active.isContentEditable);

    /* Alt + arrows reorder the task that is open in the rail */
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (typing) return; /* the rail handler covers edits made from inside a field */
      var open = S.selectedTask();
      if (open) {
        event.preventDefault();
        S.moveTask(open.id, event.key === 'ArrowUp' ? 'up' : 'down');
        storageWarning();
      }
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Escape') {
      if (UI.hasDraft()) {
        UI.revertDraft();
      } else if (refs.search.value) {
        clearSearch();
      } else if (typing && active.blur) {
        active.blur();
      }
      return;
    }

    if (typing) return;

    if (event.key === 'n' || event.key === 'N' || event.key === '+') {
      event.preventDefault();
      focusNewTask();
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

    refs['task-list'].addEventListener('click', onBoardClick);
    refs['task-list'].addEventListener('dragstart', onDragStart);
    refs['task-list'].addEventListener('dragover', onDragOver);
    refs['task-list'].addEventListener('dragleave', clearDropHints);
    refs['task-list'].addEventListener('drop', onDrop);
    refs['task-list'].addEventListener('dragend', endDrag);

    refs.detail.addEventListener('click', onRailClick);
    refs.detail.addEventListener('input', onRailInput);
    refs.detail.addEventListener('change', onRailChange);
    refs.detail.addEventListener('keydown', onRailKeydown);

    refs.views.addEventListener('click', onViewsClick);
    refs['pri-list'].addEventListener('click', onPriorityClick);
    refs['tag-list'].addEventListener('click', onTagClick);

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

    refs['toast-region'].addEventListener('click', onToastClick);
    global.document.addEventListener('keydown', onGlobalKeydown);
  }

  function boot() {
    UI.cacheRefs();
    wire();
    S.subscribe(function (reason) { UI.render(reason); });
    applyTheme();
    S.init();               /* reads storage and emits "init" → first paint */
    UI.renderToday();
    storageWarning();
    focusNewTask();
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(typeof window !== 'undefined' ? window : globalThis);
