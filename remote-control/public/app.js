let token = '';
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function api(path, options = {}) {
  if (!token) throw new Error('Operator token required');
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function setConnection(ok, text) {
  $('connection').textContent = text;
  $('connection').className = ok ? 'badge good' : 'badge';
}

async function loadDevices() {
  const { devices } = await api('/v1/devices');
  if (!devices.length) return void ($('devices').innerHTML = '<p class="empty">No paired devices.</p>');
  $('devices').innerHTML = `<table><thead><tr><th>Device</th><th>Status</th><th>Tools</th><th>Last seen</th><th></th></tr></thead><tbody>${devices.map((d) => `
    <tr><td><strong>${escapeHtml(d.name)}</strong><br><span>${escapeHtml(d.platform || '')}</span></td><td><span class="state ${escapeHtml(d.status)}">${escapeHtml(d.status)}</span></td><td>${Number(d.toolCount || 0)}</td><td>${escapeHtml(d.lastSeen || 'Never')}</td><td>${d.status !== 'revoked' ? `<button class="danger revoke" data-id="${escapeHtml(d.id)}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  for (const button of document.querySelectorAll('.revoke')) button.addEventListener('click', async () => {
    if (!confirm('Revoke this device? Its current device token will stop working.')) return;
    await api(`/v1/devices/${encodeURIComponent(button.dataset.id)}/revoke`, { method: 'POST', body: '{}' });
    await loadDevices();
  });
}

async function loadCalls() {
  const { calls } = await api('/v1/calls?limit=80');
  if (!calls.length) return void ($('calls').innerHTML = '<p class="empty">No remote calls yet.</p>');
  $('calls').innerHTML = `<table><thead><tr><th>Tool</th><th>Status</th><th>Policy</th><th>Created</th><th></th></tr></thead><tbody>${calls.map((c) => `
    <tr><td><strong>${escapeHtml(c.toolName)}</strong><br><span>${escapeHtml(c.id)}</span></td><td><span class="state ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td><td>${escapeHtml(c.policy?.capability || '')} / ${escapeHtml(c.policy?.decision || '')}</td><td>${escapeHtml(c.createdAt)}</td><td>${c.status === 'awaiting_approval' ? `<button class="approve" data-id="${escapeHtml(c.id)}">Approve</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  for (const button of document.querySelectorAll('.approve')) button.addEventListener('click', async () => {
    if (!confirm('Approve this remote operation? Review the originating AI conversation before continuing.')) return;
    await api(`/v1/calls/${encodeURIComponent(button.dataset.id)}/approve`, { method: 'POST', body: '{}' });
    await loadCalls();
  });
}

async function refreshAll() {
  try {
    await Promise.all([loadDevices(), loadCalls()]);
    setConnection(true, 'Authenticated');
  } catch (error) {
    setConnection(false, error.message);
    throw error;
  }
}

$('connect').addEventListener('click', async () => {
  token = $('token').value.trim();
  $('token').value = '';
  try { await refreshAll(); } catch { token = ''; }
});
$('disconnect').addEventListener('click', () => {
  token = '';
  setConnection(false, 'Not authenticated');
  $('devices').innerHTML = '<p class="empty">Authenticate to load devices.</p>';
  $('calls').innerHTML = '<p class="empty">Authenticate to load calls.</p>';
});
$('refresh-devices').addEventListener('click', () => loadDevices().catch((error) => setConnection(false, error.message)));
$('refresh-calls').addEventListener('click', () => loadCalls().catch((error) => setConnection(false, error.message)));
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/v1/pairings/approve', { method: 'POST', body: JSON.stringify({ user_code: $('pair-code').value.trim().toUpperCase() }) });
    $('pair-status').textContent = `Approved ${result.deviceName}.`;
    $('pair-code').value = '';
  } catch (error) { $('pair-status').textContent = error.message; }
});
$('verify').addEventListener('click', async () => {
  try {
    const { audit } = await api('/v1/audit/verify');
    $('audit-status').textContent = audit.valid ? `Valid chain · ${audit.count} receipts` : `Audit verification failed at receipt ${audit.index}`;
  } catch (error) { $('audit-status').textContent = error.message; }
});
