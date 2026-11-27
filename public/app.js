import qrcode from '/vendor/qrcode.mjs';

const THEME_LABELS = {
  obsidian: 'Obsidian',
  daylight: 'Daylight',
  emerald: 'Emerald'
};

const state = {
  settings: {},
  releases: [],
  feedback: [],
  team: [],
  activity: [],
  activeView: 'releases',
  stageFilter: 'All',
  fbFilter: 'All',
  searchQuery: '',
  isLeadMode: sessionStorage.getItem('dsl_lead_mode') === 'true',
  inspectedReleaseId: null
};

// --- Helpers ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function detectEnvironment() {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/')) browser = 'Safari';

  let os = 'Desktop';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Linux')) os = 'Linux';

  return `${browser} / ${os}`;
}

function showToast(msg) {
  const region = $('#toast-region');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  region.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Theme Management ---
function applyTheme(theme) {
  const valid = THEME_LABELS[theme] ? theme : 'obsidian';
  document.documentElement.setAttribute('data-theme', valid);
  localStorage.setItem('dsl_theme', valid);
  $('#current-theme-label').textContent = THEME_LABELS[valid];
}

// --- Polyfill / Progressive Enhancement for dialog[closedby="any"] ---
function setupDialogLightDismissFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of $$('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

// --- Rendering ---
function renderKPIs() {
  const activeSites = state.releases.filter((r) => r.health !== 'Paused' && r.stage !== 'Deprecated').length;
  const allChecks = state.releases.flatMap((r) => r.checklist || []);
  const passed = allChecks.filter((c) => c.status === 'pass').length;
  const passPct = allChecks.length ? Math.round((passed / allChecks.length) * 100) : 100;
  const openBugs = state.feedback.filter((f) => f.status === 'Open' || f.status === 'In Review').length;
  const activeTesters = state.team.filter((m) => m.status === 'Active').length;

  $('#kpi-active-sites').textContent = activeSites;
  $('#kpi-qa-pass').textContent = `${passPct}%`;
  $('#kpi-open-bugs').textContent = openBugs;
  $('#kpi-team-count').textContent = activeTesters;

  $('#nav-count-releases').textContent = state.releases.length;
  $('#nav-count-feedback').textContent = openBugs;
  $('#nav-count-team').textContent = state.team.length;
}

function renderRoleUI() {
  const badge = $('#role-badge');
  badge.textContent = state.isLeadMode ? 'Labs Lead Mode' : 'Tester Mode';
  badge.classList.toggle('is-lead', state.isLeadMode);

  for (const el of $$('.admin-only')) {
    el.hidden = !state.isLeadMode;
  }
}

function healthBadgeClass(health) {
  if (health === 'Healthy') return 'badge-healthy';
  if (health === 'Issues Reported') return 'badge-issues';
  if (health === 'Paused') return 'badge-paused';
  return 'badge-neutral';
}

function renderReleases() {
  const grid = $('#releases-grid');
  const q = state.searchQuery.trim().toLowerCase();

  const filtered = state.releases.filter((r) => {
    const matchesStage = state.stageFilter === 'All' || r.stage === state.stageFilter;
    const hay = `${r.name} ${r.version} ${r.slug} ${r.repoBranch} ${(r.tags || []).join(' ')} ${r.summary}`.toLowerCase();
    const matchesSearch = !q || hay.includes(q);
    return matchesStage && matchesSearch;
  });

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state">No beta websites match your current filter.</div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((rel) => {
      const checks = rel.checklist || [];
      const passCount = checks.filter((c) => c.status === 'pass').length;
      const pct = checks.length ? Math.round((passCount / checks.length) * 100) : 100;
      const canPromote = ['Alpha', 'Closed Beta', 'Open Beta'].includes(rel.stage);

      return `
      <article class="release-card" data-id="${esc(rel.id)}">
        <div class="card-top">
          <div class="card-title-wrap">
            <h2>${esc(rel.name)}</h2>
            <div class="card-meta-line">
              <span class="mono">${esc(rel.version)}</span>
              <span>&middot;</span>
              <span>Owner: ${esc(rel.owner)}</span>
            </div>
          </div>
          <div class="badge-row">
            <span class="badge badge-stage">${esc(rel.stage)}</span>
            <span class="badge ${healthBadgeClass(rel.health)}">${esc(rel.health)}</span>
          </div>
        </div>

        <p class="card-summary">${esc(rel.summary)}</p>

        <div class="tag-list">
          <span class="tag mono">#${esc(rel.buildHash)}</span>
          ${rel.fileSize ? `<span class="tag mono">${esc(rel.fileSize)}</span>` : ''}
          ${rel.source === 'git-folder' ? `<span class="tag">Git apks/</span>` : ''}
          <span class="tag">${esc(rel.accessLevel)}</span>
          ${(rel.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>

        <div class="qa-progress">
          <div class="qa-progress-head">
            <span>QA Smoke Checklist</span>
            <span>${passCount}/${checks.length} passed (${pct}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="inline-size: ${pct}%;"></div>
          </div>
        </div>

        <div class="card-actions">
          <a class="btn btn-primary btn-sm" href="${esc(rel.downloadUrl || rel.url)}" ${rel.downloadUrl || String(rel.url).endsWith('.apk') ? 'download' : 'target="_blank" rel="noopener noreferrer"'}>Download APK</a>
          <button type="button" class="btn btn-outline btn-sm" data-action="inspect" data-id="${esc(rel.id)}">QR &amp; QA</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="report-bug" data-id="${esc(rel.id)}">Report Bug</button>
        </div>

        ${
          state.isLeadMode
            ? `<div class="admin-actions">
                ${canPromote ? `<button type="button" class="btn btn-outline btn-sm" data-action="promote" data-id="${esc(rel.id)}">Promote Stage</button>` : ''}
                <button type="button" class="btn btn-outline btn-sm" data-action="toggle-pause" data-id="${esc(rel.id)}">${rel.health === 'Paused' ? 'Resume' : 'Pause'}</button>
                <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-id="${esc(rel.id)}">Edit</button>
                <button type="button" class="btn btn-ghost btn-sm" data-action="archive" data-id="${esc(rel.id)}">Archive</button>
              </div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderFeedback() {
  const list = $('#feedback-list');
  const filtered = state.feedback.filter((f) => state.fbFilter === 'All' || f.status === state.fbFilter);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">No feedback or bug reports in this status bucket.</div>`;
    return;
  }

  list.innerHTML = filtered
    .map((fb) => {
      const sevClass = fb.severity === 'Critical' || fb.severity === 'High' ? 'badge-issues' : fb.severity === 'Medium' ? 'badge-paused' : 'badge-neutral';
      const statusClass = fb.status === 'Fixed' ? 'badge-healthy' : fb.status === 'Open' ? 'badge-issues' : 'badge-stage';
      return `
      <article class="feedback-card" data-fb-id="${esc(fb.id)}">
        <div class="feedback-head">
          <div>
            <h3>${esc(fb.title)}</h3>
            <div class="card-meta-line">
              <span><strong>${esc(fb.releaseName)}</strong> (${esc(fb.releaseVersion)})</span>
              <span>&middot;</span>
              <span>By ${esc(fb.reporter)}</span>
              <span>&middot;</span>
              <span>${esc(fb.environment)}</span>
              <span>&middot;</span>
              <span>${formatDate(fb.createdAt)}</span>
            </div>
          </div>
          <div class="badge-row">
            <span class="badge ${sevClass}">${esc(fb.severity)}</span>
            <span class="badge badge-neutral">${esc(fb.category)}</span>
            <span class="badge ${statusClass}">${esc(fb.status)}</span>
          </div>
        </div>
        ${fb.description ? `<p class="card-summary">${esc(fb.description)}</p>` : ''}
        ${fb.leadNote && !state.isLeadMode ? `<p class="card-summary"><strong>Labs Lead Note:</strong> ${esc(fb.leadNote)}</p>` : ''}
        ${
          state.isLeadMode
            ? `<div class="feedback-triage-bar">
                <label class="sr-only" for="fb-status-${esc(fb.id)}">Status</label>
                <select id="fb-status-${esc(fb.id)}" data-triage-status="${esc(fb.id)}">
                  ${['Open', 'In Review', 'Fixed', "Won't Fix"]
                    .map((st) => `<option value="${st}" ${fb.status === st ? 'selected' : ''}>${st}</option>`)
                    .join('')}
                </select>
                <input type="text" value="${esc(fb.leadNote || '')}" placeholder="Add engineering triage note..." data-triage-note="${esc(fb.id)}">
                <button type="button" class="btn btn-outline btn-sm" data-save-triage="${esc(fb.id)}">Save Triage</button>
              </div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderTeam() {
  $('#invite-code-display').textContent = state.settings.inviteCode || 'DSL-BETA-942';
  const wrap = $('#team-table-wrap');
  if (!state.team.length) {
    wrap.innerHTML = `<div class="empty-state">No beta testers rostered yet.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Tester</th>
          <th>Email</th>
          <th>Role</th>
          <th>Status</th>
          <th>Joined</th>
          ${state.isLeadMode ? '<th>Operations</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${state.team
          .map(
            (m) => `
          <tr>
            <td><strong>${esc(m.name)}</strong></td>
            <td class="mono">${esc(m.email)}</td>
            <td>${esc(m.role)}</td>
            <td><span class="badge ${m.status === 'Active' ? 'badge-healthy' : 'badge-paused'}">${esc(m.status)}</span></td>
            <td>${esc(m.joinedAt)}</td>
            ${
              state.isLeadMode
                ? `<td>
                    <button type="button" class="btn btn-ghost btn-sm" data-toggle-member="${esc(m.id)}">${m.status === 'Active' ? 'Revoke' : 'Activate'}</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-remove-member="${esc(m.id)}">Remove</button>
                  </td>`
                : ''
            }
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderActivity() {
  const feed = $('#activity-feed');
  if (!state.activity.length) {
    feed.innerHTML = `<li class="empty-state">No portal activity recorded yet.</li>`;
    return;
  }
  feed.innerHTML = state.activity
    .map(
      (a) => `
      <li class="activity-item">
        <span><strong>${esc(a.actor)}</strong> &mdash; ${esc(a.message)}</span>
        <span class="activity-time">${formatDate(a.timestamp)}</span>
      </li>`
    )
    .join('');
}

function renderAll() {
  renderKPIs();
  renderRoleUI();
  renderReleases();
  renderFeedback();
  renderTeam();
  renderActivity();
  if (state.inspectedReleaseId && $('#inspector-dialog').open) {
    populateInspector(state.inspectedReleaseId, false);
  }
}

// --- Inspector Modal ---
function renderQrSvg(targetUrl) {
  const qr = qrcode(0, 'M');
  qr.addData(targetUrl);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function populateInspector(releaseId) {
  const rel = state.releases.find((r) => r.id === releaseId);
  if (!rel) return;
  state.inspectedReleaseId = rel.id;

  const targetHref = rel.downloadUrl || rel.url;
  const absoluteUrl = new URL(targetHref, window.location.origin).href;

  $('#inspector-title').textContent = `${rel.name} (${rel.version})`;
  $('#inspector-badges').innerHTML = `
    <span class="badge badge-stage">${esc(rel.stage)}</span>
    <span class="badge ${healthBadgeClass(rel.health)}">${esc(rel.health)}</span>
    <span class="badge badge-neutral mono">#${esc(rel.buildHash)}</span>
    ${rel.fileSize ? `<span class="badge badge-neutral mono">${esc(rel.fileSize)}</span>` : ''}
  `;

  const link = $('#inspector-external-link');
  link.href = targetHref;
  link.textContent = absoluteUrl;

  const dlBtn = $('#inspector-download-btn');
  dlBtn.href = targetHref;
  if (rel.apkFile || String(targetHref).endsWith('.apk')) {
    dlBtn.setAttribute('download', rel.apkFile || '');
    dlBtn.removeAttribute('target');
    dlBtn.textContent = 'Download APK';
  } else {
    dlBtn.removeAttribute('download');
    dlBtn.setAttribute('target', '_blank');
    dlBtn.textContent = 'Open Build';
  }

  $('#inspector-qr').innerHTML = renderQrSvg(absoluteUrl);
  $('#inspector-apk-meta').innerHTML = `
    ${rel.apkFile ? `<div><strong>File:</strong> <code>${esc(rel.apkFile)}</code></div>` : ''}
    ${rel.fileSize ? `<div><strong>Size:</strong> ${esc(rel.fileSize)}</div>` : ''}
    ${rel.sha256 ? `<div><strong>SHA-256:</strong> <code>${esc(rel.sha256)}</code></div>` : ''}
  `;

  const checklistEl = $('#inspector-checklist');
  if (!rel.checklist || !rel.checklist.length) {
    checklistEl.innerHTML = `<li class="helper-text">No smoke checklist items defined for this build.</li>`;
  } else {
    checklistEl.innerHTML = rel.checklist
      .map(
        (c) => `
      <li class="checklist-item">
        <span>${esc(c.label)}</span>
        <div class="checklist-controls">
          <button type="button" class="chk-btn ${c.status === 'pass' ? 'is-pass' : ''}" data-chk-id="${esc(c.id)}" data-chk-status="pass">Pass</button>
          <button type="button" class="chk-btn ${c.status === 'fail' ? 'is-fail' : ''}" data-chk-id="${esc(c.id)}" data-chk-status="fail">Fail</button>
          <button type="button" class="chk-btn ${c.status === 'pending' ? 'is-pending' : ''}" data-chk-id="${esc(c.id)}" data-chk-status="pending">Pending</button>
        </div>
      </li>`
      )
      .join('');
  }

  $('#inspector-meta').innerHTML = `
    <div><strong>Owner:</strong> ${esc(rel.owner)}</div>
    <div><strong>Branch:</strong> <code>${esc(rel.repoBranch)}</code></div>
    <div><strong>Updated:</strong> ${formatDate(rel.updatedAt)}</div>
  `;

  $('#inspector-changelog').innerHTML = (rel.changelog || []).length
    ? rel.changelog.map((item) => `<li>${esc(item)}</li>`).join('')
    : '<li>Initial beta build.</li>';
}

// --- Modal Openers ---
function openReleaseModal(release = null) {
  const form = $('#release-form');
  form.reset();
  if (release) {
    $('#release-dialog-title').textContent = `Edit ${release.name}`;
    $('#release-submit-btn').textContent = 'Save Changes';
    $('#rel-id').value = release.id;
    $('#rel-name').value = release.name;
    $('#rel-version').value = release.version;
    $('#rel-url').value = release.url;
    $('#rel-stage').value = release.stage;
    $('#rel-owner').value = release.owner;
    $('#rel-branch').value = release.repoBranch;
    $('#rel-summary').value = release.summary;
    $('#rel-changelog').value = (release.changelog || []).join('\n');
    $('#rel-checklist').value = (release.checklist || []).map((c) => c.label).join('\n');
    $('#rel-tags').value = (release.tags || []).join(', ');
  } else {
    $('#release-dialog-title').textContent = 'Publish Beta Website';
    $('#release-submit-btn').textContent = 'Publish Beta Build';
    $('#rel-id').value = '';
  }
  $('#release-dialog').showModal();
}

function openFeedbackModal(preselectReleaseId = null) {
  const select = $('#fb-release-id');
  select.innerHTML = state.releases
    .map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.version)})</option>`)
    .join('');
  if (preselectReleaseId) select.value = preselectReleaseId;
  $('#fb-env').value = detectEnvironment();
  $('#feedback-dialog').showModal();
}

// --- Data Sync ---
async function loadState() {
  const data = await api('/api/state');
  state.settings = data.settings;
  state.releases = data.releases;
  state.feedback = data.feedback;
  state.team = data.team;
  state.activity = data.activity;
  renderAll();
}

// --- Event Wiring ---
function bindEvents() {
  // Theme selection
  applyTheme(localStorage.getItem('dsl_theme') || 'obsidian');
  for (const btn of $$('[data-theme-choice]')) {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.themeChoice);
      $('#theme-popover').hidePopover?.();
      showToast(`Theme switched to ${THEME_LABELS[btn.dataset.themeChoice]}`);
    });
  }

  // Primary navigation tabs
  for (const tab of $$('.nav-tab')) {
    tab.addEventListener('click', () => {
      state.activeView = tab.dataset.view;
      for (const t of $$('.nav-tab')) t.classList.toggle('is-active', t === tab);
      for (const panel of $$('.view-panel')) {
        panel.hidden = panel.id !== `view-${state.activeView}`;
      }
    });
  }

  // Search & Stage filters
  $('#release-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderReleases();
  });

  for (const pill of $$('[data-stage-filter]')) {
    pill.addEventListener('click', () => {
      state.stageFilter = pill.dataset.stageFilter;
      for (const p of $$('[data-stage-filter]')) p.classList.toggle('is-active', p === pill);
      renderReleases();
    });
  }

  for (const pill of $$('[data-fb-filter]')) {
    pill.addEventListener('click', () => {
      state.fbFilter = pill.dataset.fbFilter;
      for (const p of $$('[data-fb-filter]')) p.classList.toggle('is-active', p === pill);
      renderFeedback();
    });
  }

  // Role toggle & Publish button
  $('#role-toggle-btn').addEventListener('click', () => {
    if (state.isLeadMode) {
      state.isLeadMode = false;
      sessionStorage.removeItem('dsl_lead_mode');
      renderAll();
      showToast('Switched to Beta Tester Mode');
    } else {
      $('#admin-error').hidden = true;
      $('#admin-pin-input').value = '';
      $('#admin-dialog').showModal();
    }
  });

  $('#publish-release-btn').addEventListener('click', () => {
    if (!state.isLeadMode) {
      $('#admin-error').hidden = true;
      $('#admin-pin-input').value = '';
      $('#admin-dialog').showModal();
      return;
    }
    openReleaseModal();
  });

  // Admin PIN form
  $('#admin-cancel-btn').addEventListener('click', () => $('#admin-dialog').close());
  $('#admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/verify-pin', {
        method: 'POST',
        body: JSON.stringify({ pin: $('#admin-pin-input').value })
      });
      state.isLeadMode = true;
      sessionStorage.setItem('dsl_lead_mode', 'true');
      $('#admin-dialog').close();
      renderAll();
      showToast('Labs Lead Mode unlocked');
    } catch {
      $('#admin-error').hidden = false;
    }
  });

  // Release card actions (event delegation)
  $('#releases-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const rel = state.releases.find((r) => r.id === id);
    if (!rel) return;

    if (action === 'inspect') {
      populateInspector(id, true);
      $('#inspector-dialog').showModal();
    } else if (action === 'report-bug') {
      openFeedbackModal(id);
    } else if (action === 'promote') {
      await api(`/api/releases/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'promote' }) });
      await loadState();
      showToast(`Promoted ${rel.name}`);
    } else if (action === 'toggle-pause') {
      await api(`/api/releases/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'toggle-pause' }) });
      await loadState();
      showToast(`${rel.health === 'Paused' ? 'Resumed' : 'Paused'} ${rel.name}`);
    } else if (action === 'edit') {
      openReleaseModal(rel);
    } else if (action === 'archive') {
      const confirmDlg = $('#confirm-dialog');
      $('#confirm-message').textContent = `Archive "${rel.name}" (${rel.version})?`;
      confirmDlg.dataset.targetId = id;
      confirmDlg.showModal();
    }
  });

  // Confirm archive dialog (reset returnValue per modern-web-guidance)
  $('#confirm-dialog').addEventListener('close', async () => {
    const dlg = $('#confirm-dialog');
    const choice = dlg.returnValue;
    dlg.returnValue = '';
    if (choice === 'confirm' && dlg.dataset.targetId) {
      await api(`/api/releases/${dlg.dataset.targetId}`, { method: 'DELETE' });
      delete dlg.dataset.targetId;
      await loadState();
      showToast('Beta release archived');
    }
  });

  // Publish / Edit release form
  $('#release-cancel-btn').addEventListener('click', () => $('#release-dialog').close());
  $('#release-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#rel-id').value;
    const payload = {
      name: $('#rel-name').value,
      version: $('#rel-version').value,
      url: $('#rel-url').value,
      stage: $('#rel-stage').value,
      owner: $('#rel-owner').value || 'Dwaraka Core Team',
      repoBranch: $('#rel-branch').value || 'main',
      summary: $('#rel-summary').value,
      changelog: $('#rel-changelog').value.split('\n').map((s) => s.trim()).filter(Boolean),
      checklist: $('#rel-checklist').value.split('\n').map((s) => s.trim()).filter(Boolean),
      tags: $('#rel-tags').value.split(',').map((s) => s.trim()).filter(Boolean)
    };

    if (id) {
      await api(`/api/releases/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast(`Updated ${payload.name}`);
    } else {
      await api('/api/releases', { method: 'POST', body: JSON.stringify(payload) });
      showToast(`Published ${payload.name} ${payload.version}`);
    }
    $('#release-dialog').close();
    await loadState();
  });

  $('#inspector-report-bug-btn').addEventListener('click', () => {
    const id = state.inspectedReleaseId;
    $('#inspector-dialog').close();
    openFeedbackModal(id);
  });

  $('#inspector-checklist').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-chk-id]');
    if (!btn || !state.inspectedReleaseId) return;
    await api(`/api/releases/${state.inspectedReleaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'checklist-update',
        checkId: btn.dataset.chkId,
        status: btn.dataset.chkStatus,
        tester: state.isLeadMode ? 'Labs Lead' : 'Beta Tester'
      })
    });
    await loadState();
  });

  // Feedback modal & triage
  $('#new-feedback-btn').addEventListener('click', () => openFeedbackModal());
  $('#feedback-cancel-btn').addEventListener('click', () => $('#feedback-dialog').close());
  $('#feedback-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        releaseId: $('#fb-release-id').value,
        title: $('#fb-title').value,
        severity: $('#fb-severity').value,
        category: $('#fb-category').value,
        reporter: $('#fb-reporter').value,
        environment: $('#fb-env').value,
        description: $('#fb-desc').value
      })
    });
    $('#feedback-dialog').close();
    $('#feedback-form').reset();
    await loadState();
    showToast('Bug / feedback submitted to DWARAKA triage');
  });

  $('#feedback-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-save-triage]');
    if (!btn) return;
    const id = btn.dataset.saveTriage;
    const status = $(`[data-triage-status="${id}"]`).value;
    const leadNote = $(`[data-triage-note="${id}"]`).value;
    await api(`/api/feedback/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, leadNote })
    });
    await loadState();
    showToast('Triage status saved');
  });

  // Team management & invite code
  $('#copy-invite-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#invite-code-display').textContent);
    showToast('Invite code copied to clipboard');
  });

  $('#rotate-invite-btn').addEventListener('click', async () => {
    const res = await api('/api/settings/rotate-invite', { method: 'POST' });
    state.settings.inviteCode = res.inviteCode;
    await loadState();
    showToast(`Rotated invite code to ${res.inviteCode}`);
  });

  $('#add-member-btn').addEventListener('click', () => {
    $('#member-form').reset();
    $('#member-dialog').showModal();
  });
  $('#member-cancel-btn').addEventListener('click', () => $('#member-dialog').close());
  $('#member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/team', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#mem-name').value,
        email: $('#mem-email').value,
        role: $('#mem-role').value
      })
    });
    $('#member-dialog').close();
    await loadState();
    showToast('Added beta tester to roster');
  });

  $('#team-table-wrap').addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('[data-toggle-member]');
    if (toggleBtn) {
      const id = toggleBtn.dataset.toggleMember;
      const member = state.team.find((m) => m.id === id);
      const nextStatus = member?.status === 'Active' ? 'Revoked' : 'Active';
      await api(`/api/team/${id}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
      await loadState();
      showToast(`Member status set to ${nextStatus}`);
      return;
    }

    const removeBtn = e.target.closest('[data-remove-member]');
    if (removeBtn) {
      await api(`/api/team/${removeBtn.dataset.removeMember}`, { method: 'DELETE' });
      await loadState();
      showToast('Member removed from roster');
    }
  });
}

// --- Boot ---
setupDialogLightDismissFallback();
bindEvents();
loadState().catch((err) => {
  showToast(`Failed to load portal data: ${err.message}`);
});
