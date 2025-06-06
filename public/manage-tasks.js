let editing = null;
function loadTasks() {
  fetch('/tasks').then(r => r.json()).then(res => {
    const rows = res.tasks.map(function(t) {
      const isA00 = t.name === 'A00铝';
      const safeName = t.name.replace(/'/g, "\\'");
      return '<tr><td>' + t.name + '</td><td>' + t.url + '</td><td>' + t.selector + '</td><td>' +
        '<button class="edit-btn" onclick="editTask(\'' + safeName + '\')">编辑</button>' +
        (isA00
          ? '<button class="del-btn" disabled style="opacity:0.5;cursor:not-allowed;">不可删</button>'
          : '<button class="del-btn" onclick="delTask(\'' + safeName + '\')">删除</button>') +
        '</td></tr>';
    }).join('');
    document.getElementById('taskTable').innerHTML = rows;
  });
}
function addTask() {
  const name = document.getElementById('name').value.trim();
  const url = document.getElementById('url').value.trim();
  const selector = document.getElementById('selector').value.trim();
  if (!name || !url || !selector) { showMsg('请填写完整', false, true); return; }
  if (editing) { updateTask(); return; }
  fetch('/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, selector })
  }).then(r => r.json()).then(res => {
    showMsg(res.message, res.success, true);
    if (res.success) {
      document.getElementById('name').value = '';
      document.getElementById('url').value = '';
      document.getElementById('selector').value = '';
      editing = null;
      document.getElementById('addBtn').textContent = '添加';
      loadTasks();
    }
  });
}
function editTask(name) {
  fetch('/tasks').then(r => r.json()).then(res => {
    const t = res.tasks.find(x => x.name === name);
    if (!t) return;
    document.getElementById('name').value = t.name;
    document.getElementById('url').value = t.url;
    document.getElementById('selector').value = t.selector;
    editing = t.name;
    document.getElementById('addBtn').textContent = '保存';
  });
}
function updateTask() {
  const oldName = editing;
  const name = document.getElementById('name').value.trim();
  const url = document.getElementById('url').value.trim();
  const selector = document.getElementById('selector').value.trim();
  fetch('/tasks', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, name, url, selector })
  }).then(r => r.json()).then(res => {
    showMsg(res.message, res.success, true);
    if (res.success) {
      document.getElementById('name').value = '';
      document.getElementById('url').value = '';
      document.getElementById('selector').value = '';
      editing = null;
      document.getElementById('addBtn').textContent = '添加';
      loadTasks();
    }
  });
}
function delTask(name) {
  if (!confirm('确定要删除 ' + name + ' 吗？')) return;
  fetch('/tasks', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(r => r.json()).then(res => {
    showMsg(res.message, res.success, true);
    if (res.success) loadTasks();
  });
}
function showMsg(msg, ok, alertUser) {
  const el = document.getElementById('msg');
  el.textContent = (ok ? '已生效：' : '未生效：') + msg;
  el.className = ok ? 'msg success' : 'msg';
  if (alertUser) alert((ok ? '已生效：' : '未生效：') + msg);
  setTimeout(() => { el.textContent = ''; }, 2000);
}
loadTasks();