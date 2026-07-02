let _currentPanel = 'chat';
let _renamingAppTitlebar = false;  // guard against re-entrant rename
let _kanbanBoard = null;
let _kanbanLatestEventId = 0;
let _kanbanPollTimer = null;
let _kanbanCurrentTaskId = null;
let _kanbanLanesByProfile = false;
// Multi-board state. _kanbanCurrentBoard is the slug of the active board
// the UI is currently viewing. null means "use whatever the server reports
// as active" (i.e. don't pin a specific board in API calls). The UI
// persists the last-viewed slug to localStorage so refresh stays put.
let _kanbanCurrentBoard = null;
let _kanbanBoardsList = null;
let _kanbanBoardMenuOpen = false;
let _kanbanIsDispatching = false;
let _kanbanSuppressCardClickUntil = 0;
// SSE event stream — replaces the 30s polling cadence with a long-lived
// /api/kanban/events/stream connection. Falls back to polling when the
// EventSource fails to connect (proxy that strips text/event-stream, etc).
let _kanbanEventSource = null;
let _kanbanEventSourceFailures = 0;
let _skillsData = null; // cached skills list
let _cronList = null; // cached cron jobs (array)
let _currentCronDetail = null; // full cron job object
let _cronMode = 'empty'; // 'empty' | 'read' | 'create' | 'edit'
let _cronPreFormDetail = null; // snapshot of prior selection when entering a form
let _currentWorkspaceDetail = null; // { path, name, is_default }
let _workspaceMode = 'empty'; // 'empty' | 'read' | 'create' | 'edit'
let _workspacePreFormDetail = null;
let _currentProfileDetail = null; // full profile object
let _profileMode = 'empty'; // 'empty' | 'read' | 'create'
let _profilePreFormDetail = null;
let _pendingSettingsTargetPanel = null; // destination selected while settings had unsaved changes
let _logsAutoRefreshTimer = null;
let _lastLogsLines = [];
let _logsSeverityFilter = 'all';
// Work mode selector state (Hermes Agent / Claude Code)
const WORK_MODES = [
  { id: 'hermes-agent', labelKey: 'work_mode_hermes_agent', descKey: 'work_mode_hermes_agent_desc' },
  { id: 'claude-code', labelKey: 'work_mode_claude_code', descKey: 'work_mode_claude_code_desc' }
];
const WORK_MODE_STORAGE_KEY = 'hermes_web_work_mode';
let _currentWorkMode = null;
let _currentWorkModeSid = null; // 跟踪缓存对应的 session ID，切换会话时自动失效

// Map of panel names → i18n keys for the app titlebar label.
const APP_TITLEBAR_KEYS = {
  chat: 'tab_chat', tasks: 'tab_tasks', skills: 'tab_skills',
  memory: 'tab_memory', workspaces: 'tab_workspaces',
  profiles: 'tab_profiles', todos: 'tab_todos', insights: 'tab_insights', logs: 'tab_logs', settings: 'tab_settings',
};

/**
 * Update the top app titlebar to reflect the current page or selected conversation.
 * On the chat panel, a selected session's title takes precedence over the page name.
 */
function syncAppTitlebar() {
  const titleEl = document.getElementById('appTitlebarTitle');
  const subEl = document.getElementById('appTitlebarSub');
  if (!titleEl) return;
  const panel = (typeof _currentPanel === 'string' && _currentPanel) ? _currentPanel : 'chat';
  let mainText = '';
  let subText = '';
  let sourceLabel = '';
  if (panel === 'chat' && typeof S !== 'undefined' && S && S.session) {
    mainText = S.session.title || (typeof t === 'function' ? t('untitled') : 'Untitled');
    const vis = Array.isArray(S.messages) ? S.messages.filter(m => m && m.role && m.role !== 'tool') : [];
    if (typeof t === 'function') subText = t('n_messages', vis.length);
    sourceLabel = S.session.source_label || S.session.source_tag || S.session.raw_source || '';
    // Recovered sidecars stamp source_label 'WebUI' (api/session_recovery.py); don't badge a native session as its own source (#3338).
    if (/^webui$/i.test(sourceLabel)) sourceLabel = '';
  } else {
    const key = APP_TITLEBAR_KEYS[panel];
    mainText = key && typeof t === 'function' ? t(key) : (panel.charAt(0).toUpperCase() + panel.slice(1));
  }

  // Don't touch the element while an inline rename is in progress — replacing
  // the span with an input would fire a MutationObserver that calls
  // syncAppTitlebar again, destroying the input before the user finishes.
  if (_renamingAppTitlebar) return;

  titleEl.textContent = mainText;
  if (panel !== 'chat') {
    const bot = typeof assistantDisplayName === 'function' ? assistantDisplayName() : '';
    document.title = bot ? mainText + ' \u2014 ' + bot : mainText;
  }
  if (subEl) {
    if (subText) {
      subEl.textContent = subText;
      if (sourceLabel) {
        const badge = document.createElement('span');
        badge.className = 'topbar-source-badge';
        badge.textContent = sourceLabel + (S.session && S.session.read_only ? ' · read-only' : '');
        subEl.appendChild(document.createTextNode(' '));
        subEl.appendChild(badge);
      }
      subEl.hidden = false;
    }
    else { subEl.textContent = ''; subEl.hidden = true; }
  }

  // Double-click on the titlebar title → rename the active session (same behaviour
  // as double-clicking a session title in the sidebar).  Only active on the chat
  // panel when a session is open.
  titleEl.ondblclick = null;  // remove any previous handler before adding a fresh one
  if (panel === 'chat' && typeof S !== 'undefined' && S && S.session && !(S.session.read_only || S.session.is_read_only)) {
    titleEl.ondblclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (_renamingAppTitlebar) return;
      _renamingAppTitlebar = true;

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'app-titlebar-rename-input';
      inp.value = S.session.title || (typeof t === 'function' ? t('untitled') : 'Untitled');

      // Prevent click/dblclick on the input from bubbling — we don't want
      // panel switches, session switches, or any other handler firing.
      ['click', 'mousedown', 'dblclick', 'pointerdown'].forEach(ev =>
        inp.addEventListener(ev, e2 => e2.stopPropagation())
      );

      const finish = async (save) => {
        _renamingAppTitlebar = false;
        if (save) {
          const newTitle = inp.value.trim() || (typeof t === 'function' ? t('untitled') : 'Untitled');
          S.session.title = newTitle;
          syncTopbar();   // update #topbarTitle in the chat header
          syncAppTitlebar();
          // Update the sidebar list so the renamed title appears immediately.
          // _renderOneSession reads from _allSessions cache, so patch it there too.
          try {
            const _cached = typeof _allSessions !== 'undefined' && _allSessions.find(s => s && s.session_id === S.session.session_id);
            if (_cached) _cached.title = newTitle;
          } catch (_) {}
          if (typeof renderSessionListFromCache === 'function') renderSessionListFromCache();
          try {
            await api('/api/session/rename', {
              method: 'POST',
              body: JSON.stringify({ session_id: S.session.session_id, title: newTitle })
            });
          } catch (err) {
            if (typeof setStatus === 'function') setStatus('Rename failed: ' + err.message);
          }
        }
        inp.replaceWith(titleEl);
        syncAppTitlebar();
      };

      inp.onkeydown = e2 => {
        if (e2.key === 'Enter') { e2.preventDefault(); e2.stopPropagation(); finish(true); }
        if (e2.key === 'Escape') { e2.preventDefault(); e2.stopPropagation(); finish(false); }
      };
      inp.onblur = () => finish(false);

      titleEl.replaceWith(inp);
      inp.focus();
      inp.select();
    };
  }
}

function _beginSettingsPanelSession() {
  _settingsDirty = false;
  _settingsThemeOnOpen = localStorage.getItem('hermes-theme') || 'dark';
  _settingsSkinOnOpen = localStorage.getItem('hermes-skin') || 'default';
  _settingsFontSizeOnOpen = localStorage.getItem('hermes-font-size') || 'default';
  _pendingSettingsTargetPanel = null;
  if (_settingsAppearanceAutosaveTimer) {
    clearTimeout(_settingsAppearanceAutosaveTimer);
    _settingsAppearanceAutosaveTimer = null;
  }
  _settingsAppearanceAutosaveRetryPayload = null;
  _resetSettingsPanelState();
}

function _beforePanelSwitch(nextPanel) {
  if (_currentPanel !== 'settings' || nextPanel === 'settings') return true;
  if (_settingsDirty) {
    _pendingSettingsTargetPanel = nextPanel || 'chat';
    _showSettingsUnsavedBar();
    return false;
  }
  _revertSettingsPreview();
  _pendingSettingsTargetPanel = null;
  _resetSettingsPanelState();
  return true;
}

function _consumeSettingsTargetPanel(fallback = 'chat') {
  const target = (_pendingSettingsTargetPanel && _pendingSettingsTargetPanel !== 'settings')
    ? _pendingSettingsTargetPanel
    : fallback;
  _pendingSettingsTargetPanel = null;
  return target;
}

function _resyncChatSidebarAfterPanelSwitch() {
  if (_currentPanel !== 'chat') return;
  if (typeof renderSessionListFromCache !== 'function') return;
  const run = () => {
    if (_currentPanel !== 'chat') return;
    if (typeof _renamingSid !== 'undefined' && _renamingSid) return;
    // If the user opens the per-conversation action menu immediately after
    // returning to Chat, do not let the deferred sidebar resync tear it down.
    // renderSessionListFromCache() intentionally closes that menu before it
    // rebuilds rows, which is correct for normal list refreshes but hostile to
    // this one-shot panel-transition repair.
    if (typeof _sessionActionMenu !== 'undefined' && _sessionActionMenu) return;
    renderSessionListFromCache();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

async function switchPanel(name, opts = {}) {
  const nextPanel = name || 'chat';
  const prevPanel = _currentPanel;
  // ── Desktop sidebar collapse toggle (rail-click only) ──
  // If the click came from a rail icon AND we're on desktop, the rail icon
  // does double duty: clicking the already-active panel collapses the sidebar;
  // clicking any panel while collapsed expands first. Programmatic switches
  // (no opts.fromRailClick) are unaffected so legacy callers preserve
  // behaviour exactly.
  if (opts.fromRailClick && typeof _isSidebarCollapsed === 'function'
      && typeof _isDesktopWidth === 'function' && _isDesktopWidth()) {
    if (_isSidebarCollapsed()) {
      // Expand first, then continue to the normal panel switch below so
      // the clicked panel becomes (or stays) active in the same gesture.
      expandSidebar();
    } else if (prevPanel === nextPanel) {
      // Same panel clicked while sidebar is open → collapse and short-circuit.
      // Skip the guard/cleanup work below; nothing about the active panel
      // is changing, only the visibility of the panel container.
      toggleSidebar(true);
      return false;
    }
  }
  if (!opts.bypassSettingsGuard && !_beforePanelSwitch(nextPanel)) return false;
  if (prevPanel !== 'settings' && nextPanel === 'settings') _beginSettingsPanelSession();
  // Close any long-lived Kanban SSE stream when leaving the kanban panel
  // so we don't keep a stale connection open in the background.
  if (prevPanel === 'kanban' && nextPanel !== 'kanban') {
    if (typeof _kanbanStopPolling === 'function') _kanbanStopPolling();
  }
  _currentPanel = nextPanel;
  // Update nav tabs (rail + mobile sidebar-nav share data-panel)
  document.querySelectorAll('[data-panel]').forEach(t => t.classList.toggle('active', t.dataset.panel === nextPanel));
  // Refresh aria-expanded on the newly-active rail button to mirror sidebar state.
  if (typeof _syncSidebarAria === 'function') _syncSidebarAria();
  // Update panel views
  document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
  const panelEl = $('panel' + nextPanel.charAt(0).toUpperCase() + nextPanel.slice(1));
  if (panelEl) panelEl.classList.add('active');
  // Update main content view. Each entry in MAIN_VIEW_PANELS gets a matching
  // showing-<name> class on <main>; no class means chat (the default).
  const mainEl = document.querySelector('main.main');
  if (mainEl) {
    ['settings','skills','memory','tasks','kanban','workspaces','profiles','insights','logs','plugin'].forEach(p => {
      mainEl.classList.toggle('showing-' + p, nextPanel === p);
    });
  }
  // Lazy-load panel data
  if (nextPanel === 'tasks') await loadCrons();
  if (nextPanel === 'kanban') await loadKanban();
  if (nextPanel === 'skills') await loadSkills();
  if (nextPanel === 'memory') await loadMemory();
  if (nextPanel === 'workspaces') await loadWorkspacesPanel();
  if (nextPanel === 'profiles') await loadProfilesPanel();
  if (nextPanel === 'todos') loadTodos();
  if (nextPanel === 'insights') await loadInsights();
  if (nextPanel === 'logs') await loadLogs();
  _syncLogsAutoRefresh();
  if (typeof _syncSystemHealthMonitorVisibility === 'function') _syncSystemHealthMonitorVisibility();
  if (nextPanel === 'settings') {
    switchSettingsSection(_currentSettingsSection);
    loadSettingsPanel();
  }
  if (opts.fromRailClick && typeof _isDesktopWidth === 'function' && !_isDesktopWidth()) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('mobileOverlay');
    if (sidebar) sidebar.classList.add('mobile-open');
    if (overlay) overlay.classList.add('visible');
  }
  _resyncChatSidebarAfterPanelSwitch();
  if (nextPanel === 'chat' && typeof syncTopbar === 'function') syncTopbar();
  else syncAppTitlebar();
  return true;
}

// ── Cron panel ──
function _isRecurringCronJob(job) {
  const kind = job && job.schedule && job.schedule.kind;
  return kind === 'cron' || kind === 'interval';
}

function _cronScheduleKindForInput(value) {
  const schedule = String(value || '').trim();
  if (!schedule) return '';
  const lower = schedule.toLowerCase();
  if (lower.startsWith('every ')) return 'interval';
  if (lower.startsWith('@')) return 'cron';
  const parts = schedule.split(/\s+/);
  if (parts.length >= 5 && parts.slice(0, 5).every(p => /^[\d*\-,/]+$/.test(p))) return 'cron';
  if (schedule.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(schedule)) return 'once';
  if (/^\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.test(schedule)) return 'once';
  return '';
}

function _syncCronScheduleWarning() {
  const input = $('cronFormSchedule');
  const warning = $('cronFormScheduleOnceWarning');
  if (!input || !warning) return;
  warning.style.display = _cronScheduleKindForInput(input.value) === 'once' ? '' : 'none';
}

function _hasUnlimitedRepeat(job) {
  return !!(job && job.repeat && job.repeat.times == null);
}

function _isCronNeedsAttention(job) {
  return _isRecurringCronJob(job) &&
    _hasUnlimitedRepeat(job) &&
    job.enabled === false &&
    job.state === 'completed' &&
    !job.next_run_at;
}

function _isCronScheduleError(job) {
  return _isRecurringCronJob(job) &&
    !job.next_run_at &&
    (job.state === 'error' || job.last_status === 'error');
}

function _cronStatusMeta(job) {
  if (_isCronNeedsAttention(job)) return {
    state: 'needs_attention',
    listClass: 'attention',
    detailClass: 'warn',
    label: t('cron_status_needs_attention'),
  };
  if (_isCronScheduleError(job)) return {
    state: 'schedule_error',
    listClass: 'attention',
    detailClass: 'warn',
    label: t('cron_status_needs_attention'),
  };
  if (job.state === 'paused') return {
    state: 'paused',
    listClass: 'paused',
    detailClass: 'warn',
    label: t('cron_status_paused'),
  };
  if (job.enabled === false) return {
    state: 'off',
    listClass: 'disabled',
    detailClass: 'warn',
    label: t('cron_status_off'),
  };
  if (job.last_status === 'error') return {
    state: 'error',
    listClass: 'error',
    detailClass: 'err',
    label: t('cron_status_error'),
  };
  return {
    state: 'active',
    listClass: 'active',
    detailClass: 'ok',
    label: t('cron_status_active'),
  };
}


function _cronProfileName(profile){
  return (profile || '').toString().trim();
}

function _cronProfileLabel(profile){
  const name = _cronProfileName(profile);
  return name || (t('cron_profile_server_default') || 'server default');
}

function _cronProfileTitle(profile){
  const name = _cronProfileName(profile);
  if (name) return (t('cron_profile_label') || 'Profile') + ': ' + name;
  return t('cron_profile_server_default_hint') || 'Uses the WebUI server default profile at run time';
}

async function loadCronProfiles(){
  if (_cronProfilesCache) return _cronProfilesCache;
  try {
    const data = await api('/api/profiles');
    _cronProfilesCache = Array.isArray(data.profiles) ? data.profiles : [];
  } catch(e) {
    _cronProfilesCache = [];
  }
  return _cronProfilesCache;
}

function _cronProfileOptions(selected){
  const current = _cronProfileName(selected);
  const profiles = Array.isArray(_cronProfilesCache) ? _cronProfilesCache : [];
  const seen = new Set(['']);
  const opts = [`<option value=""${current ? '' : ' selected'}>${esc(t('cron_profile_server_default') || 'server default')}</option>`];
  for (const p of profiles) {
    const name = _cronProfileName(p && p.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const label = p && p.is_default ? `${name} (${t('default') || 'default'})` : name;
    opts.push(`<option value="${esc(name)}"${current === name ? ' selected' : ''}>${esc(label)}</option>`);
  }
  if (current && !seen.has(current)) {
    opts.push(`<option value="${esc(current)}" selected>${esc(current)} (${esc(t('not_available') || 'not available')})</option>`);
  }
  return opts.join('');
}

function _refreshCronProfileSelect(selected){
  const sel = $('cronFormProfile');
  if (!sel) return;
  const keep = selected === undefined ? sel.value : selected;
  sel.innerHTML = _cronProfileOptions(keep);
}

function _cronDiagnostics(job) {
  const fields = {
    id: job.id,
    name: job.name || null,
    schedule: job.schedule || null,
    schedule_display: job.schedule_display || null,
    enabled: job.enabled,
    state: job.state,
    next_run_at: job.next_run_at || null,
    last_run_at: job.last_run_at || null,
    last_status: job.last_status || null,
    last_error: job.last_error || null,
    last_delivery_error: job.last_delivery_error || null,
    repeat: job.repeat || null,
    deliver: job.deliver || null,
  };
  return JSON.stringify(fields, null, 2);
}

function _gatewayStatusReason(status) {
  const health = status && typeof status.health === 'object' ? status.health : null;
  if (!health) return '';
  return typeof health.reason === 'string' ? health.reason.trim() : '';
}

function _cronGatewayNoticeHtml(status) {
  if (!status) {
    return `
      <div class="detail-alert-title">${esc(t('gateway_status_unknown') || '网关状态未知')}</div>
      <p>${esc(t('gateway_status_unknown_desc') || '无法获取网关运行状态。')}</p>
    `;
  }
  const reason = _gatewayStatusReason(status);
  const isStaleMetadata = reason === 'gateway_stale_running_state';
  const isRemoteUnreachable = reason === 'remote_gateway_unreachable';
  const notConfigured = !status.configured;
  const running = status.running;

  // 网关正在运行
  if (running) {
    return `
      <div class="detail-alert-title" style="color:var(--success,#22c55e)">${esc(t('gateway_running') || '网关正在运行')}</div>
      <p>${esc(t('gateway_running_desc') || 'Hermes 网关守护进程正在后台运行，定时任务可以正常调度。')}</p>
      <p style="margin-top:8px;color:var(--muted,#888);font-size:12px">${esc(t('gateway_builtin_notice') || '网关已内置到后端服务，随服务器一起运行，无需单独关闭。')}</p>
    `;
  }

  const title = notConfigured
    ? '网关未配置'
    : isStaleMetadata
      ? '网关元数据已过期'
      : isRemoteUnreachable
        ? '网关端点不可达'
        : '网关未运行';
  const body = notConfigured
    ? '在 VoldpAiAgent 中，定时任务需要 Hermes 网关守护进程。如果您使用的是单容器 Docker 安装，可以在此处创建并手动运行任务，但定时触发需要在 WebUI 外部运行网关容器或 `hermes gateway`。'
    : isStaleMetadata
      ? '网关已标记为已配置，但其健康元数据已过期。在 Docker 中，定时任务需要活动的网关守护进程在触发定时任务时刷新运行时元数据。'
      : isRemoteUnreachable
        ? '无法从 WebUI 访问网关健康端点。请检查配置的网关 URL 环境变量（`GATEWAY_HEALTH_URL`、`HERMES_GATEWAY_HEALTH_URL`、`HERMES_API_URL` 或 `HERMES_WEBUI_GATEWAY_BASE_URL`）是否指向可访问的网关服务和网络路径，然后再依赖定时触发。'
        : '在 VoldpAiAgent 中，定时任务需要 Hermes 网关守护进程正在运行。在依赖离线定时运行之前，请启动网关容器或 `hermes gateway`。';
  const docsHref = '';
  const helpLink = notConfigured || isRemoteUnreachable || isStaleMetadata
    ? `<p><a href="${docsHref}" target="_blank" rel="noopener">如何在 Docker 中启用定时任务 ↗</a></p>`
    : '';
  const startBtn = (!notConfigured && !isStaleMetadata && !isRemoteUnreachable)
    ? `<p><button id="cronGatewayStartBtn" class="btn-primary" style="margin-top:8px">${esc(t('start_gateway') || '启动网关')}</button></p>`
    : '';
  return `
    <div class="detail-alert-title">${esc(title)}</div>
    <p>${esc(body)}</p>
    ${helpLink}
    ${startBtn}
  `;
}

async function startGateway() {
  const btn = $('cronGatewayStartBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('gateway_starting') || '正在启动...';
  }
  try {
    const res = await api('/api/gateway/start', {method:'POST'});
    if (res && res.ok) {
      showToast(t('gateway_started') || '网关已启动', 'success');
      setTimeout(() => loadCronGatewayNotice(), 2000);
    } else {
      const msg = (res && res.error) || (t('gateway_start_failed') || '启动失败');
      showToast(msg, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('start_gateway') || '启动网关';
      }
    }
  } catch (e) {
    showToast(t('gateway_start_failed') || '启动失败', 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('start_gateway') || '启动网关';
    }
  }
}

async function stopGateway() {
  const btn = $('cronGatewayStopBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('gateway_stopping') || '正在关闭...';
  }
  try {
    const res = await api('/api/gateway/stop', {method:'POST'});
    if (res && res.ok) {
      showToast(t('gateway_stopped') || '网关已关闭', 'success');
      setTimeout(() => loadCronGatewayNotice(), 2000);
    } else {
      const msg = (res && res.error) || (t('gateway_stop_failed') || '关闭失败');
      showToast(msg, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('stop_gateway') || '关闭网关';
      }
    }
  } catch (e) {
    showToast(t('gateway_stop_failed') || '关闭失败', 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('stop_gateway') || '关闭网关';
    }
  }
}

async function loadCronGatewayNotice() {
  const box = $('cronGatewayNotice');
  if (!box) return;
  try {
    const status = await api('/api/gateway/status');
    const html = _cronGatewayNoticeHtml(status);
    box.innerHTML = html;
    box.style.display = '';
    const startBtn = $('cronGatewayStartBtn');
    if (startBtn) startBtn.addEventListener('click', startGateway);
    const stopBtn = $('cronGatewayStopBtn');
    if (stopBtn) stopBtn.addEventListener('click', stopGateway);
  } catch (_) {
    box.innerHTML = _cronGatewayNoticeHtml(null);
    box.style.display = '';
  }
}

async function loadCrons(animate) {
  const box = $('cronList');
  const refreshBtn = $('cronRefreshBtn');
  loadCronGatewayNotice();
  if (animate && refreshBtn) {
    refreshBtn.style.opacity = '0.5';
    refreshBtn.disabled = true;
  }
  try {
    await loadCronProfiles();
    const data = await api('/api/crons');
    _cronList = data.jobs || [];
    if (!_cronList.length) {
      box.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:12px">${esc(t('cron_no_jobs'))}</div>`;
      if (_cronMode !== 'create' && _cronMode !== 'edit') _clearCronDetail();
      return;
    }
    box.innerHTML = '';
    for (const job of _cronList) {
      const item = document.createElement('div');
      item.className = 'cron-item';
      item.id = 'cron-' + job.id;
      const status = _cronStatusMeta(job);
      const isNewRun = _cronNewJobIds.has(String(job.id));
      const isAgentMode = !job.no_agent;
      const profileLabel = _cronProfileLabel(job.profile);
      const profileTitle = _cronProfileTitle(job.profile);
      item.innerHTML = `
        <div class="cron-header">
          ${isNewRun ? '<span class="cron-new-dot" title="New run"></span>' : ''}
          ${isAgentMode ? '<span class="cron-agent-badge" title="Agent mode">🤖</span>' : `<span class="cron-script-badge" title="${esc(t('cron_script_badge_title') || 'Script job (no agent)')}">📜</span>`}
          <span class="cron-name" title="${esc(job.name)}">${esc(job.name)}</span>
          <span class="cron-profile-badge" title="${esc(profileTitle)}">${esc(profileLabel)}</span>
          <span class="cron-status ${status.listClass}">${esc(status.label)}</span>
        </div>`;
      item.onclick = () => openCronDetail(job.id, item);
      if (_currentCronDetail && _currentCronDetail.id === job.id) item.classList.add('active');
      box.appendChild(item);
    }
    // Re-render current detail with fresh data if we have one and we're not in a form
    if (_currentCronDetail && _cronMode !== 'create' && _cronMode !== 'edit') {
      const refreshed = _cronList.find(j => j.id === _currentCronDetail.id);
      if (refreshed) _renderCronDetail(refreshed);
      else _clearCronDetail();
    }
  } catch(e) { box.innerHTML = `<div style="padding:12px;color:var(--accent);font-size:12px">${esc(t('error_prefix'))}${esc(e.message)}</div>`; }
  finally {
    if (animate && refreshBtn) {
      refreshBtn.style.opacity = '';
      refreshBtn.disabled = false;
    }
  }
}

function _cronPanelExpandKey(jobId, suffix){
  return `voldp-ai-agent-cron-${suffix}-expanded-${encodeURIComponent(String(jobId||''))}`;
}

function _cronRunExpandKey(jobId, filename){
  return `${_cronPanelExpandKey(jobId, 'run')}-${encodeURIComponent(String(filename||''))}`;
}

function _cronExpansionGet(key){
  try { return localStorage.getItem(key) === '1'; } catch(_) { return false; }
}

function _cronExpansionSet(key, expanded){
  try { localStorage.setItem(key, expanded ? '1' : '0'); } catch(_) {}
}

function toggleCronPromptExpanded(jobId){
  const key = _cronPanelExpandKey(jobId, 'prompt');
  _cronExpansionSet(key, !_cronExpansionGet(key));
  if (_currentCronDetail && String(_currentCronDetail.id) === String(jobId)) {
    _renderCronDetail(_currentCronDetail);
  }
}

function toggleCronRunExpanded(jobId, filename, runId){
  const key = _cronRunExpandKey(jobId, filename);
  const expanded = !_cronExpansionGet(key);
  _cronExpansionSet(key, expanded);
  const item = document.getElementById(runId);
  const body = item ? item.querySelector('.detail-run-body') : null;
  const btn = item ? item.querySelector('.detail-expand-toggle') : null;
  if (body) body.classList.toggle('expanded', expanded);
  if (btn) {
    btn.textContent = expanded ? '▴' : '▾';
    btn.title = expanded ? (t('cron_collapse_output') || 'Collapse output') : (t('cron_expand_output') || 'Expand output');
    btn.setAttribute('aria-label', btn.title);
  }
}

function _isCronScriptJob(job){
  return !!(job && job.no_agent);
}

function _cronModeLabel(job){
  return _isCronScriptJob(job)
    ? (t('cron_mode_script') || 'Script')
    : (t('cron_mode_agent') || 'Agent');
}

function _cronOutputTitle(job){
  return _isCronScriptJob(job)
    ? (t('cron_script_output') || 'Script output')
    : (t('cron_last_output') || 'Last output');
}

function _cronScriptJobBannerHtml(){
  return `<div class="detail-alert cron-script-job-banner">
        <div class="detail-alert-title">${esc(t('cron_mode_script') || 'Script')}</div>
        <p>${esc(t('cron_script_job_banner') || 'Runs a script on schedule — stdout is delivered to the target. No agent, prompt, or skills.')}</p>
      </div>`;
}

function _cronScriptCardHtml(job){
  const script = String(job && job.script || '').trim() || '—';
  const workdir = String(job && job.workdir || '').trim();
  const workdirRow = workdir
    ? `<div class="detail-row"><div class="detail-row-label">${esc(t('cron_workdir_label') || 'Working directory')}</div><div class="detail-row-value"><code>${esc(workdir)}</code></div></div>`
    : '';
  return `<div class="detail-card cron-script-card">
        <div class="detail-card-title">${esc(t('cron_script_card_title') || 'Script')}</div>
        <div class="detail-script">${esc(script)}</div>
        ${workdirRow}
        <div class="detail-hint cron-script-card-hint">${esc(t('cron_script_path_hint') || 'Resolved under ~/.hermes/scripts/ unless an absolute path. Edit the script file on the server to change behavior.')}</div>
      </div>`;
}

function _cronAgentPromptCardHtml(job){
  const promptExpanded = _cronExpansionGet(_cronPanelExpandKey(job.id, 'prompt'));
  const promptToggleLabel = promptExpanded ? (t('cron_collapse_prompt') || 'Collapse prompt') : (t('cron_expand_prompt') || 'Expand prompt');
  return `<div class="detail-card">
        <div class="detail-card-title detail-card-title-row">
          <span>${esc(t('cron_prompt_label') || 'Prompt')}</span>
          <button type="button" class="detail-expand-toggle" onclick="toggleCronPromptExpanded('${esc(job.id)}')" title="${esc(promptToggleLabel)}" aria-label="${esc(promptToggleLabel)}">${esc(promptExpanded ? '▴' : '▾')}</button>
        </div>
        <div class="detail-prompt ${promptExpanded ? 'expanded' : ''}">${esc(job.prompt || '')}</div>
      </div>`;
}

function _renderCronDetail(job){
  _currentCronDetail = job;
  const title = $('taskDetailTitle');
  const body = $('taskDetailBody');
  const empty = $('taskDetailEmpty');
  if (!title || !body) return;
  title.textContent = job.name || job.schedule_display || '(unnamed)';
  const status = _cronStatusMeta(job);
  const nextRun = job.next_run_at ? new Date(job.next_run_at).toLocaleString() : t('not_available');
  const lastRun = job.last_run_at ? new Date(job.last_run_at).toLocaleString() : t('never');
  const schedule = job.schedule_display || (job.schedule && job.schedule.expression) || '';
  const skills = Array.isArray(job.skills) && job.skills.length ? job.skills.join(', ') : '—';
  const deliver = job.deliver || 'local';
  const isNoAgent = _isCronScriptJob(job);
  const cronJobMode = _cronModeLabel(job);
  const modelProvider =
    job.provider && job.model ? `${esc(job.provider)}/${esc(job.model)}` :
    job.model ? esc(job.model) :
    job.provider ? esc(job.provider) :
    isNoAgent ? '' : 'default';
  const profileLabel = _cronProfileLabel(job.profile);
  const profileTitle = _cronProfileTitle(job.profile);
  const lastError = job.last_error ? `<div class="detail-row"><div class="detail-row-label">${esc(t('error_prefix').replace(/:\s*$/,''))}</div><div class="detail-row-value" style="color:var(--accent-text)">${esc(job.last_error)}</div></div>` : '';
  const attention = status.state === 'needs_attention' || status.state === 'schedule_error';
  const croniterHint = job.last_error && /croniter/i.test(job.last_error)
    ? `<p>${esc(t('cron_attention_croniter_hint'))}</p>`
    : '';
  const attentionBanner = attention ? `
      <div class="detail-alert cron-attention-panel">
        <div class="detail-alert-title">${esc(t('cron_status_needs_attention'))}</div>
        <p>${esc(t('cron_attention_desc'))}</p>
        ${croniterHint}
        <div class="detail-alert-actions">
          <button type="button" class="cron-btn run" onclick="resumeCurrentCron()">${esc(t('cron_attention_resume'))}</button>
          <button type="button" class="cron-btn" onclick="runCurrentCron()">${esc(t('cron_attention_run_once'))}</button>
          <button type="button" class="cron-btn" onclick="copyCurrentCronDiagnostics()">${esc(t('cron_attention_copy_diagnostics'))}</button>
        </div>
      </div>` : '';
  const toastNotifications = job.toast_notifications !== false;
  const outputTitle = _cronOutputTitle(job);
  const skillsRow = isNoAgent ? '' : `<div class="detail-row"><div class="detail-row-label">${esc(t('cron_skills_label') || 'Skills')}</div><div class="detail-row-value">${esc(skills)}</div></div>`;
  const instructionCard = isNoAgent ? _cronScriptCardHtml(job) : _cronAgentPromptCardHtml(job);
  body.innerHTML = `
    <div class="main-view-content">
      ${attentionBanner}
      ${isNoAgent ? _cronScriptJobBannerHtml() : ''}
      <div class="detail-card">
        <div class="detail-card-title">${esc(t('cron_status_active').replace(/./,c=>c.toUpperCase()))}</div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('profile_status'))}</div><div class="detail-row-value"><span class="detail-badge ${status.detailClass}">${esc(status.label)}</span></div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_schedule'))}</div><div class="detail-row-value"><code>${esc(schedule)}</code></div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_next'))}</div><div class="detail-row-value">${esc(nextRun)}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_last'))}</div><div class="detail-row-value">${esc(lastRun)}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_deliver'))}</div><div class="detail-row-value">${esc(deliver)}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_mode_label') || 'Mode')}</div><div class="detail-row-value"><span class="detail-badge cron-mode-badge ${isNoAgent ? 'script' : 'agent'}" id="cronJobMode">${esc(cronJobMode)}</span>${modelProvider ? ` <code>${modelProvider}</code>` : ''}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_profile_label') || 'Profile')}</div><div class="detail-row-value"><span class="detail-badge active" title="${esc(profileTitle)}">${esc(profileLabel)}</span></div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('cron_toast_notifications_label') || 'Completion toasts')}</div><div class="detail-row-value"><span class="detail-badge ${toastNotifications ? 'active' : ''}">${esc(toastNotifications ? (t('cron_toast_notifications_enabled') || 'Enabled') : (t('cron_toast_notifications_disabled') || 'Disabled'))}</span></div></div>
        ${skillsRow}
        ${lastError}
      </div>
      ${instructionCard}
      <div class="detail-card ${_cronNewJobIds.has(String(job.id)) ? 'has-new-run' : ''}" id="cronDetailRuns">
        <div class="detail-card-title">${esc(outputTitle)}</div>
        <div style="color:var(--muted);font-size:12px">${esc(t('loading'))}</div>
      </div>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _cronMode = 'read';
  _setCronHeaderButtons('read', job);
  // Load runs asynchronously
  _loadCronDetailRuns(job.id);
}

function _setCronHeaderButtons(mode, job) {
  const runBtn = $('btnRunTaskDetail');
  const pauseBtn = $('btnPauseTaskDetail');
  const resumeBtn = $('btnResumeTaskDetail');
  const editBtn = $('btnEditTaskDetail');
  const dupBtn = $('btnDuplicateTaskDetail');
  const delBtn = $('btnDeleteTaskDetail');
  const cancelBtn = $('btnCancelTaskDetail');
  const saveBtn = $('btnSaveTaskDetail');
  const hide = b => b && (b.style.display = 'none');
  const show = b => b && (b.style.display = '');
  if (mode === 'read') {
    show(runBtn);
    const status = job ? _cronStatusMeta(job) : null;
    const resumable = job && (
      job.state === 'paused' ||
      (status && (status.state === 'needs_attention' || status.state === 'schedule_error'))
    );
    if (resumable) { hide(pauseBtn); show(resumeBtn); }
    else { show(pauseBtn); hide(resumeBtn); }
    show(editBtn); show(dupBtn); show(delBtn); hide(cancelBtn); hide(saveBtn);
  } else if (mode === 'create' || mode === 'edit') {
    hide(runBtn); hide(pauseBtn); hide(resumeBtn); hide(editBtn); hide(dupBtn); hide(delBtn);
    show(cancelBtn); show(saveBtn);
  } else {
    [runBtn,pauseBtn,resumeBtn,editBtn,dupBtn,delBtn,cancelBtn,saveBtn].forEach(hide);
  }
}

async function _loadCronDetailRuns(jobId){
  try {
    const data = await api(`/api/crons/history?job_id=${encodeURIComponent(jobId)}&limit=50`);
    if (!_currentCronDetail || _currentCronDetail.id !== jobId) return;
    const card = $('cronDetailRuns');
    if (!card) return;
    const outputTitle = _cronOutputTitle(_currentCronDetail);
    const isScriptJob = _isCronScriptJob(_currentCronDetail);
    if (!data.runs || !data.runs.length) {
      card.innerHTML = `<div class="detail-card-title">${esc(outputTitle)}</div><div style="color:var(--muted);font-size:12px">${esc(t('cron_no_runs_yet'))}</div>`;
      return;
    }
    const rows = data.runs.map((run, i) => {
      const ts = run.filename.replace('.md','').replace(/_/g,' ');
      const sizeStr = run.size > 1024 ? (run.size/1024).toFixed(1)+' KB' : run.size+' B';
      const dateStr = new Date(run.modified * 1000).toLocaleString();
      const rid = `cron-det-run-${jobId}-${i}`;
      const usageStrip = isScriptJob ? '' : _formatCronRunUsageStrip(run.usage);
      const runExpanded = _cronExpansionGet(_cronRunExpandKey(jobId, run.filename));
      const runToggleLabel = runExpanded ? (t('cron_collapse_output') || 'Collapse output') : (t('cron_expand_output') || 'Expand output');
      return `<div class="detail-run-item" id="${rid}">
        <div class="detail-run-head" onclick="_loadRunContent('${esc(jobId)}','${esc(run.filename)}','${rid}')">
          <span><span style="opacity:.7">${esc(ts)}</span> <span style="opacity:.4;font-size:11px">${esc(sizeStr)}</span>${usageStrip ? ` <span class="cron-run-usage-strip">${esc(usageStrip)}</span>` : ''}</span>
          <span class="detail-run-actions">
            <button type="button" class="detail-expand-toggle" onclick="event.stopPropagation();toggleCronRunExpanded('${esc(jobId)}','${esc(run.filename)}','${rid}')" title="${esc(runToggleLabel)}" aria-label="${esc(runToggleLabel)}">${esc(runExpanded ? '▴' : '▾')}</button>
            <span style="opacity:.6">▸</span>
          </span>
        </div>
        <div class="detail-run-body ${runExpanded ? 'expanded' : ''}" style="color:var(--muted);font-size:12px">${esc(t('loading'))}</div>
      </div>`;
    }).join('');
    const countLabel = data.total > 50 ? ` (${data.total} runs, showing latest 50)` : ` (${data.total} runs)`;
    card.innerHTML = `<div class="detail-card-title">${esc(outputTitle)}${countLabel}</div>${rows}`;
  } catch(e) { /* ignore */ }
}

async function _loadRunContent(jobId, filename, runId){
  const body = document.querySelector(`#${runId} .detail-run-body`);
  if (!body) return;
  const item = document.getElementById(runId);
  if (item.classList.contains('open')) {
    // Already open → collapse and return (toggle behaviour)
    item.classList.remove('open');
    body.classList.remove('expanded');
    _cronExpansionSet(_cronRunExpandKey(jobId, filename), false);
    const btn = item ? item.querySelector('.detail-expand-toggle') : null;
    if (btn) {
      btn.textContent = '▾';
      btn.title = (t('cron_expand_output') || 'Expand output');
      btn.setAttribute('aria-label', btn.title);
    }
    return;
  }
  item.classList.add('open');
  body.classList.toggle('expanded', _cronExpansionGet(_cronRunExpandKey(jobId, filename)));
  body.innerHTML = `<span style="opacity:.5">${esc(t('loading'))}</span>`;
  try {
    const data = await api(`/api/crons/output?job_id=${encodeURIComponent(jobId)}&filename=${encodeURIComponent(filename)}`);
    if (data.error) {
      body.textContent = data.error;
      return;
    }
    const expanded = _cronExpansionGet(_cronRunExpandKey(jobId, filename));
    const output = expanded ? (data.output || data.content || data.snippet || '') : (data.snippet || data.content || data.output || '');
    body.classList.toggle('expanded', expanded);
    // Render markdown content using the same renderer as chat messages
    if (typeof renderMd === 'function') {
      body.innerHTML = renderMd(output);
    } else {
      body.textContent = output;
    }
    const usageStrip = _formatCronRunUsageStrip(data.usage);
    if (usageStrip) {
      const usage = document.createElement('div');
      usage.className = 'cron-run-usage-strip cron-run-usage-footer';
      usage.textContent = usageStrip;
      body.appendChild(usage);
    }
    // Show "View full output" button only for collapsed previews. Expanded rows render the full body inline.
    if (!expanded && data.content && data.snippet && data.content.length > data.snippet.length) {
      const btn = document.createElement('button');
      btn.style.cssText = 'margin-top:8px;padding:4px 12px;border-radius:var(--radius-btn);border:1px solid var(--border-subtle);background:var(--surface-subtle);color:var(--text-secondary);cursor:pointer;font-size:12px';
      btn.textContent = t('cron_view_full_output') || 'View full output';
      btn.onclick = () => {
        _cronExpansionSet(_cronRunExpandKey(jobId, filename), true);
        body.classList.add('expanded');
        body.innerHTML = renderMd ? renderMd(data.content) : data.content;
        btn.remove();
      };
      body.appendChild(btn);
    }
  } catch(e) {
    body.textContent = 'Error: ' + e.message;
  }
}

function openCronDetail(id, el){
  const job = _cronList ? _cronList.find(j => j.id === id) : null;
  if (!job) return;
  document.querySelectorAll('.cron-item').forEach(e => e.classList.remove('active'));
  const target = el || $('cron-' + id);
  if (target) target.classList.add('active');
  // Remove new-run dot from this job since user is now viewing it
  _clearCronUnreadForJob(id);
  const dot = target && target.querySelector('.cron-new-dot');
  if (dot) dot.remove();
  _cronPreFormDetail = null;
  _editingCronId = null;
  _stopCronWatch();
  _renderCronDetail(job);
  _checkCronWatchOnDetail(id);
}

function _clearCronDetail(){
  _currentCronDetail = null;
  _cronMode = 'empty';
  _stopCronWatch();
  const title = $('taskDetailTitle');
  const body = $('taskDetailBody');
  const empty = $('taskDetailEmpty');
  if (title) title.textContent = '';
  if (body) { body.innerHTML = ''; body.style.display = 'none'; }
  if (empty) empty.style.display = '';
  _setCronHeaderButtons('empty');
}

async function runCurrentCron(){ if (_currentCronDetail) await cronRun(_currentCronDetail.id); }
async function pauseCurrentCron(){ if (_currentCronDetail) await cronPause(_currentCronDetail.id); }
async function resumeCurrentCron(){ if (_currentCronDetail) await cronResume(_currentCronDetail.id); }
async function copyCurrentCronDiagnostics(){
  if (!_currentCronDetail) return;
  try {
    await _copyText(_cronDiagnostics(_currentCronDetail));
    showToast(t('cron_diagnostics_copied'));
  } catch(e) { showToast(t('copy_failed'), 4000); }
}
function editCurrentCron(){
  if (!_currentCronDetail) return;
  openCronEdit(_currentCronDetail);
}
function duplicateCurrentCron(){
  if (!_currentCronDetail) return;
  const job = _currentCronDetail;
  if (typeof switchPanel === 'function' && _currentPanel !== 'tasks') switchPanel('tasks');
  _cronPreFormDetail = { ...job };
  _editingCronId = null;
  _cronMode = 'create';
  _cronIsDuplicate = true;
  _cronSelectedSkills = Array.isArray(job.skills) ? [...job.skills] : [];
  // Deduplicate name: append "(copy)", "(copy 2)", "(copy 3)" etc.
  const baseName = job.name || '';
  let dupName = baseName + ' (copy)';
  if (_cronList && _cronList.length) {
    const taken = new Set(_cronList.filter(j => j.name).map(j => j.name));
    if (taken.has(dupName)) {
      let n = 2;
      while (taken.has(baseName + ' (copy ' + n + ')')) n++;
      dupName = baseName + ' (copy ' + n + ')';
    }
  }
  _renderCronForm({
    name: dupName,
    schedule: job.schedule_display || (job.schedule && job.schedule.expression) || '',
    prompt: job.prompt || '',
    deliver: job.deliver || 'local',
    profile: job.profile || '',
    toast_notifications: job.toast_notifications !== false,
    no_agent: !!job.no_agent,
    script: job.script || '',
    model: job.model || '',
    provider: job.provider || '',
    isEdit: false,
  });
  if (!_cronSkillsCache) {
    api('/api/skills').then(d=>{_cronSkillsCache=d.skills||[]; _bindCronSkillPicker();}).catch(()=>{});
  } else {
    _bindCronSkillPicker();
  }
}
async function deleteCurrentCron(){
  if (!_currentCronDetail) return;
  const id = _currentCronDetail.id;
  const _ok = await showConfirmDialog({title:t('cron_delete_confirm_title'),message:t('cron_delete_confirm_message'),confirmLabel:t('delete_title'),danger:true,focusCancel:true});
  if(!_ok) return;
  try {
    await api('/api/crons/delete', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast(t('cron_job_deleted'));
    _clearCronDetail();
    await loadCrons();
  } catch(e) { showToast(t('delete_failed') + e.message, 4000); }
}

let _cronSelectedSkills=[];
let _cronIsDuplicate = false;
let _cronSkillsCache=null;
let _cronProfilesCache=null;
let _cronDeliveryOptionsCache=null;

function openCronCreate(){
  if (typeof switchPanel === 'function' && _currentPanel !== 'tasks') switchPanel('tasks');
  _cronPreFormDetail = _currentCronDetail ? { ..._currentCronDetail } : null;
  _editingCronId = null;
  _cronMode = 'create';
  _cronIsDuplicate = false;
  _cronSelectedSkills = [];
  _renderCronForm({ name:'', schedule:'', prompt:'', deliver:'local', profile:'', toast_notifications:true, model:'', provider:'', isEdit:false });
  _cronSkillsCache = null;
  api('/api/skills').then(d=>{_cronSkillsCache=d.skills||[]; _bindCronSkillPicker();}).catch(()=>{});
  loadCronProfiles().then(()=>_refreshCronProfileSelect('')).catch(()=>{});
}

function openCronEdit(job){
  if (!job) return;
  _cronPreFormDetail = { ...job };
  _editingCronId = job.id;
  _cronMode = 'edit';
  _cronSelectedSkills = Array.isArray(job.skills) ? [...job.skills] : [];
  _renderCronForm({
    name: job.name || '',
    schedule: job.schedule_display || (job.schedule && job.schedule.expression) || '',
    prompt: job.prompt || '',
    deliver: job.deliver || 'local',
    profile: job.profile || '',
    toast_notifications: job.toast_notifications !== false,
    no_agent: !!job.no_agent,
    script: job.script || '',
    model: job.model || '',
    provider: job.provider || '',
    isEdit: true,
  });
  if (!_cronSkillsCache) {
    api('/api/skills').then(d=>{_cronSkillsCache=d.skills||[]; _bindCronSkillPicker();}).catch(()=>{});
  } else {
    _bindCronSkillPicker();
  }
  loadCronProfiles().then(()=>_refreshCronProfileSelect(job.profile || '')).catch(()=>{});
}

function _renderCronForm({ name, schedule, prompt, deliver, profile, toast_notifications=true, no_agent=false, script='', model='', provider='', isEdit }){
  const title = $('taskDetailTitle');
  const body = $('taskDetailBody');
  const empty = $('taskDetailEmpty');
  if (!body || !title) return;
  const isNoAgent = !!no_agent;
  const toastNotifications = toast_notifications !== false;
  title.textContent = isEdit ? (t('edit') + ' · ' + (name || schedule || t('scheduled_jobs'))) : t('new_job');
  const promptBlock = isNoAgent ? '' : `
        <div class="detail-form-row">
          <label for="cronFormPrompt">${esc(t('cron_prompt_label') || 'Prompt')}</label>
          <textarea id="cronFormPrompt" rows="6" placeholder="${esc(t('cron_prompt_placeholder') || 'Must be self-contained')}" required>${esc(prompt || '')}</textarea>
        </div>`;
  const scriptBlock = isNoAgent ? `
        <div class="detail-form-row">
          <label for="cronFormScript">${esc(t('cron_script_path_label') || 'Script path')}</label>
          <input type="text" id="cronFormScript" value="${esc(script || '')}" readonly autocomplete="off">
          <div class="detail-form-hint">${esc(t('cron_script_path_hint') || 'Resolved under ~/.hermes/scripts/ unless an absolute path. Edit the script file on the server to change behavior.')}</div>
        </div>` : '';
  const skillsBlock = isNoAgent ? '' : `
        <div class="detail-form-row">
          <label for="cronFormSkillSearch">${esc(t('cron_skills_label') || 'Skills')}</label>
          <div class="skill-picker-wrap">
            <input type="text" id="cronFormSkillSearch" placeholder="${esc(t('cron_skills_placeholder') || 'Add skills (optional)...')}" autocomplete="off" ${isEdit ? 'disabled' : ''}>
            <div id="cronFormSkillDropdown" class="skill-picker-dropdown" style="display:none"></div>
            <div id="cronFormSkillTags" class="skill-picker-tags"></div>
          </div>
          ${isEdit ? `<div class="detail-form-hint">${esc(t('cron_skills_edit_hint') || 'Skill list is not editable after creation.')}</div>` : ''}
        </div>`;
  body.innerHTML = `
    <div class="main-view-content">
      ${isNoAgent ? _cronScriptJobBannerHtml() : ''}
      <form class="detail-form" onsubmit="event.preventDefault(); saveCronForm();">
        <div class="detail-form-row">
          <label for="cronFormName">${esc(t('cron_name_label') || 'Name')}</label>
          <input type="text" id="cronFormName" value="${esc(name || '')}" placeholder="${esc(t('cron_name_placeholder') || 'Optional')}" autocomplete="off">
        </div>
        <div class="detail-form-row">
          <label for="cronFormSchedule">${esc(t('cron_schedule_label') || 'Schedule')}</label>
          <input type="text" id="cronFormSchedule" value="${esc(schedule || '')}" placeholder="0 9 * * *  —  every 1h  —  @daily" autocomplete="off" required>
          <div class="detail-form-hint">${esc(t('cron_schedule_hint') || "Cron expression or shorthand like 'every 1h'.")}</div>
          <div id="cronFormScheduleOnceWarning" class="detail-form-warning cron-once-warning" style="display:none">${esc(t('cron_schedule_once_warning') || "Duration forms like '30m' run once and are removed after running. Use 'every 30m' to keep a recurring job.")}</div>
        </div>
        ${scriptBlock}
        ${promptBlock}
        <div class="detail-form-row">
          <label for="cronFormDeliver">${esc(t('cron_deliver_label') || 'Deliver output to')}</label>
          <select id="cronFormDeliver">
            <option value="" disabled>loading...</option>
          </select>
        </div>
        <div class="detail-form-row">
          <label for="cronFormProfile">${esc(t('cron_profile_label') || 'Profile')}</label>
          <select id="cronFormProfile">
            ${_cronProfileOptions(profile)}
          </select>
          <div class="detail-form-hint">${esc(t('cron_profile_server_default_hint') || 'Uses the WebUI server default profile at run time')}</div>
        </div>
        <div class="detail-form-row">
          <label for="cronFormModel">${esc(t('cron_model_label') || 'Model Override')}</label>
          <select id="cronFormModel"${isNoAgent ? ' disabled' : ''}>
            <option value="">loading...</option>
          </select>
          <div class="detail-form-hint">${esc(t('cron_model_hint') || 'Override the default model for this job.')}</div>
        </div>
        <div class="detail-form-row">
          <label for="cronFormToastNotifications">${esc(t('cron_toast_notifications_label') || 'Completion toasts')}</label>
          <label class="detail-form-check" for="cronFormToastNotifications">
            <input type="checkbox" id="cronFormToastNotifications" ${toastNotifications ? 'checked' : ''}>
            <span>${esc(t('cron_toast_notifications_hint') || 'Show a toast when this cron finishes.')}</span>
          </label>
        </div>
        ${skillsBlock}
        <div id="cronFormError" class="detail-form-error" style="display:none"></div>
      </form>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _setCronHeaderButtons(isEdit ? 'edit' : 'create');
  _populateCronDeliverOptions(deliver, isEdit);
  _populateCronFormModelSelect(model, provider, isNoAgent);
  if (!isNoAgent) _renderCronSkillTags();
  const scheduleEl = $('cronFormSchedule');
  if (scheduleEl) {
    scheduleEl.addEventListener('input', _syncCronScheduleWarning);
    scheduleEl.addEventListener('change', _syncCronScheduleWarning);
    _syncCronScheduleWarning();
  }
  const focusEl = $('cronFormName');
  if (focusEl) focusEl.focus();
}

async function _populateCronDeliverOptions(selectedValue, isEdit) {
  var sel = $('cronFormDeliver');
  if (!sel) return;
  sel.disabled = true;
  try {
    if (!_cronDeliveryOptionsCache) {
      var res = await api('/api/crons/delivery-options');
      _cronDeliveryOptionsCache = res && res.platforms ? res.platforms : [];
    }
    sel.innerHTML = '';
    for (var i = 0; i < _cronDeliveryOptionsCache.length; i++) {
      var p = _cronDeliveryOptionsCache[i];
      var opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      if (p.value === selectedValue) opt.selected = true;
      sel.appendChild(opt);
    }
    if (selectedValue && !sel.querySelector('option[value="' + CSS.escape(selectedValue) + '"]')) {
      var opt = document.createElement('option');
      opt.value = selectedValue;
      opt.textContent = selectedValue + ' *';
      opt.selected = true;
      sel.prepend(opt);
    }
  } catch (e) {
    sel.innerHTML = '<option value="local">Local (save output only)</option>';
  }
  sel.disabled = false;
}

async function _populateCronFormModelSelect(selectedModel, selectedProvider, disabled){
  const sel = $('cronFormModel');
  if (!sel) return;
  delete sel.dataset.loaded;
  sel.disabled = true;
  sel.innerHTML = `<option value="">${esc(t('cron_model_use_default') || 'Default (use profile/system default)')}</option>`;
  try {
    const data = await api('/api/models');
    const groups = (Array.isArray(data && data.groups) && data.groups.length) ? data.groups : [];
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.provider || g.provider_id || 'Configured';
      if (g.provider_id) og.dataset.provider = g.provider_id;
      for (const m of (Array.isArray(g.models) ? g.models : [])) {
        if (!m || !m.id) continue;
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        if (g.provider_id) opt.dataset.provider = g.provider_id;
        og.appendChild(opt);
      }
      if (og.children.length) sel.appendChild(og);
    }

    let found = false;
    if (selectedModel) {
      if (typeof _applyModelToDropdown === 'function') {
        found = !!_applyModelToDropdown(selectedModel, sel, selectedProvider || null);
      }
      if (!found) {
        for (const opt of sel.options) {
          if (opt.value !== selectedModel) continue;
          const prov = opt.dataset.provider || (opt.parentElement && opt.parentElement.dataset.provider) || '';
          if (!selectedProvider || prov === selectedProvider) {
            opt.selected = true;
            found = true;
            break;
          }
        }
      }
    } else {
      found = true;
    }

    if (selectedModel && !found) {
      const opt = document.createElement('option');
      opt.value = selectedModel;
      opt.textContent = `${selectedModel} (${t('not_available') || 'not available'})`;
      if (selectedProvider) opt.dataset.provider = selectedProvider;
      opt.selected = true;
      sel.appendChild(opt);
    }
    sel.dataset.loaded = '1';
  } catch (e) {
    console.warn('Failed to load cron model picker:', e.message);
    // Load failed: dataset.loaded stays unset so saveCronForm omits model/provider
    // and preserves any existing override. Keep the select DISABLED rather than
    // re-enabling it showing only "Default" — an enabled "Default"-only select
    // would let the user think they cleared the override when a save actually
    // preserves it (Opus advisor, stage-345). A reopen retries the load.
    sel.disabled = true;
    return;
  }
  sel.disabled = !!disabled;
}

function _renderCronSkillTags(){
  const wrap=$('cronFormSkillTags');
  if(!wrap)return;
  wrap.innerHTML='';
  for(const name of _cronSelectedSkills){
    const tag=document.createElement('span');
    tag.className='skill-tag';
    tag.dataset.skill=name;
    const rm=document.createElement('span');
    rm.className='remove-tag';rm.textContent='×';
    rm.onclick=()=>{_cronSelectedSkills=_cronSelectedSkills.filter(s=>s!==name);tag.remove();};
    tag.appendChild(document.createTextNode(name));
    tag.appendChild(rm);
    wrap.appendChild(tag);
  }
}

function _bindCronSkillPicker(){
  const search=$('cronFormSkillSearch');
  const dropdown=$('cronFormSkillDropdown');
  if(!search||!dropdown)return;
  search.oninput=()=>{
    const q=search.value.trim().toLowerCase();
    if(!q||!_cronSkillsCache){dropdown.style.display='none';return;}
    const matches=_cronSkillsCache.filter(s=>
      !_cronSelectedSkills.includes(s.name)&&
      (s.name.toLowerCase().includes(q)||(s.category||'').toLowerCase().includes(q))
    ).slice(0,8);
    if(!matches.length){dropdown.style.display='none';return;}
    dropdown.innerHTML='';
    for(const s of matches){
      const opt=document.createElement('div');
      opt.className='skill-opt';
      opt.textContent=s.name+(s.category?' ('+s.category+')':'');
      opt.onclick=()=>{
        _cronSelectedSkills.push(s.name);
        _renderCronSkillTags();
        search.value='';
        dropdown.style.display='none';
      };
      dropdown.appendChild(opt);
    }
    dropdown.style.display='';
  };
  search.onblur=()=>setTimeout(()=>{dropdown.style.display='none';},150);
}

function cancelCronForm(){
  _editingCronId = null;
  if (_cronPreFormDetail) {
    const snap = _cronPreFormDetail;
    _cronPreFormDetail = null;
    _renderCronDetail(snap);
    return;
  }
  _cronPreFormDetail = null;
  _clearCronDetail();
}

async function saveCronForm(){
  const nameEl=$('cronFormName');
  const schEl=$('cronFormSchedule');
  const promptEl=$('cronFormPrompt');
  const delivEl=$('cronFormDeliver');
  const profileEl=$('cronFormProfile');
  const toastEl=$('cronFormToastNotifications');
  const errEl=$('cronFormError');
  if(!schEl||!errEl) return;
  const isNoAgent = !!(_cronPreFormDetail && _cronPreFormDetail.no_agent);
  if(!isNoAgent && !promptEl) return;
  const name=(nameEl?nameEl.value:'').trim();
  const schedule=schEl.value.trim();
  const prompt=promptEl ? promptEl.value.trim() : '';
  const deliver=delivEl?delivEl.value:'local';
  const profile=profileEl?profileEl.value:'';
  const toastNotifications=toastEl?!!toastEl.checked:true;
  errEl.style.display='none';
  if(!schedule){errEl.textContent=t('cron_schedule_required_example');errEl.style.display='';return;}
  if(!isNoAgent && !prompt){errEl.textContent=t('cron_prompt_required');errEl.style.display='';return;}
  try{
    const modelEl = $('cronFormModel');
    const modelLoaded = !!(modelEl && modelEl.dataset.loaded === '1');
    const selectedModel = modelEl ? (modelEl.value || '').trim() : '';
    if (_editingCronId) {
      const updates = {job_id: _editingCronId, schedule, profile: profile, toast_notifications: toastNotifications};
      if (!isNoAgent) updates.prompt = prompt;
      if (name) updates.name = name;
      if (deliver) updates.deliver = deliver;
      if (modelEl) {
        if (selectedModel && modelLoaded) {
          const modelState = (typeof _modelStateForSelect === 'function')
            ? _modelStateForSelect(modelEl, selectedModel)
            : { model: selectedModel, model_provider: null };
          updates.model = modelState.model || null;
          updates.provider = modelState.model_provider || null;
        } else if (modelLoaded) {
          updates.model = null;
          updates.provider = null;
        }
        // else: select not yet populated — omit model/provider to preserve saved value
      }
      await api('/api/crons/update', {method:'POST', body: JSON.stringify(updates)});
      const editedId = _editingCronId;
      _editingCronId = null;
      _cronPreFormDetail = null;
      showToast(t('cron_job_updated'));
      await loadCrons();
      const job = _cronList && _cronList.find(j => j.id === editedId);
      if (job) openCronDetail(editedId);
      return;
    }
    const body={schedule,prompt,deliver,profile: profile, toast_notifications: toastNotifications};
    if(_cronIsDuplicate) body.enabled=false;
    if(name)body.name=name;
    if(_cronSelectedSkills.length)body.skills=_cronSelectedSkills;
    if (modelEl && modelLoaded) {
      if (selectedModel) {
        const modelState = (typeof _modelStateForSelect === 'function')
          ? _modelStateForSelect(modelEl, selectedModel)
          : { model: selectedModel, model_provider: null };
        body.model = modelState.model || null;
        body.provider = modelState.model_provider || null;
      }
    } else if (_cronIsDuplicate && _cronPreFormDetail && _cronPreFormDetail.model) {
      body.model = _cronPreFormDetail.model;
      body.provider = _cronPreFormDetail.provider || null;
    }
    const res = await api('/api/crons/create',{method:'POST',body:JSON.stringify(body)});
    _cronPreFormDetail = null;
    _cronIsDuplicate = false;
    showToast(t('cron_job_created'));
    await loadCrons();
    const newId = res && (res.id || (res.job && res.job.id));
    if (newId) openCronDetail(newId);
    else if (_cronList && _cronList.length) openCronDetail(_cronList[_cronList.length - 1].id);
  }catch(e){
    errEl.textContent=t('error_prefix')+e.message;errEl.style.display='';
  }
}

// Back-compat aliases for any stale callers
const submitCronCreate = saveCronForm;
function toggleCronForm(){ openCronCreate(); }

function _cronOutputSnippet(content) {
  // Extract the response body from a cron output .md file
  const lines = content.split('\n');
  const responseIdx = lines.findIndex(l => l.startsWith('## Response') || l.startsWith('# Response'));
  const body = (responseIdx >= 0 ? lines.slice(responseIdx + 1) : lines).join('\n').trim();
  return body.slice(0, 600) || '(empty)';
}

function _formatCronRunUsageStrip(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const parts = [];
  const fmt = n => {
    const value = Number(n || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(value));
  };
  const input = fmt(usage.input_tokens);
  const output = fmt(usage.output_tokens);
  const total = fmt(usage.total_tokens);
  if (input || output) parts.push(`${input || '0'} in · ${output || '0'} out`);
  else if (total) parts.push(`${total} tokens`);
  const cost = Number(usage.estimated_cost_usd);
  if (Number.isFinite(cost) && cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
  if (usage.model) parts.push(String(usage.model));
  return parts.join(' · ');
}

// ── Cron run watch ────────────────────────────────────────────────────────────
let _cronWatchInterval = null;
let _cronWatchStart = null;
let _cronWatchTimerInterval = null;

function _startCronWatch(jobId) {
  _stopCronWatch();
  _cronWatchStart = Date.now();
  _cronWatchInterval = setInterval(async () => {
    try {
      const data = await api(`/api/crons/status?job_id=${encodeURIComponent(jobId)}`,{timeoutToast:false});
      if (!data.running) {
        _stopCronWatch();
        if (_currentCronDetail && _currentCronDetail.id === jobId) {
          _loadCronDetailRuns(jobId);
        }
        return;
      }
      // Still running — update elapsed
      if (_currentCronDetail && _currentCronDetail.id === jobId) {
        const el = $('cronRunningIndicator');
        if (el) el.querySelector('.cron-watch-elapsed').textContent = _formatElapsed(data.elapsed);
      }
    } catch(e) { /* ignore poll errors */ }
  }, 3000);
  // Timer update every second
  _cronWatchTimerInterval = setInterval(() => {
    if (_currentCronDetail && _cronWatchStart) {
      const el = $('cronRunningIndicator');
      if (el) el.querySelector('.cron-watch-elapsed').textContent = _formatElapsed((Date.now() - _cronWatchStart) / 1000);
    }
  }, 1000);
  // Inject running indicator into detail card
  if (_currentCronDetail && _currentCronDetail.id === jobId) {
    _injectRunningIndicator();
  }
}

function _stopCronWatch() {
  if (_cronWatchInterval) { clearInterval(_cronWatchInterval); _cronWatchInterval = null; }
  if (_cronWatchTimerInterval) { clearInterval(_cronWatchTimerInterval); _cronWatchTimerInterval = null; }
  _cronWatchStart = null;
  const el = $('cronRunningIndicator');
  if (el) el.remove();
}

function _injectRunningIndicator() {
  const card = $('cronDetailRuns');
  if (!card || $('cronRunningIndicator')) return;
  const div = document.createElement('div');
  div.id = 'cronRunningIndicator';
  div.className = 'cron-running-indicator';
  div.innerHTML = `<span class="cron-watch-spinner"></span><span>${esc(t('cron_status_running'))}</span><span class="cron-watch-elapsed">0s</span>`;
  card.insertAdjacentElement('beforebegin', div);
}

function _formatElapsed(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + 'm ' + s + 's';
}

function _checkCronWatchOnDetail(jobId) {
  // When opening a detail view, check if job is running
  api(`/api/crons/status?job_id=${encodeURIComponent(jobId)}`,{timeoutToast:false}).then(data => {
    if (data.running && _currentCronDetail && _currentCronDetail.id === jobId) {
      _startCronWatch(jobId);
    }
  }).catch(() => {});
}

async function cronRun(id) {
  try {
    await api('/api/crons/run', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast(t('cron_job_triggered'));
    _startCronWatch(id);
  } catch(e) { showToast(t('failed_colon') + e.message, 4000); }
}

async function cronPause(id) {
  try {
    await api('/api/crons/pause', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast(t('cron_job_paused'));
    await loadCrons();
  } catch(e) { showToast(t('failed_colon') + e.message, 4000); }
}

async function cronResume(id) {
  try {
    await api('/api/crons/resume', {method:'POST', body: JSON.stringify({job_id: id})});
    showToast(t('cron_job_resumed'));
    await loadCrons();
  } catch(e) { showToast(t('failed_colon') + e.message, 4000); }
}

let _editingCronId = null;

// ── Kanban panel (read-only) ──
function _kanbanColumnLabel(name){ return t('kanban_status_' + name) || name; }
function _kanbanTaskTitle(task){ return task.title || task.summary || task.id || t('kanban_task'); }
function _kanbanTaskBody(task){ return task.body || task.description || task.prompt || ''; }
function _kanbanTaskMeta(task){
  const bits = [];
  if (task.assignee) bits.push(task.assignee);
  if (task.tenant) bits.push(task.tenant);
  if (task.priority !== undefined && task.priority !== null) bits.push('P' + task.priority);
  if (task.comment_count) bits.push('💬 ' + task.comment_count);
  if (task.link_counts && task.link_counts.children) bits.push('↳ ' + task.link_counts.children);
  return bits;
}

function _kanbanCurrentFilters(){
  const q = $('kanbanSearch') ? $('kanbanSearch').value.trim().toLowerCase() : '';
  const assigneeEl = $('kanbanAssigneeFilter');
  const tenantEl = $('kanbanTenantFilter');
  const assignee = assigneeEl ? (assigneeEl.value || assigneeEl.dataset.defaultValue || '') : '';
  const tenant = tenantEl ? (tenantEl.value || tenantEl.dataset.defaultValue || '') : '';
  const includeArchived = !!($('kanbanIncludeArchived') && $('kanbanIncludeArchived').checked);
  const onlyMine = !!($('kanbanOnlyMine') && $('kanbanOnlyMine').checked);
  return {q, assignee, tenant, includeArchived, onlyMine};
}

function _kanbanApplyConfigDefaults(config){
  if (!config || _kanbanConfigApplied) return;
  if ($('kanbanTenantFilter') && config.default_tenant) $('kanbanTenantFilter').dataset.defaultValue = config.default_tenant;
  if ($('kanbanIncludeArchived') && config.include_archived_by_default === true) $('kanbanIncludeArchived').checked = true;
  if (config.lane_by_profile === true) _kanbanLanesByProfile = true;
  _kanbanConfigApplied = true;
}
let _kanbanConfigApplied = false;

function _kanbanSetSelectOptions(el, values, allLabelKey){
  if (!el) return;
  const current = el.value || el.dataset.defaultValue || '';
  const opts = [`<option value="">${esc(t(allLabelKey))}</option>`]
    .concat((values || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`));
  el.innerHTML = opts.join('');
  if ([...el.options].some(o => o.value === current)) el.value = current;
}

function _kanbanVisibleTasks(){
  const filters = _kanbanCurrentFilters();
  const columns = (_kanbanBoard && _kanbanBoard.columns) || [];
  return columns.map(col => {
    const tasks = (col.tasks || []).filter(task => {
      if (!filters.q) return true;
      const haystack = [task.id, _kanbanTaskTitle(task), _kanbanTaskBody(task), task.assignee, task.tenant]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(filters.q);
    });
    return {...col, tasks};
  });
}

function _kanbanRenderSidebar(columns){
  const list = $('kanbanList');
  if (!list) return;
  const tasks = columns.flatMap(col => (col.tasks || []).map(task => ({...task, status: task.status || col.name})));
  if (!tasks.length) {
    list.innerHTML = `<div class="kanban-empty" data-i18n="kanban_no_matching_tasks">${esc(t('kanban_no_matching_tasks'))}</div>`;
    return;
  }
  list.innerHTML = tasks.map(task => {
    const meta = _kanbanTaskMeta(task);
    return `<button class="kanban-list-item" onclick="loadKanbanTask('${esc(task.id)}')">
      <span class="kanban-list-status">${esc(_kanbanColumnLabel(task.status))}</span>
      <span class="kanban-list-title">${esc(_kanbanTaskTitle(task))}</span>
      ${meta.length ? `<span class="kanban-meta">${esc(meta.join(' · '))}</span>` : ''}
    </button>`;
  }).join('');
}


/**
 * Render inline markdown (bold, italic, code, links, strikethrough).
 * Input is already HTML-escaped.
 */
function _kanbanRenderMarkdownInline(escaped){
  return String(escaped || '')
    .replace(/~~([^~\n]+)~~/g, (_m, text) => `<del>${text}</del>`)
    .replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, text) => `<strong>${text}</strong>`)
    .replace(/(^|[^*a-zA-Z0-9])\*([^*\n]+)\*/g, (_m, prefix, text) => `${prefix}<em>${text}</em>`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, text, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

/**
 * Render full markdown block content: headings, code blocks, lists, tables,
 * task lists, blockquotes, horizontal rules, paragraphs + inline formatting.
 */
function _kanbanRenderMarkdown(source){
  if (!source) return '';
  const lines = esc(source).split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Code block ──
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const codeHtml = codeLines.join('\n');
      out.push(lang
        ? `<pre class="hermes-kanban-code"><code class="language-${_kanbanRenderMarkdownInline(lang)}">${codeHtml}</code></pre>`
        : `<pre class="hermes-kanban-code"><code>${codeHtml}</code></pre>`);
      continue;
    }

    // ── Horizontal rule ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // ── Heading ──
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${_kanbanRenderMarkdownInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // ── Blockquote ──
    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${_kanbanRenderMarkdownInline(quoteLines.join('<br>'))}</blockquote>`);
      continue;
    }

    // ── Table row ──
    if (/^\|.+\|$/.test(trimmed)) {
      const tableRows = [];
      const tableAligns = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        const row = lines[i].trim();
        // Detect alignment separator row
        if (/^\|[\s:]*-{3,}[\s:]*\|/.test(row)) {
          const cells = row.split('|').filter(c => c.trim().length > 0);
          cells.forEach(c => {
            const t = c.trim();
            if (t.startsWith(':') && t.endsWith(':')) tableAligns.push('center');
            else if (t.endsWith(':')) tableAligns.push('right');
            else tableAligns.push('left');
          });
        } else {
          const cells = row.split('|').filter(c => c.trim().length > 0);
          tableRows.push(cells.map((c, ci) => {
            const align = tableAligns[ci] ? ` style="text-align:${tableAligns[ci]}"` : '';
            return `<td${align}>${_kanbanRenderMarkdownInline(c.trim())}</td>`;
          }).join(''));
        }
        i++;
      }
      if (tableRows.length) {
        out.push(`<table><tbody>${tableRows.map(r => `<tr>${r}</tr>`).join('')}</tbody></table>`);
      }
      continue;
    }

    // ── Task list item ──
    const taskMatch = trimmed.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/);
    if (taskMatch) {
      const checked = taskMatch[1] !== ' ';
      const text = taskMatch[2];
      const items = [];
      items.push(`<li class="hermes-kanban-task${checked ? ' checked' : ''}"><input type="checkbox"${checked ? ' checked' : ''} disabled> ${_kanbanRenderMarkdownInline(text)}</li>`);
      i++;
      // Collect continuation items
      while (i < lines.length) {
        const next = lines[i].trim();
        const nextTask = next.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/);
        const nextLi = next.match(/^[-*+]\s+(.+)$/);
        if (nextTask) {
          const c = nextTask[1] !== ' ';
          items.push(`<li class="hermes-kanban-task${c ? ' checked' : ''}"><input type="checkbox"${c ? ' checked' : ''} disabled> ${_kanbanRenderMarkdownInline(nextTask[2])}</li>`);
          i++;
        } else if (nextLi) {
          items.push(`<li>${_kanbanRenderMarkdownInline(nextLi[1])}</li>`);
          i++;
        } else {
          break;
        }
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ── Unordered list item ──
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      const items = [];
      items.push(`<li>${_kanbanRenderMarkdownInline(ulMatch[1])}</li>`);
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        const nextUl = next.match(/^[-*+]\s+(.+)$/);
        const nextTask = next.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/);
        if (nextTask) break; // let task list handler get it
        if (nextUl) {
          items.push(`<li>${_kanbanRenderMarkdownInline(nextUl[1])}</li>`);
          i++;
        } else {
          break;
        }
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ── Ordered list item ──
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      const items = [];
      items.push(`<li>${_kanbanRenderMarkdownInline(olMatch[1])}</li>`);
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        const nextOl = next.match(/^\d+\.\s+(.+)$/);
        if (nextOl) {
          items.push(`<li>${_kanbanRenderMarkdownInline(nextOl[1])}</li>`);
          i++;
        } else {
          break;
        }
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // ── Empty line ──
    if (!trimmed) {
      out.push('');
      i++;
      continue;
    }

    // ── Paragraph ──
    out.push(`<p>${_kanbanRenderMarkdownInline(trimmed)}</p>`);
    i++;
  }
  return `<div class="hermes-kanban-md">${out.join('\n')}</div>`;
}

function _kanbanFormatDuration(seconds){
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return Math.round(n) + 's';
  if (n < 3600) return Math.round(n / 60) + 'm';
  if (n < 86400) return Math.round(n / 3600) + 'h';
  return Math.round(n / 86400) + 'd';
}

function _kanbanTaskAge(task){
  const age = task && (task.age_seconds || task.age);
  if (Number.isFinite(Number(age))) return _kanbanFormatDuration(age);
  return '';
}

function _kanbanCardStalenessClass(task){
  const age = Number(task && (task.age_seconds || task.age));
  const status = task && task.status;
  if (!Number.isFinite(age)) return '';
  if ((status === 'running' && age > 3600) || (status === 'blocked' && age > 86400)) return 'kanban-card-stale-red';
  if ((status === 'running' && age > 600) || (status === 'ready' && age > 3600) || (status === 'blocked' && age > 3600)) return 'kanban-card-stale-amber';
  return '';
}

function _kanbanCardQuickActions(task){
  const id = esc(task.id || '');
  const status = task.status || '';
  const complete = status !== 'done' && status !== 'archived' ? `<button type="button" class="kanban-card-action" onclick="quickKanbanCardAction(event,'${id}','done')">${esc(t('kanban_card_complete'))}</button>` : '';
  const archive = status !== 'archived' ? `<button type="button" class="kanban-card-action danger" onclick="quickKanbanCardAction(event,'${id}','archived')">${esc(t('kanban_card_archive'))}</button>` : '';
  return `<div class="kanban-card-actions" onclick="event.stopPropagation()">${complete}${archive}</div>`;
}

async function quickKanbanCardAction(event, taskId, status){
  if (event) event.stopPropagation();
  return updateKanbanTask(taskId, {status});
}

function _kanbanSuppressNextCardClick(){
  _kanbanSuppressCardClickUntil = Date.now() + 700;
}

function dragKanbanTask(event, taskId){
  _kanbanSuppressNextCardClick();
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', taskId);
}

function finishKanbanDrag(event){
  if (event) _kanbanSuppressNextCardClick();
}

function openKanbanCard(event, taskId){
  if (Date.now() < _kanbanSuppressCardClickUntil) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return false;
  }
  // 团队改造：点击卡片跳转到聊天页面中对应的聊天对话
  _kanbanJumpToChat(taskId);
  return false;
}

// _kanbanJumpToChat 跳转到聊天面板并加载任务关联的会话。
// 优先从卡片 data-session-id 读取；若没有则通过 API 获取任务详情。
async function _kanbanJumpToChat(taskId){
  if (!taskId) return;
  try {
    // 先尝试从卡片元素读取 session_id
    let sessionId = '';
    const cardEl = document.querySelector(`[data-kanban-task-id="${CSS.escape(taskId)}"]`);
    if (cardEl) { sessionId = cardEl.dataset.sessionId || ''; }
    // 若卡片上没有 session_id，通过 API 获取
    if (!sessionId) {
      const data = await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + _kanbanBoardQuery());
      if (data && data.task && data.task.session_id) { sessionId = data.task.session_id; }
    }
    // 仍无 session_id，调用后端 API 为任务补创建关联会话
    if (!sessionId) {
      const resp = await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + '/create-session' + _kanbanBoardQuery(), {method: 'POST'});
      if (resp && resp.session_id) { sessionId = resp.session_id; }
    }
    if (!sessionId) {
      showToast(t('kanban_no_session') || '该任务未关联聊天会话', 'error');
      return;
    }
    // 切换到聊天面板
    if (typeof switchPanel === 'function') { switchPanel('chat', {fromRailClick: false}); }
    // 加载对应会话
    if (typeof loadSession === 'function') {
      await loadSession(sessionId);
    }
  } catch(e) {
    showToast(t('kanban_jump_failed') + ': ' + (e.message || e), 'error');
  }
}

function allowKanbanDrop(event){
  // Don't accept drops into the 'running' column. Entering 'running' is owned
  // by the dispatcher/claim_task path (sets claim_lock + claim_expires +
  // started_at + worker_pid). A drag-drop would bypass that contract and the
  // bridge would reject the resulting PATCH with HTTP 400 anyway. Refuse the
  // drop visually so users see immediate feedback.
  const target = event.currentTarget;
  if (target && target.dataset && target.dataset.kanbanStatus === 'running') {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function clearKanbanDrop(event){
  if (event && event.currentTarget) event.currentTarget.classList.remove('drop-target');
}

async function dropKanbanTask(event, status){
  _kanbanSuppressNextCardClick();
  event.preventDefault();
  event.stopPropagation();
  clearKanbanDrop(event);
  const taskId = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
  if (taskId && status) await updateKanbanTask(taskId, {status}, {openDetail: false});
  _kanbanSuppressNextCardClick();
}

function _kanbanLaneNames(columns){
  const names = new Set();
  columns.forEach(col => (col.tasks || []).forEach(task => names.add(task.assignee || t('kanban_unassigned'))));
  return Array.from(names).sort((a, b) => String(a).localeCompare(String(b)));
}

function _kanbanRenderColumn(col){
  const tasks = col.tasks || [];
  return `<section class="kanban-column" data-status="${esc(col.name)}" data-kanban-status="${esc(col.name)}" ondragover="allowKanbanDrop(event)" ondragenter="event.currentTarget.classList.add('drop-target')" ondragleave="clearKanbanDrop(event)" ondrop="dropKanbanTask(event, '${esc(col.name)}')">
      <div class="kanban-column-head">
        <span>${esc(_kanbanColumnLabel(col.name))}</span>
        <span class="kanban-count">${tasks.length}</span>
      </div>
      <div class="kanban-column-body">
        ${tasks.length ? tasks.map(task => _kanbanCard(task, col.name)).join('') : `<div class="kanban-empty">${esc(t('kanban_empty'))}</div>`}
      </div>
    </section>`;
}

function _kanbanRenderProfileLanes(columns){
  const lanes = _kanbanLaneNames(columns);
  if (!lanes.length) return columns.map(_kanbanRenderColumn).join('');
  return `<div class="kanban-profile-lanes">${lanes.map(lane => {
    const laneCols = columns.map(col => ({...col, tasks: (col.tasks || []).filter(task => (task.assignee || t('kanban_unassigned')) === lane)}));
    const count = laneCols.reduce((sum, col) => sum + (col.tasks || []).length, 0);
    return `<section class="kanban-profile-lane" data-kanban-lane="${esc(lane)}"><header class="kanban-profile-lane-head"><span>${esc(lane)}</span><span class="kanban-count">${count}</span></header><div class="kanban-board kanban-board-in-lane">${laneCols.map(_kanbanRenderColumn).join('')}</div></section>`;
  }).join('')}</div>`;
}

function _kanbanEmptyBoardHtml(){
  return `<div class="main-view-empty"><div class="main-view-empty-title">${esc(t('kanban_no_data'))}</div><div class="main-view-empty-sub">${esc(t('kanban_work_queue_hint'))}</div></div>`;
}

function _kanbanRenderBoard(){
  const board = $('kanbanBoard');
  if (!board) return;
  if (!_kanbanBoard || !_kanbanBoard.columns) {
    board.innerHTML = _kanbanEmptyBoardHtml();
    return;
  }
  const columns = _kanbanVisibleTasks();
  const total = columns.reduce((n, col) => n + (col.tasks || []).length, 0);
  if ($('kanbanSummary')) $('kanbanSummary').textContent = String(t('kanban_visible_tasks')).replace('{0}', total);
  _kanbanRenderSidebar(columns);
  if (total === 0) {
    board.innerHTML = _kanbanEmptyBoardHtml();
    return;
  }
  board.innerHTML = _kanbanLanesByProfile ? _kanbanRenderProfileLanes(columns) : columns.map(_kanbanRenderColumn).join('');
}

function _kanbanCard(task, status){
  const priority = Number(task.priority || 0);
  const links = task.link_counts || {};
  const linkTotal = Number(links.parents || 0) + Number(links.children || 0);
  const comments = Number(task.comment_count || 0);
  const age = _kanbanTaskAge(task);
  const stale = _kanbanCardStalenessClass(task);
  const body = _kanbanTaskBody(task);
  const assignee = task.assignee ? `<span class="kanban-card-assignee">@${esc(task.assignee)}</span>` : `<span class="kanban-card-unassigned">${esc(t('kanban_unassigned'))}</span>`;
  const sessionId = task.session_id || '';
  return `<article class="kanban-card ${esc(stale)}" data-kanban-task-id="${esc(task.id)}" data-session-id="${esc(sessionId)}" draggable="true" ondragstart="dragKanbanTask(event, '${esc(task.id)}')" ondragend="finishKanbanDrag(event)" onclick="return openKanbanCard(event, '${esc(task.id)}')" tabindex="0" role="button" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openKanbanCard(event, '${esc(task.id)}')}">
    <div class="kanban-card-topline"><span class="kanban-card-id">${esc(task.id || '')}</span>${priority ? `<span class="kanban-badge priority">P${priority}</span>` : ''}${task.tenant ? `<span class="kanban-badge tenant">${esc(task.tenant)}</span>` : ''}</div>
    <div class="kanban-card-title">${esc(_kanbanTaskTitle(task))}</div>
    ${body ? `<div class="kanban-card-body">${_kanbanRenderMarkdown(body)}</div>` : ''}
    <div class="kanban-card-meta">${assignee}${comments ? `<span class="kanban-card-metric">💬 ${comments}</span>` : ''}${linkTotal ? `<span class="kanban-card-metric">↔ ${linkTotal}</span>` : ''}${age ? `<span class="kanban-card-age">${esc(age)}</span>` : ''}</div>
    ${_kanbanCardQuickActions(task)}
  </article>`;
}

async function hardRefreshWebUIClient(){
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch(_) {}
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch(_) {}
  window.location.reload();
}

function _kanbanLooksLikeStaleClientError(err){
  const msg = String((err && err.message) || err || '').toLowerCase();
  return !!(err && err.status === 404 && (
    msg === 'not found' ||
    msg.includes('unknown kanban endpoint') ||
    msg.includes('stale cached bundle')
  ));
}

function _kanbanUnavailableHtml(err){
  const raw = String((err && err.message) || err || '');
  if (_kanbanLooksLikeStaleClientError(err)) {
    return `<div class="main-view-empty"><div class="main-view-empty-title">Kanban needs a hard refresh</div><div class="main-view-empty-subtitle">The server rejected an obsolete Kanban endpoint. This usually means the browser or Mac app is still running a stale cached WebUI bundle after an update.</div><button class="btn primary" type="button" onclick="hardRefreshWebUIClient()">Hard refresh now</button><div class="main-view-empty-subtitle">Original error: ${esc(raw || 'not found')}</div></div>`;
  }
  const msg = `${esc(t('kanban_unavailable'))}: ${esc(raw)}`;
  return `<div class="main-view-empty"><div class="main-view-empty-title">${msg}</div></div>`;
}

async function loadKanban(animate){
  const board = $('kanbanBoard');
  const list = $('kanbanList');
  try {
    if (animate && board) board.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:13px">${esc(t('loading'))}</div>`;
    // Resolve the active board before board-scoped requests. If another CLI or
    // tab archived the previous board, /boards can fall back to default instead
    // of leaving config/board pinned to a ghost slug.
    await loadKanbanBoards();
    const config = await api('/api/kanban/config' + _kanbanBoardQuery());
    let assignees = null;
    try { assignees = await api('/api/kanban/assignees' + _kanbanBoardQuery()); } catch(e) { assignees = null; }
    _kanbanApplyConfigDefaults(config);
    const filters = _kanbanCurrentFilters();
    const params = new URLSearchParams();
    if (filters.assignee) params.set('assignee', filters.assignee);
    if (filters.tenant) params.set('tenant', filters.tenant);
    if (filters.includeArchived) params.set('include_archived', '1');
    if (filters.onlyMine) params.set('only_mine', '1');
    if (_kanbanCurrentBoard) params.set('board', _kanbanCurrentBoard);
    const path = '/api/kanban/board' + (params.toString() ? '?' + params.toString() : '');
    const data = await api(path);
    if (data && data.changed === false && _kanbanBoard) { _kanbanRenderBoard(); return; }
    _kanbanBoard = data || {columns: []};
    if ((!_kanbanBoard.columns || !_kanbanBoard.columns.length) && config && config.columns) {
      _kanbanBoard.columns = config.columns.map(name => ({name, tasks: []}));
    }
    _kanbanLatestEventId = Number(_kanbanBoard.latest_event_id || 0);
    // Toggle the "Read-only view" banner based on the bridge's read_only flag.
    // Bridge sets read_only=true only when the kanban_db connection cannot accept
    // writes (e.g. dispatcher contention or library missing). Hide otherwise.
    try {
      const ro = document.querySelector('.kanban-readonly');
      if (ro) ro.style.display = _kanbanBoard.read_only ? '' : 'none';
    } catch(_) {}
    _kanbanSetSelectOptions($('kanbanAssigneeFilter'), _kanbanBoard.assignees || (assignees && assignees.assignees) || (config && config.assignees), 'kanban_all_assignees');
    _kanbanSetSelectOptions($('kanbanTenantFilter'), _kanbanBoard.tenants, 'kanban_all_tenants');
    await loadKanbanStats();
    // Note: PR #1828 (v0.51.20) moved the boards refresh to the start of
    // loadKanban() so the active board is resolved BEFORE board-scoped
    // requests fire. The previous tail-of-function refresh has been removed
    // to avoid doubling /api/kanban/boards traffic during SSE-driven
    // refreshes (debounced at 250ms via _scheduleKanbanRefresh). The
    // 30-second poll started by _kanbanStartPolling() picks up any board
    // state changes that arrive after this render.
    _kanbanStartPolling();
    _kanbanRenderBoard();
  } catch(e) {
    const html = _kanbanUnavailableHtml(e);
    if (board) board.innerHTML = html;
    if (list) list.innerHTML = html;
  }
}

function filterKanban(){ _kanbanRenderBoard(); }

async function loadKanbanStats(){
  try {
    const stats = await api('/api/kanban/stats' + _kanbanBoardQuery());
    const el = $('kanbanStats');
    if (!el) return;
    const byStatus = (stats && stats.by_status) || {};
    const total = Object.values(byStatus).reduce((a, b) => a + Number(b || 0), 0);
    const cells = Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) =>
      `<span class="kanban-stat-cell"><strong>${esc(String(count))}</strong> ${esc(_kanbanColumnLabel(status))}</span>`
    ).join('');
    el.innerHTML = `<div class="kanban-stats-grid"><span class="kanban-stat-cell total"><strong>${esc(String(total))}</strong> ${esc(t('kanban_stats'))}</span>${cells}</div>`;
  } catch(e) { /* stats are best-effort */ }
}

async function refreshKanbanEvents(){
  if (_currentPanel !== 'kanban' || !_kanbanLatestEventId) return;
  try {
    const eventsEndpoint = '/api/kanban/events';
    const events = await api(eventsEndpoint + _kanbanBoardQuery({since: _kanbanLatestEventId}));
    if (events && Array.isArray(events.events) && events.events.length) {
      _kanbanLatestEventId = Number(events.latest_event_id || events.cursor || _kanbanLatestEventId);
      await loadKanban(true);
      if (_kanbanCurrentTaskId && events.events.some(ev => ev.task_id === _kanbanCurrentTaskId)) await loadKanbanTask(_kanbanCurrentTaskId);
    }
  } catch(e) { /* polling should not spam toasts */ }
}

function _kanbanStartPolling(){
  // Prefer SSE for low-latency live updates. Fall back to polling on
  // browsers without EventSource or after repeated stream failures.
  if (typeof EventSource === 'undefined' || _kanbanEventSourceFailures >= 3) {
    if (_kanbanPollTimer) return;
    _kanbanPollTimer = setInterval(refreshKanbanEvents, 30000);
    return;
  }
  _kanbanStartEventStream();
}

function _kanbanStopPolling(){
  if (_kanbanPollTimer) { clearInterval(_kanbanPollTimer); _kanbanPollTimer = null; }
  if (_kanbanEventSource) { try { _kanbanEventSource.close(); } catch(_) {} _kanbanEventSource = null; }
}

function _kanbanStartEventStream(){
  // Tear down any prior stream before opening a new one (board switch,
  // login change, etc.).
  if (_kanbanEventSource) { try { _kanbanEventSource.close(); } catch(_) {} _kanbanEventSource = null; }
  const since = Number(_kanbanLatestEventId || 0);
  let url = new URL('api/kanban/events/stream' + _kanbanBoardQuery({since: since}), document.baseURI||location.href).href;
  let es;
  try {
    es = new EventSource(url, {withCredentials: true});
  } catch(e) {
    _kanbanEventSourceFailures += 1;
    if (_kanbanEventSourceFailures < 3 && !_kanbanPollTimer) {
      _kanbanPollTimer = setInterval(refreshKanbanEvents, 30000);
    }
    return;
  }
  _kanbanEventSource = es;
  es.addEventListener('hello', (ev) => {
    // Reset the failure counter on a successful handshake.
    _kanbanEventSourceFailures = 0;
  });
  es.addEventListener('events', async (ev) => {
    if (_currentPanel !== 'kanban') return;  // ignore while user is on another panel
    let data;
    try { data = JSON.parse(ev.data); } catch(_) { return; }
    if (!data || !Array.isArray(data.events) || !data.events.length) return;
    _kanbanLatestEventId = Number(data.cursor || _kanbanLatestEventId);
    // Re-fetch the board so the visual state reflects the new events.
    // Throttle: if events are arriving faster than ~1/sec we coalesce.
    _scheduleKanbanRefresh(data.events);
  });
  es.onerror = () => {
    _kanbanEventSourceFailures += 1;
    if (_kanbanEventSourceFailures >= 3) {
      // Give up on SSE for this session — fall back to HTTP polling.
      try { es.close(); } catch(_) {}
      _kanbanEventSource = null;
      if (!_kanbanPollTimer) _kanbanPollTimer = setInterval(refreshKanbanEvents, 30000);
    }
    // EventSource auto-reconnects under the hood; nothing more to do here
    // until we hit the failure limit.
  };
}

let _kanbanRefreshScheduled = false;
let _kanbanRefreshPendingTaskIds = new Set();
function _scheduleKanbanRefresh(events){
  for (const ev of events) {
    if (ev && ev.task_id) _kanbanRefreshPendingTaskIds.add(ev.task_id);
  }
  if (_kanbanRefreshScheduled) return;
  _kanbanRefreshScheduled = true;
  // 250ms debounce — keeps a burst of N events from triggering N reloads.
  setTimeout(async () => {
    _kanbanRefreshScheduled = false;
    const taskIds = Array.from(_kanbanRefreshPendingTaskIds);
    _kanbanRefreshPendingTaskIds.clear();
    if (_currentPanel !== 'kanban') return;
    try {
      await loadKanban(true);
      if (_kanbanCurrentTaskId && taskIds.includes(_kanbanCurrentTaskId)) {
        await loadKanbanTask(_kanbanCurrentTaskId);
      }
    } catch(_) { /* swallow — SSE refresh shouldn't toast */ }
  }, 250);
}

// Build a "?board=<slug>" or "?since=N&board=<slug>" query string fragment
// based on the active board. Empty when the user is on the default board
// AND nobody has explicitly switched (so we don't pin to "default" and
// override a hypothetical server-side switch).
function _kanbanBoardQuery(extra){
  const params = new URLSearchParams();
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
    }
  }
  if (_kanbanCurrentBoard) params.set('board', _kanbanCurrentBoard);
  const s = params.toString();
  return s ? '?' + s : '';
}

async function nudgeKanbanDispatcher(){
  if (_kanbanIsDispatching) return;
  // Dry-run dispatch: show what WOULD be spawned, without actually spawning
  // workers.  Uses ?dry_run=1 so the dispatcher reports its plan without
  // mutating the board.  The result shape includes spawned/skipped_unassigned/
  // skipped_nonspawnable/promoted/auto_blocked so users can diagnose why a
  // Ready task isn't being picked up before they commit to a real run.
  _kanbanIsDispatching = true;
  _setKanbanDispatcherButtonsDisabled(true);
  try {
    const dispatchEndpoint = '/api/kanban/dispatch';
    const result = await api(
      dispatchEndpoint + '?dry_run=1&max=8' + (_kanbanCurrentBoard ? '&board=' + encodeURIComponent(_kanbanCurrentBoard) : ''),
      {method: 'POST'},
    );
    showToast(_kanbanFormatDispatchResult(result, true), 'info', 6000);
    await loadKanban(true);
  } catch(e) {
    showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error');
  } finally {
    _kanbanIsDispatching = false;
    _setKanbanDispatcherButtonsDisabled(false);
  }
}

async function runKanbanDispatcher(){
  if (_kanbanIsDispatching) return;
  // Real dispatch: claims Ready tasks and spawns worker subprocesses
  // (one `hermes -p <assignee>` per claimed row, up to max=8 per call).
  // Confirmation dialog first because this actually consumes API budget on
  // each spawned worker.  Result toast surfaces what happened so users see
  // the dispatcher actually doing work.
  if (!_kanbanCurrentBoard) {
    showToast(t('kanban_unavailable') || 'Kanban unavailable', 'error');
    return;
  }

  _kanbanIsDispatching = true;
  _setKanbanDispatcherButtonsDisabled(true);
  try {
    const ok = await showConfirmDialog({
      title: t('kanban_run_dispatcher') || 'Run dispatcher',
      message: t('kanban_run_dispatcher_confirm')
        || 'This will claim Ready tasks on this board and spawn worker subprocesses (one per task, up to 8 per click). Continue?',
      confirmLabel: t('kanban_run_dispatcher') || 'Run dispatcher',
    });
    if (!ok) return;
    const dispatchEndpoint = '/api/kanban/dispatch';
    const result = await api(
      dispatchEndpoint + '?max=8' + (_kanbanCurrentBoard ? '&board=' + encodeURIComponent(_kanbanCurrentBoard) : ''),
      {method: 'POST'},
    );
    showToast(_kanbanFormatDispatchResult(result, false), 'info', 8000);
    await loadKanban(true);
  } catch(e) {
    showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error');
  } finally {
    _kanbanIsDispatching = false;
    _setKanbanDispatcherButtonsDisabled(false);
  }
}

function _setKanbanDispatcherButtonsDisabled(disabled){
  document.querySelectorAll('.kanban-run-dispatch-btn, .kanban-nudge-dispatch-btn').forEach((btn) => {
    btn.disabled = !!disabled;
    btn.classList.toggle('disabled', !!disabled);
  });
}

function _kanbanFormatDispatchResult(result, dryRun){
  // Produce a human-readable one-line summary of dispatch_once's output so
  // users can see exactly what happened rather than a generic "OK" toast.
  const r = result || {};
  const spawned = (r.spawned || []).length;
  const promoted = r.promoted || 0;
  const reclaimed = r.reclaimed || 0;
  const skippedUnassigned = (r.skipped_unassigned || []).length;
  const skippedNonspawnable = (r.skipped_nonspawnable || []).length;
  const autoBlocked = (r.auto_blocked || []).length;
  const timedOut = (r.timed_out || []).length;
  const crashed = (r.crashed || []).length;
  const verb = dryRun ? (t('kanban_dispatch_preview_prefix') || 'Preview:') : (t('kanban_dispatch_run_prefix') || 'Dispatched:');
  const parts = [];
  parts.push(spawned + ' ' + (t('kanban_dispatch_spawned') || 'spawned'));
  if (promoted) parts.push(promoted + ' ' + (t('kanban_dispatch_promoted') || 'promoted'));
  if (reclaimed) parts.push(reclaimed + ' ' + (t('kanban_dispatch_reclaimed') || 'reclaimed'));
  if (skippedUnassigned) parts.push(skippedUnassigned + ' ' + (t('kanban_dispatch_skipped_unassigned') || 'skipped (no assignee)'));
  if (skippedNonspawnable) parts.push(skippedNonspawnable + ' ' + (t('kanban_dispatch_skipped_nonspawnable') || 'skipped (unknown profile)'));
  if (autoBlocked) parts.push(autoBlocked + ' ' + (t('kanban_dispatch_auto_blocked') || 'auto-blocked'));
  if (timedOut) parts.push(timedOut + ' ' + (t('kanban_dispatch_timed_out') || 'timed out'));
  if (crashed) parts.push(crashed + ' ' + (t('kanban_dispatch_crashed') || 'crashed'));
  return verb + ' ' + parts.join(', ');
}

function _kanbanSelectedTaskIds(){
  const selected = Array.from(document.querySelectorAll('.kanban-card.selected')).map(card => card.dataset.kanbanTaskId).filter(Boolean);
  return selected.length ? selected : (_kanbanCurrentTaskId ? [_kanbanCurrentTaskId] : []);
}

async function bulkUpdateKanban(){
  const ids = _kanbanSelectedTaskIds();
  const status = $('kanbanBulkStatus') ? $('kanbanBulkStatus').value : '';
  if (!ids.length || !status) return;
  try {
    await api('/api/kanban/tasks/bulk' + _kanbanBoardQuery(), {method: 'POST', body: JSON.stringify({task_ids: ids, status})});
    showToast(t('kanban_bulk_action'));
    await loadKanban(true);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

async function blockKanbanTask(taskId){
  try {
    await api('/api/kanban/block' + _kanbanBoardQuery(), {method: 'POST', body: JSON.stringify({task_id: taskId, reason: 'blocked from WebUI'})});
    await loadKanbanTask(taskId);
    await loadKanban(true);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

async function unblockKanbanTask(taskId){
  try {
    await api('/api/kanban/unblock' + _kanbanBoardQuery(), {method: 'POST', body: JSON.stringify({task_id: taskId})});
    await loadKanbanTask(taskId);
    await loadKanban(true);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

function closeKanbanTaskDetail(){
  _kanbanCurrentTaskId = null;
  const preview = $('kanbanTaskPreview');
  if (preview) {
    preview.style.display = 'none';
    preview.innerHTML = '';
  }
  const board = $('kanbanBoard');
  if (board) board.querySelectorAll('.kanban-card').forEach(card => card.classList.remove('selected'));
}

function _kanbanFormatTimestamp(value){
  if (value === undefined || value === null || value === '') return '';
  let date = null;
  if (typeof value === 'number') date = new Date(value > 100000000000 ? value : value * 1000);
  else if (/^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    date = new Date(n > 100000000000 ? n : n * 1000);
  } else {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) return String(value);
  try { return date.toLocaleString(); } catch(e) { return date.toISOString(); }
}

function _kanbanEventSummary(event){
  const kind = event.kind || event.type || 'event';
  const payload = event.payload || event.data || {};
  if (payload && typeof payload === 'object') {
    const parts = [];
    if (payload.status) parts.push(String(payload.status));
    if (payload.reason) parts.push(String(payload.reason));
    if (payload.summary) parts.push(String(payload.summary));
    if (payload.fields && Array.isArray(payload.fields)) parts.push(payload.fields.join(', '));
    if (parts.length) return `${kind}: ${parts.join(' · ')}`;
  }
  return String(kind);
}

function _kanbanFormatDetailValue(value){
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch(e) { return String(value); }
  }
  return String(value);
}

function _kanbanDetailSection(cls, title, inner, emptyKey){
  const content = inner || `<div class="kanban-detail-empty">${esc(t(emptyKey))}</div>`;
  return `<section class="kanban-detail-section ${cls}">
    <h3>${esc(title)}</h3>
    ${content}
  </section>`;
}

function _kanbanCommentHtml(comment){
  const body = comment.body || comment.text || comment.content || '';
  const by = comment.author || comment.created_by || comment.actor || '';
  const at = _kanbanFormatTimestamp(comment.created_at || comment.ts || '');
  return `<div class="kanban-detail-row">
    <div class="kanban-detail-row-main">${_kanbanRenderMarkdown(body)}</div>
    <div class="kanban-detail-row-meta">${esc([by, at].filter(Boolean).join(' · '))}</div>
  </div>`;
}

function _kanbanEventHtml(event){
  const at = _kanbanFormatTimestamp(event.created_at || event.ts || '');
  const payload = _kanbanFormatDetailValue(event.payload || event.data || '');
  return `<div class="kanban-detail-row">
    <div class="kanban-detail-row-main">${esc(_kanbanEventSummary(event))}</div>
    ${payload ? `<pre class="kanban-detail-pre">${esc(payload)}</pre>` : ''}
    <div class="kanban-detail-row-meta">${esc(at)}</div>
  </div>`;
}

function _kanbanRunHtml(run){
  const status = run.status || run.state || run.result || '';
  const label = run.run_id || run.id || run.worker || t('kanban_task');
  const started = _kanbanFormatTimestamp(run.started_at || run.created_at || '');
  const finished = _kanbanFormatTimestamp(run.finished_at || run.completed_at || '');
  const detail = run.error || run.summary || run.log_tail || '';
  return `<div class="kanban-detail-row">
    <div class="kanban-detail-row-main">${esc(label)}${status ? ` · ${esc(status)}` : ''}</div>
    ${detail ? `<pre class="kanban-detail-pre">${esc(_kanbanFormatDetailValue(detail))}</pre>` : ''}
    <div class="kanban-detail-row-meta">${esc([started, finished].filter(Boolean).join(' → '))}</div>
  </div>`;
}

function _kanbanLinksHtml(links){
  const parents = (links && links.parents) || [];
  const children = (links && links.children) || [];
  if (!parents.length && !children.length) return '';
  const item = id => `<code>${esc(id)}</code>`;
  return `<div class="kanban-detail-links-grid">
    <div><strong>${esc(t('kanban_parents'))}</strong><div>${parents.length ? parents.map(item).join(' ') : esc(t('kanban_empty'))}</div></div>
    <div><strong>${esc(t('kanban_children'))}</strong><div>${children.length ? children.map(item).join(' ') : esc(t('kanban_empty'))}</div></div>
  </div>`;
}

async function createKanbanTask(){
  const input = document.getElementById('kanbanNewTaskTitle');
  const title = input ? input.value.trim() : '';
  if (!title) {
    // Empty inline input (or a click on the panel-head "+" via openKanbanCreate)
    // — open the full create-task modal so the user has somewhere obvious to
    // type and configure the task. Mirrors the cron / skills pattern of routing
    // header "+" clicks through to a clearly-modal create surface.
    openKanbanCreate();
    return;
  }
  try {
    const created = await api('/api/kanban/tasks' + _kanbanBoardQuery(), {
      method: 'POST',
      body: JSON.stringify({title}),
    });
    if (input) input.value = '';
    await loadKanban(true);
    if (created && created.task && created.task.id) await loadKanbanTask(created.task.id);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

// ────────────────────────────────────────────────────────────────────────────
// Kanban: create-task modal (panel-head "+" button entry point).
//
// Same `.kanban-modal-overlay` shell as openKanbanCreateBoard() so the two
// flows look and behave identically (centered card, dim backdrop, ESC closes,
// click-on-backdrop closes). The modal markup lives in static/index.html as
// #kanbanTaskModal — see the section just above </body>. Submit hits the
// existing /api/kanban/tasks POST endpoint (which already accepts title, body,
// assignee, tenant, priority, status — see api/kanban_bridge.py:306).
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Kanban: create-task / edit-task modal (panel-head "+" + task-detail Edit
// button entry points).
//
// Single modal serves both flows.  Title + submit-button labels and the
// underlying submit verb (POST vs PATCH) flip based on `_kanbanTaskModalMode`.
//
// Same `.kanban-modal-overlay` shell as openKanbanCreateBoard() so the two
// flows look and behave identically (centered card, dim backdrop, ESC closes,
// click-on-backdrop closes). The modal markup lives in static/index.html as
// #kanbanTaskModal — see the section just above </body>.
//
// The assignee field auto-completes against the union of (a) live Hermes
// profile names from /api/profiles and (b) historical assignees on the
// active board, with an inline hint that explains the dispatcher claim
// contract — most users will pick a profile name from the dropdown rather
// than type one.
// ────────────────────────────────────────────────────────────────────────────

let _kanbanTaskModalMode = 'create';   // 'create' | 'edit'
let _kanbanTaskModalEditingId = null;  // task id when mode === 'edit'
let _kanbanProfileNamesCache = null;   // populated lazily on first modal open
let _kanbanProfileNamesCacheAt = 0;
let _kanbanProvidersCache = null;      // AI 供应商列表缓存（assignee 下拉框数据源）
let _kanbanProvidersCacheAt = 0;
const _KANBAN_PROFILE_NAMES_CACHE_TTL_MS = 30000;
function _invalidateKanbanProfileCache() {
  _kanbanProfileNamesCache = null;
  _kanbanProfileNamesCacheAt = 0;
  _kanbanProvidersCache = null;
  _kanbanProvidersCacheAt = 0;
}
let _kanbanTaskModalFocusCleanup = null;
// Status the modal *displayed* on edit-mode open.  If the user doesn't touch
// the dropdown, we must NOT send `status` in the PATCH payload — otherwise
// editing a task whose real status is non-editable in this dropdown
// (running/blocked/done/archived → mapped to 'triage' for display) would
// silently demote the task on save.  See the regression caught during PR
// review: editing a 'running' task without touching status was reclaiming
// the worker and moving the task back to triage.
let _kanbanTaskModalInitialDisplayedStatus = null;
let _kanbanBoardModalFocusCleanup = null;

async function _kanbanLoadProfileNames(){
  // Hit /api/profiles once per session and cache for a short TTL.
  // Returns an array of profile names (sorted, default first if present).
  const hasFreshCache = (
    Array.isArray(_kanbanProfileNamesCache) &&
    (Date.now() - _kanbanProfileNamesCacheAt) < _KANBAN_PROFILE_NAMES_CACHE_TTL_MS
  );
  if (hasFreshCache) return _kanbanProfileNamesCache;
  try {
    const data = await api('/api/profiles');
    const profiles = Array.isArray(data && data.profiles) ? data.profiles : [];
    const names = profiles.map(p => p && p.name).filter(Boolean);
    // Stable order: default first, then alphabetical.
    names.sort((a, b) => {
      if (a === 'default') return -1;
      if (b === 'default') return 1;
      return a.localeCompare(b);
    });
    _kanbanProfileNamesCache = names;
    _kanbanProfileNamesCacheAt = Date.now();
    return names;
  } catch(_) {
    _kanbanProfileNamesCache = [];
    _kanbanProfileNamesCacheAt = Date.now();
    return [];
  }
}

// _kanbanLoadProviders 获取启用的 AI 供应商列表，作为 assignee 下拉框的数据源。
// 每个 provider 包含 id(provider_id)、display_name、default_model、has_key、models 等字段。
// 修复了原先用 Profile 名称作为 assignee 但后端 worker 用它匹配 Provider 的不匹配问题。
async function _kanbanLoadProviders(){
  const hasFreshCache = (
    Array.isArray(_kanbanProvidersCache) &&
    (Date.now() - _kanbanProvidersCacheAt) < _KANBAN_PROFILE_NAMES_CACHE_TTL_MS
  );
  if (hasFreshCache) return _kanbanProvidersCache;
  try {
    const data = await api('/api/providers');
    const providers = Array.isArray(data && data.providers) ? data.providers : [];
    // 只保留启用的供应商，按 display_name 排序
    const enabled = providers.filter(p => p && p.enabled);
    enabled.sort((a, b) => {
      const an = a.display_name || a.id || '';
      const bn = b.display_name || b.id || '';
      return an.localeCompare(bn);
    });
    _kanbanProvidersCache = enabled;
    _kanbanProvidersCacheAt = Date.now();
    return enabled;
  } catch(_) {
    _kanbanProvidersCache = [];
    _kanbanProvidersCacheAt = Date.now();
    return [];
  }
}

async function _kanbanPopulateAssigneeSelect(currentValue){
  const sel = document.getElementById('kanbanTaskModalAssignee');
  if (!sel) return;
  // 数据源改为 AI 供应商列表（/api/providers），而非 Profile 名称。
  // 这样 assignee 的值就是 provider_id，后端 worker 能正确匹配到供应商。
  const providers = await _kanbanLoadProviders();
  // 历史指派人（来自团队记录）：保留以便编辑旧任务时能回显已删除的 assignee。
  const historicalAssignees = (_kanbanBoard && Array.isArray(_kanbanBoard.assignees))
    ? _kanbanBoard.assignees
    : [];
  const providerIds = new Set(providers.map(p => p.id));
  // 构建选项 HTML
  let html = '';
  if (providers.length) {
    html += `<optgroup label="${esc(t('kanban_assignee_providers_label') || 'AI Providers')}">`;
    for (const p of providers) {
      const val = esc(p.id);
      const selected = p.id === currentValue ? ' selected' : '';
      // 显示格式：DisplayName — DefaultModel（无密钥时标记警告）
      let label = p.display_name || p.id;
      if (p.default_model) {
        label += ' — ' + p.default_model;
      }
      if (!p.has_key) {
        label += ' (' + (t('kanban_no_api_key') || 'no key') + ')';
      }
      html += `<option value="${val}"${selected}>${esc(label)}</option>`;
    }
    html += '</optgroup>';
  }
  // 历史指派人中不在当前供应商列表里的（如已删除的供应商、CLI 创建的任务）
  const extras = [];
  const seen = new Set(providerIds);
  for (const name of historicalAssignees) {
    if (name && !seen.has(name)) { extras.push(name); seen.add(name); }
  }
  if (currentValue && !seen.has(currentValue)) {
    extras.push(currentValue);
    seen.add(currentValue);
  }
  if (extras.length) {
    html += `<optgroup label="${esc(t('kanban_assignee_other_label') || 'Other (legacy / removed)')}">`;
    html += extras.map(v => `<option value="${esc(v)}"${v === currentValue ? ' selected' : ''}>${esc(v)}</option>`).join('');
    html += '</optgroup>';
  }
  // "未分配"选项放在最后
  html += `<option value=""${(!currentValue) ? ' selected' : ''}>${esc(t('kanban_assignee_unassigned') || '— Unassigned (won\u2019t auto-run) —')}</option>`;
  sel.innerHTML = html;
  // 绑定 change 事件：切换供应商时刷新模型 datalist（仅绑定一次）
  if (!sel.dataset.modelSyncBound) {
    sel.dataset.modelSyncBound = '1';
    sel.addEventListener('change', () => {
      _kanbanPopulateModelDatalist(sel.value);
    });
  }
  // 选中供应商变化时，刷新模型 datalist
  _kanbanPopulateModelDatalist(sel.value);
}

// _kanbanPopulateModelDatalist 根据当前选中的 assignee（provider_id）
// 填充模型输入框的 datalist，方便用户从该供应商的模型列表中选择。
function _kanbanPopulateModelDatalist(assigneeId){
  const list = document.getElementById('kanbanTaskModalModelList');
  if (!list) return;
  const providers = Array.isArray(_kanbanProvidersCache) ? _kanbanProvidersCache : [];
  const prov = assigneeId ? providers.find(p => p.id === assigneeId) : null;
  let html = '';
  if (prov) {
    // 优先列出供应商的模型列表
    const models = Array.isArray(prov.models) ? prov.models : [];
    for (const m of models) {
      const id = (m && m.id) || '';
      if (id) html += `<option value="${esc(id)}">${esc(m.label || id)}</option>`;
    }
    // 如果默认模型不在列表里，补充进去
    if (prov.default_model && !models.some(m => m && m.id === prov.default_model)) {
      html += `<option value="${esc(prov.default_model)}">${esc(prov.default_model)}</option>`;
    }
  }
  list.innerHTML = html;
}

function openKanbanCreate(){
  // Make sure the user is on the kanban panel so the resulting board reload is
  // visible behind the modal.
  if (typeof switchPanel === 'function' && _currentPanel !== 'kanban') switchPanel('kanban');
  const modal = document.getElementById('kanbanTaskModal');
  if (!modal) return;
  _kanbanTaskModalMode = 'create';
  _kanbanTaskModalEditingId = null;
  _kanbanTaskModalInitialDisplayedStatus = null;  // create mode: always send status
  // Default new tasks to "ready" so they're immediately claimable by the
  // dispatcher (assuming the user picks an assignee).  Triage is for staging
  // tasks that need human review before being marked actionable; users who
  // want it can still pick it from the status dropdown.
  _kanbanResetTaskModalFields({status: 'ready'});
  _kanbanSetTaskModalStatusHint(null);
  _kanbanSetTaskModalLabels('create');
  _kanbanPopulateAssigneeSelect('').then(() => {
    // After the dropdown is populated, default-select the first provider (not
    // the "Unassigned" fallthrough).  This is the right hint: most users want
    // to assign to *something* — they can pick "Unassigned" deliberately.
    const sel = document.getElementById('kanbanTaskModalAssignee');
    if (sel && sel.options.length > 0 && sel.value === '') {
      const firstProvider = Array.from(sel.options).find(opt => opt.value !== '');
      if (firstProvider) {
        sel.value = firstProvider.value;
        // 刷新模型 datalist 以匹配选中的供应商
        _kanbanPopulateModelDatalist(sel.value);
      }
    }
  });
  _kanbanPopulateTenantDatalist();
  modal.hidden = false;
  if (_kanbanTaskModalFocusCleanup) {
    _kanbanTaskModalFocusCleanup();
    _kanbanTaskModalFocusCleanup = null;
  }
  _kanbanTaskModalFocusCleanup = _trapModalFocus(modal);
  setTimeout(() => {
    const titleEl = document.getElementById('kanbanTaskModalTitleInput');
    if (titleEl) titleEl.focus();
  }, 50);
  document.addEventListener('keydown', _kanbanTaskModalKey);
}

async function openKanbanEdit(taskId){
  // Triggered by the Edit button on the task detail view.  Fetches the task
  // (rather than relying on whatever's cached locally) so the modal always
  // reflects authoritative server state.
  if (!taskId) return;
  if (typeof switchPanel === 'function' && _currentPanel !== 'kanban') switchPanel('kanban');
  const modal = document.getElementById('kanbanTaskModal');
  if (!modal) return;
  let task = null;
  try {
    const data = await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + _kanbanBoardQuery());
    task = data && data.task;
  } catch(e) {
    showToast((t('kanban_unavailable') || 'Kanban unavailable') + ': ' + (e.message || e), 'error');
    return;
  }
  if (!task) return;
  _kanbanTaskModalMode = 'edit';
  _kanbanTaskModalEditingId = task.id;
  // Track the displayed status so submitKanbanTaskModal can detect whether
  // the user actually picked a new value vs. the dropdown's mapped default.
  // Without this, editing a 'running'/'blocked'/'done'/'archived' task whose
  // real status maps to 'triage' for display would silently demote the task
  // (the mapped 'triage' would land in the PATCH payload, and _patch_task
  // would call _set_status_direct → reclaim worker → move to triage).
  const initialDisplayedStatus = _kanbanEditableStatusFor(task.status);
  const originalStatus = task.status || initialDisplayedStatus;
  _kanbanTaskModalInitialDisplayedStatus = initialDisplayedStatus;
  _kanbanResetTaskModalFields({
    title: task.title || '',
    body: task.body || '',
    status: initialDisplayedStatus,
    tenant: task.tenant || '',
    priority: typeof task.priority === 'number' ? task.priority : 0,
    model: task.model || '',
    role_description: task.role_description || '',
    skills: task.skills || '',
    task_flow: task.task_flow || '',
    loop_count: typeof task.loop_count === 'number' ? task.loop_count : 1,
    loop_interval: typeof task.loop_interval === 'number' ? task.loop_interval : 0,
  });
  // Populate the assignee select AFTER reset so the option exists when we
  // call sel.value = currentAssignee.
  await _kanbanPopulateAssigneeSelect(task.assignee || '');
  _kanbanSetTaskModalStatusHint(originalStatus, initialDisplayedStatus);
  _kanbanSetTaskModalLabels('edit');
  _kanbanPopulateTenantDatalist();
  modal.hidden = false;
  if (_kanbanTaskModalFocusCleanup) {
    _kanbanTaskModalFocusCleanup();
    _kanbanTaskModalFocusCleanup = null;
  }
  _kanbanTaskModalFocusCleanup = _trapModalFocus(modal);
  setTimeout(() => {
    const titleEl = document.getElementById('kanbanTaskModalTitleInput');
    if (titleEl) { titleEl.focus(); titleEl.select(); }
  }, 50);
  document.addEventListener('keydown', _kanbanTaskModalKey);
}

function _kanbanEditableStatusFor(status){
  // The modal's status select only offers triage/todo/ready (the user-writable
  // states).  blocked/running/done/archived are reached via the detail-view
  // status buttons or the dispatcher.  Map non-editable states to a sensible
  // default so the user can still change them via the buttons after saving.
  const editable = new Set(['triage', 'todo', 'ready']);
  return editable.has(status) ? status : 'triage';
}

function _kanbanResetTaskModalFields(values){
  const v = values || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = (val == null ? '' : String(val));
  };
  set('kanbanTaskModalTitleInput', v.title || '');
  set('kanbanTaskModalBody', v.body || '');
  set('kanbanTaskModalStatus', v.status || 'triage');
  // Assignee handled separately by _kanbanPopulateAssigneeSelect() because
  // it's a <select> populated from /api/profiles + board history; setting
  // .value before the options exist would silently fail.
  set('kanbanTaskModalTenant', v.tenant || '');
  set('kanbanTaskModalPriority', v.priority != null ? v.priority : 0);
  set('kanbanTaskModalModel', v.model || '');
  // 团队改造新增字段
  set('kanbanTaskModalRoleDescription', v.role_description || '');
  set('kanbanTaskModalSkills', v.skills || '');
  set('kanbanTaskModalTaskFlow', v.task_flow || '');
  set('kanbanTaskModalLoopCount', v.loop_count != null ? v.loop_count : 1);
  set('kanbanTaskModalLoopInterval', v.loop_interval != null ? v.loop_interval : 0);
  const errEl = document.getElementById('kanbanTaskModalError');
  if (errEl) { errEl.textContent = ''; delete errEl.dataset.warningShown; }
  const submitBtn = document.getElementById('kanbanTaskModalSubmit');
  if (submitBtn) submitBtn.disabled = false;
}

function _kanbanSetTaskModalLabels(mode){
  const titleH = document.getElementById('kanbanTaskModalTitle');
  const submitBtn = document.getElementById('kanbanTaskModalSubmit');
  if (mode === 'edit') {
    if (titleH) titleH.textContent = t('kanban_edit_task') || 'Edit task';
    if (submitBtn) submitBtn.textContent = t('save') || 'Save';
  } else {
    if (titleH) titleH.textContent = t('kanban_new_task') || 'New task';
    if (submitBtn) submitBtn.textContent = t('create') || 'Create';
  }
}

function _kanbanSetTaskModalStatusHint(realStatus, editableStatus){
  const hintEl = document.getElementById('kanbanTaskModalStatusOriginalHint');
  if (!hintEl) return;
  if (!realStatus || realStatus === editableStatus) {
    hintEl.hidden = true;
    hintEl.textContent = '';
    return;
  }
  const statusLabel = t(`kanban_status_${realStatus}`) || realStatus;
  hintEl.textContent = String(t('kanban_status_original_hint')).replace('{0}', statusLabel);
  hintEl.hidden = false;
}

function _kanbanPopulateTenantDatalist(){
  const tenants = (_kanbanBoard && Array.isArray(_kanbanBoard.tenants)) ? _kanbanBoard.tenants : [];
  const tList = document.getElementById('kanbanTaskModalTenantList');
  if (tList) tList.innerHTML = tenants.map(v => `<option value="${esc(v)}"></option>`).join('');
}

function _trapModalFocus(modalEl){
  if (!modalEl) return () => {};
  const selector = 'a[href], button, textarea, input, select, summary, [tabindex]:not([tabindex="-1"])';
  const collect = () => {
    const candidates = Array.from(modalEl.querySelectorAll(selector));
    return candidates.filter((el) => {
      if (el.disabled || el.hidden) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.tabIndex >= 0;
    });
  };
  let focusableEls = collect();
  const onKeyDown = (ev) => {
    if (ev.key !== 'Tab') return;
    if (!focusableEls.length) {
      ev.preventDefault();
      return;
    }
    const current = document.activeElement;
    let idx = focusableEls.indexOf(current);
    if (idx === -1) {
      ev.preventDefault();
      focusableEls[0].focus();
      return;
    }
    if (ev.shiftKey) idx -= 1;
    else idx += 1;
    idx = (idx + focusableEls.length) % focusableEls.length;
    ev.preventDefault();
    focusableEls[idx].focus();
  };
  modalEl.addEventListener('keydown', onKeyDown);
  return () => {
    modalEl.removeEventListener('keydown', onKeyDown);
  };
}

function closeKanbanTaskModal(){
  const modal = document.getElementById('kanbanTaskModal');
  if (modal) modal.hidden = true;
  _kanbanTaskModalMode = 'create';
  _kanbanTaskModalEditingId = null;
  _kanbanTaskModalInitialDisplayedStatus = null;
  _kanbanSetTaskModalStatusHint(null, null);
  if (_kanbanTaskModalFocusCleanup) {
    _kanbanTaskModalFocusCleanup();
    _kanbanTaskModalFocusCleanup = null;
  }
  document.removeEventListener('keydown', _kanbanTaskModalKey);
}

function _kanbanTaskModalKey(ev){
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeKanbanTaskModal();
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    // Enter submits except when the focus is in the description textarea
    // (where Enter should insert a newline).
    const target = ev.target;
    if (target && target.tagName === 'TEXTAREA') return;
    const modal = document.getElementById('kanbanTaskModal');
    if (modal && !modal.hidden) {
      ev.preventDefault();
      submitKanbanTaskModal();
    }
  }
}

async function submitKanbanTaskModal(){
  const titleEl = document.getElementById('kanbanTaskModalTitleInput');
  const bodyEl = document.getElementById('kanbanTaskModalBody');
  const statusEl = document.getElementById('kanbanTaskModalStatus');
  const assigneeEl = document.getElementById('kanbanTaskModalAssignee');
  const tenantEl = document.getElementById('kanbanTaskModalTenant');
  const priorityEl = document.getElementById('kanbanTaskModalPriority');
  const modelEl = document.getElementById('kanbanTaskModalModel');
  const roleDescEl = document.getElementById('kanbanTaskModalRoleDescription');
  const skillsEl = document.getElementById('kanbanTaskModalSkills');
  const taskFlowEl = document.getElementById('kanbanTaskModalTaskFlow');
  const loopCountEl = document.getElementById('kanbanTaskModalLoopCount');
  const loopIntervalEl = document.getElementById('kanbanTaskModalLoopInterval');
  const errEl = document.getElementById('kanbanTaskModalError');
  const submitBtn = document.getElementById('kanbanTaskModalSubmit');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) {
    if (errEl) errEl.textContent = t('kanban_title_required') || '任务名称必填';
    if (titleEl) titleEl.focus();
    return;
  }
  // 队员名称必填（团队改造：用于标识聊天对话归属）
  const tenantVal = tenantEl ? tenantEl.value.trim() : '';
  if (!tenantVal) {
    if (errEl) errEl.textContent = t('kanban_tenant_required') || '队员名称必填';
    if (tenantEl) tenantEl.focus();
    return;
  }
  // Build payload — for create we omit defaulted fields so the backend chooses;
  // for edit we send every field so users can clear assignee/tenant/body.
  const isEdit = _kanbanTaskModalMode === 'edit';
  const payload = {title};
  const bodyVal = bodyEl ? bodyEl.value : '';
  const assigneeVal = assigneeEl ? assigneeEl.value.trim() : '';
  const statusVal = statusEl ? statusEl.value : '';
  const priorityRaw = priorityEl ? priorityEl.value : '';
  const modelVal = modelEl ? modelEl.value.trim() : '';
  const roleDescVal = roleDescEl ? roleDescEl.value : '';
  const skillsVal = skillsEl ? skillsEl.value.trim() : '';
  const taskFlowVal = taskFlowEl ? taskFlowEl.value : '';
  const loopCountRaw = loopCountEl ? loopCountEl.value : '1';
  const loopIntervalRaw = loopIntervalEl ? loopIntervalEl.value : '0';
  if (isEdit) {
    payload.body = bodyVal;
    payload.assignee = assigneeVal || null;
    payload.tenant = tenantVal || null;
    payload.model = modelVal || null;
    payload.role_description = roleDescVal;
    payload.skills = skillsVal || null;
    payload.task_flow = taskFlowVal;
    const lc = parseInt(loopCountRaw, 10);
    payload.loop_count = Number.isNaN(lc) || lc < 1 ? 1 : lc;
    const li = parseInt(loopIntervalRaw, 10);
    payload.loop_interval = Number.isNaN(li) || li < 0 ? 0 : li;
    // Only send status if the user actually changed the dropdown from the
    // value the modal opened with.  Otherwise editing a 'running'/'blocked'/
    // 'done'/'archived' task — whose real status maps to the dropdown's
    // 'triage' default — would silently demote the task on every save.
    if (statusVal && statusVal !== _kanbanTaskModalInitialDisplayedStatus) {
      payload.status = statusVal;
    }
    const n = parseInt(priorityRaw, 10);
    payload.priority = Number.isNaN(n) ? 0 : n;
  } else {
    if (bodyVal.trim()) payload.body = bodyVal;
    if (statusVal) payload.status = statusVal;
    if (assigneeVal) payload.assignee = assigneeVal;
    payload.tenant = tenantVal;
    if (modelVal) payload.model = modelVal;
    if (roleDescVal.trim()) payload.role_description = roleDescVal;
    if (skillsVal) payload.skills = skillsVal;
    if (taskFlowVal.trim()) payload.task_flow = taskFlowVal;
    const lc = parseInt(loopCountRaw, 10);
    if (!Number.isNaN(lc) && lc > 0 && lc !== 1) payload.loop_count = lc;
    const li = parseInt(loopIntervalRaw, 10);
    if (!Number.isNaN(li) && li > 0) payload.loop_interval = li;
    if (priorityRaw !== '' && priorityRaw !== '0') {
      const n = parseInt(priorityRaw, 10);
      if (!Number.isNaN(n)) payload.priority = n;
    }
  }
  // Soft warning: a Ready task with the explicit "Unassigned" option will sit
  // forever because the dispatcher skips unassigned rows (kanban_db.py:3567).
  // The dropdown now makes this an explicit choice (the user picked "—
  // Unassigned (won't auto-run) —"), but we still surface a one-time confirm
  // so they don't lose work to a typo.
  if (statusVal === 'ready' && !assigneeVal) {
    if (errEl && !errEl.dataset.warningShown) {
      errEl.textContent = t('kanban_ready_needs_assignee')
        || 'You picked Unassigned + Ready. The dispatcher will skip this task. Submit again to confirm, or pick a profile.';
      errEl.dataset.warningShown = '1';
      const sel = document.getElementById('kanbanTaskModalAssignee');
      if (sel) sel.focus();
      return;
    }
  }
  if (submitBtn) submitBtn.disabled = true;
  if (errEl) { errEl.textContent = ''; delete errEl.dataset.warningShown; }
  try {
    let saved;
    if (isEdit && _kanbanTaskModalEditingId) {
      saved = await api(
        '/api/kanban/tasks/' + encodeURIComponent(_kanbanTaskModalEditingId) + _kanbanBoardQuery(),
        {method: 'PATCH', body: JSON.stringify(payload)},
      );
    } else {
      saved = await api('/api/kanban/tasks' + _kanbanBoardQuery(), {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    closeKanbanTaskModal();
    await loadKanban(true);
    const savedId = saved && saved.task && saved.task.id;
    if (savedId) {
      await loadKanbanTask(savedId);
    } else if (isEdit && _kanbanTaskModalEditingId) {
      await loadKanbanTask(_kanbanTaskModalEditingId);
    }
  } catch(e) {
    if (errEl) errEl.textContent = (e.message || String(e));
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function updateKanbanTask(taskId, patch, opts){
  if (!taskId || !patch) return;
  try {
    const openDetail = !opts || opts.openDetail !== false;
    const updated = await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + _kanbanBoardQuery(), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await loadKanban(true);
    if (openDetail) await loadKanbanTask((updated && updated.task && updated.task.id) || taskId);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

async function addKanbanComment(taskId){
  const input = document.getElementById('kanbanCommentInput');
  const body = input ? input.value.trim() : '';
  if (!taskId || !body) return;
  try {
    await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + '/comments' + _kanbanBoardQuery(), {
      method: 'POST',
      body: JSON.stringify({body}),
    });
    if (input) input.value = '';
    await loadKanbanTask(taskId);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

function _kanbanRenderTaskDetail(data){
  const task = data.task || {};
  const title = _kanbanTaskTitle(task);
  const body = _kanbanTaskBody(task) || t('kanban_no_description');
  const meta = _kanbanTaskMeta(task);
  // 团队改造：详情面板简化为任务信息 + 状态操作 + 跳转聊天按钮
  // 移除了评论/事件/链接/运行/日志区域和评论表单
  const statusButtons = ['triage', 'todo', 'ready', 'blocked', 'done', 'archived'].map(status =>
    `<button class="btn secondary" onclick="updateKanbanTask('${esc(task.id)}',{status:'${status}'})">${esc(_kanbanColumnLabel(status))}</button>`
  ).join('') + `<button class="btn secondary" onclick="blockKanbanTask('${esc(task.id)}')">${esc(t('kanban_block'))}</button><button class="btn secondary" onclick="unblockKanbanTask('${esc(task.id)}')">${esc(t('kanban_unblock'))}</button>`;
  const sessionId = task.session_id || '';
  const jumpBtn = `<button class="btn primary" onclick="_kanbanJumpToChat('${esc(task.id)}')" data-i18n="kanban_open_chat">${esc(t('kanban_open_chat') || '打开聊天对话')}</button>`;
  return `<div class="kanban-task-preview-header">
      <button class="btn secondary kanban-back-btn" onclick="closeKanbanTaskDetail()">${esc(t('kanban_back_to_board'))}</button>
      <div class="kanban-task-preview-title">${esc(title)}</div>
      <button class="btn secondary kanban-edit-btn" onclick="openKanbanEdit('${esc(task.id)}')" data-i18n="kanban_edit_task" title="${esc(t('kanban_edit_task') || '编辑任务')}">${esc(t('kanban_edit_task') || '编辑任务')}</button>
    </div>
    <div class="kanban-task-preview-body">${_kanbanRenderMarkdown(body)}</div>
    ${meta.length ? `<div class="kanban-meta">${esc(meta.join(' · '))}</div>` : ''}
    <div class="kanban-status-actions">${statusButtons}</div>
    ${jumpBtn ? `<div class="kanban-jump-chat">${jumpBtn}</div>` : ''}
    <div class="kanban-delete-actions"><button class="btn danger" onclick="deleteKanbanTask('${esc(task.id)}')" data-i18n="kanban_delete_task">${esc(t('kanban_delete_task') || '删除任务')}</button></div>`;
}

async function deleteKanbanTask(taskId){
  if (!taskId) return;
  if (!confirm(t('kanban_delete_confirm') || '确定要删除这个任务吗？此操作不可恢复。')) return;
  try {
    await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + _kanbanBoardQuery(), {method: 'DELETE'});
    closeKanbanTaskDetail();
    await loadKanban(true);
    showToast(t('kanban_task_deleted') || '任务已删除');
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

async function loadKanbanTask(taskId){
  if (!taskId) return;
  try {
    const data = await api('/api/kanban/tasks/' + encodeURIComponent(taskId) + _kanbanBoardQuery());
    // 团队改造：不再获取 worker 日志（日志区域已移除）
    _kanbanCurrentTaskId = taskId;
    const task = data.task || {};
    const title = _kanbanTaskTitle(task);
    const board = $('kanbanBoard');
    if (board) {
      board.querySelectorAll('.kanban-card').forEach(card => card.classList.remove('selected'));
      Array.from(board.querySelectorAll('.kanban-card')).find(card => card.dataset.kanbanTaskId === taskId)?.classList.add('selected');
      // 同步更新卡片上的 session_id（编辑后可能新增）
      if (task.session_id) {
        const card = Array.from(board.querySelectorAll('.kanban-card')).find(c => c.dataset.kanbanTaskId === taskId);
        if (card) { card.dataset.sessionId = task.session_id; }
      }
    }
    const preview = $('kanbanTaskPreview');
    if (preview) {
      preview.style.display = '';
      preview.innerHTML = _kanbanRenderTaskDetail(data);
    }
    showToast(`${t('kanban_task')}: ${title}`);
  } catch(e) { showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error'); }
}

// Phase 2: Single-source-of-truth render.
//
// Reads `S.todos` (set by the `todo_state` SSE listener, INFLIGHT
// restore, or session cold-load — see _hydrateTodosFromSession in
// ui.js).  When `S.todoStateMeta` is null we have never seen an
// explicit signal and fall through to the legacy reverse-scan over
// settled tool messages — this keeps the panel populated against
// pre-Phase-1 servers and during the upgrade window.
//
// The render is short-circuited via `_todosLastRenderedHash` (defined
// in ui.js): repeated emissions that yield identical DOM are no-ops.
// Coalescing of bursty live updates happens upstream in
// scheduleTodosRefresh().
function loadTodos() {
  const panel = $('todoPanel');
  if (!panel) return;

  let todos;
  if (S.todoStateMeta) {
    todos = Array.isArray(S.todos) ? S.todos : [];
  } else {
    todos = _legacyTodosFromMessages();
  }

  if (!todos.length) {
    if (typeof _todosLastRenderedHash !== 'undefined' && _todosLastRenderedHash === '__empty__') return;
    panel.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:4px 0">${esc(t('todos_no_active'))}</div>`;
    if (typeof _todosLastRenderedHash !== 'undefined') _todosLastRenderedHash = '__empty__';
    return;
  }

  if (typeof _todosHash === 'function' && typeof _todosLastRenderedHash !== 'undefined') {
    const hash = _todosHash(todos);
    if (hash === _todosLastRenderedHash) return;
    _todosLastRenderedHash = hash;
  }

  const statusIcon = {pending:li('square',14), in_progress:li('loader',14), completed:li('check',14), cancelled:li('x',14)};
  const statusColor = {pending:'var(--muted)', in_progress:'var(--blue)', completed:'rgba(100,200,100,.8)', cancelled:'rgba(200,100,100,.5)'};
  // Single innerHTML join is the cheapest correct way to materialize
  // ~10–50 leaf nodes.  All user-controlled content goes through esc().
  panel.innerHTML = todos.map(td => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:14px;display:inline-flex;align-items:center;flex-shrink:0;margin-top:1px;color:${statusColor[td.status]||'var(--muted)'}">${statusIcon[td.status]||li('square',14)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:${td.status==='completed'?'var(--muted)':td.status==='in_progress'?'var(--text)':'var(--text)'};${td.status==='completed'?'text-decoration:line-through;opacity:.5':''};line-height:1.4">${esc(td.content)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;opacity:.6">${esc(td.id)} · ${esc(td.status)}</div>
      </div>
    </div>`).join('');
}

// Legacy fallback: reverse-scan settled tool messages for the most
// recent {"todos":[...]} payload.  Used only when no `todo_state`
// signal has been seen for the current session — primarily during
// upgrade windows where the server has not yet been redeployed with
// Phase 1.  Once Phase 1 is universally deployed and a stabilization
// period has passed, this can be removed (Phase 3).
//
// Variable name `sourceMessages` is preserved verbatim from the
// original loadTodos() implementation so the matching regression
// test (R-todo-survive-refresh in tests/test_regressions.py) keeps
// catching any future refactor that drops the raw-session-messages
// fallback. See the test for the exact contract.
function _legacyTodosFromMessages() {
  const sourceMessages = (S.session && Array.isArray(S.session.messages) && S.session.messages.length) ? S.session.messages : S.messages;
  if (!Array.isArray(sourceMessages)) return [];
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (!m || m.role !== 'tool') continue;
    let content = m.content;
    if (typeof content !== 'string') {
      try { content = JSON.stringify(content); } catch (_) { continue; }
    }
    if (!content || content.indexOf('"todos"') < 0) continue;
    try {
      const d = JSON.parse(content);
      if (d && Array.isArray(d.todos)) return d.todos;
    } catch (_) {}
  }
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Kanban: multi-board switcher + create/rename/archive modal
// ────────────────────────────────────────────────────────────────────────────
//
// The bridge exposes /api/kanban/boards (GET/POST), /boards/<slug>
// (PATCH/DELETE), and /boards/<slug>/switch (POST). The UI surfaces these
// as a "Default ▾" dropdown next to the Board title — clicking it opens
// a menu listing every board (current first, with task counts), plus
// actions to create / rename / archive.

const KANBAN_BOARD_LS_KEY = 'hermes-kanban-active-board';

function _kanbanGetSavedBoard(){
  try { return localStorage.getItem(KANBAN_BOARD_LS_KEY) || null; } catch(_) { return null; }
}

function _kanbanSetSavedBoard(slug){
  try {
    if (slug && slug !== 'default') localStorage.setItem(KANBAN_BOARD_LS_KEY, slug);
    else localStorage.removeItem(KANBAN_BOARD_LS_KEY);
  } catch(_) {}
}

async function loadKanbanBoards(){
  // Fetches the boards list and updates the switcher UI. Best-effort —
  // failures hide the switcher rather than blocking the panel from rendering.
  const switcher = document.getElementById('kanbanBoardSwitcher');
  if (!switcher) return;
  let data;
  try {
    data = await api('/api/kanban/boards');
  } catch(e) {
    // Hide switcher on error so the user isn't stuck with a half-broken UI.
    switcher.hidden = true;
    return;
  }
  const boards = (data && data.boards) || [];
  const serverCurrent = (data && data.current) || 'default';
  _kanbanBoardsList = boards;
  // Resolution chain for the active board:
  //   localStorage hint → server's `current` → 'default'.
  // The localStorage hint is honoured ONLY if it points at a board that
  // still exists; otherwise we fall back to the server's pointer.
  const saved = _kanbanGetSavedBoard();
  let active = serverCurrent;
  if (saved && boards.some(b => b.slug === saved)) {
    active = saved;
  } else if (saved) {
    _kanbanSetSavedBoard('default');
  }
  _kanbanCurrentBoard = (active === 'default') ? null : active;
  // The switcher is visible whenever ≥1 non-default board exists OR the
  // current board is non-default. (If you only have 'default', a switcher
  // adds clutter without value.)
  const hasMultiple = boards.length > 1 || (active !== 'default');
  switcher.hidden = !hasMultiple;
  if (!hasMultiple) return;
  // Update the toggle label/icon
  const activeMeta = boards.find(b => b.slug === active) || {slug: active, name: active};
  const nameEl = document.getElementById('kanbanBoardSwitcherName');
  if (nameEl) nameEl.textContent = activeMeta.name || activeMeta.slug || 'Default';
  // Re-render the menu (in case it was open or changed)
  _renderKanbanBoardMenu(boards, active);
}

function _renderKanbanBoardMenu(boards, current){
  const menu = document.getElementById('kanbanBoardSwitcherMenu');
  if (!menu) return;
  const items = boards.map(b => {
    const isCurrent = b.slug === current;
    const total = (b.total != null) ? b.total : (b.counts ? Object.values(b.counts).reduce((a,c)=>a+Number(c||0),0) : 0);
    return `<button type="button" class="kanban-board-switcher-item ${isCurrent ? 'is-current' : ''}" role="menuitem" data-board-slug="${esc(b.slug)}" onclick="switchKanbanBoard('${esc(b.slug)}')">
      <span class="kanban-board-switcher-item-icon">${isCurrent ? '✓' : ''}</span>
      <span class="kanban-board-switcher-item-name">${esc(b.name || b.slug)}</span>
      <span class="kanban-board-switcher-item-count">${esc(String(total))}</span>
    </button>`;
  }).join('');
  // Actions row — disable rename/archive when the only option is `default`
  // (the default board's display metadata is editable but the slug isn't,
  // and `default` cannot be archived).
  const renameDisabled = current === 'default';
  const archiveDisabled = current === 'default';
  const actions = `
    <div class="kanban-board-switcher-divider" role="separator"></div>
    <button type="button" class="kanban-board-switcher-action" onclick="openKanbanCreateBoard()" data-i18n="kanban_new_board">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>${esc(t('kanban_new_board') || 'New board…')}</span>
    </button>
    <button type="button" class="kanban-board-switcher-action" onclick="openKanbanRenameBoard()" ${renameDisabled ? 'disabled' : ''} data-i18n="kanban_rename_board">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <span>${esc(t('kanban_rename_board') || 'Rename current board…')}</span>
    </button>
    <button type="button" class="kanban-board-switcher-action danger" onclick="archiveKanbanBoard()" ${archiveDisabled ? 'disabled' : ''} data-i18n="kanban_archive_board">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      <span>${esc(t('kanban_archive_board') || 'Archive current board…')}</span>
    </button>
  `;
  menu.innerHTML = items + actions;
}

function toggleKanbanBoardMenu(ev){
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('kanbanBoardSwitcherMenu');
  const toggle = document.getElementById('kanbanBoardSwitcherToggle');
  if (!menu || !toggle) return;
  _kanbanBoardMenuOpen = !_kanbanBoardMenuOpen;
  menu.hidden = !_kanbanBoardMenuOpen;
  toggle.setAttribute('aria-expanded', String(_kanbanBoardMenuOpen));
  if (_kanbanBoardMenuOpen) {
    // Click-away close
    setTimeout(() => {
      document.addEventListener('click', _kanbanCloseBoardMenuOnOutside, {once: true, capture: true});
    }, 0);
  }
}

function _kanbanCloseBoardMenuOnOutside(ev){
  const switcher = document.getElementById('kanbanBoardSwitcher');
  if (!switcher || !switcher.contains(ev.target)) {
    _kanbanBoardMenuOpen = false;
    const menu = document.getElementById('kanbanBoardSwitcherMenu');
    const toggle = document.getElementById('kanbanBoardSwitcherToggle');
    if (menu) menu.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  } else {
    // Re-arm the listener — the user clicked inside the switcher, possibly
    // the toggle button which we want to handle through its own onclick.
    setTimeout(() => {
      document.addEventListener('click', _kanbanCloseBoardMenuOnOutside, {once: true, capture: true});
    }, 0);
  }
}

async function switchKanbanBoard(slug){
  if (!slug) return;
  const newBoard = (slug === 'default') ? null : slug;
  if (newBoard === _kanbanCurrentBoard) {
    // No-op switch — just close the menu.
    _kanbanBoardMenuOpen = false;
    const menu = document.getElementById('kanbanBoardSwitcherMenu');
    if (menu) menu.hidden = true;
    return;
  }
  _kanbanCurrentBoard = newBoard;
  _kanbanSetSavedBoard(slug);
  _kanbanLatestEventId = 0;  // reset cursor — new board has its own event sequence
  _kanbanBoardMenuOpen = false;
  const menu = document.getElementById('kanbanBoardSwitcherMenu');
  if (menu) menu.hidden = true;
  // Tell the server too (sets the on-disk active-board pointer for CLI/dashboard).
  try {
    await api('/api/kanban/boards/' + encodeURIComponent(slug) + '/switch', {method: 'POST'});
  } catch(e) {
    // Local UI switch still happens — the on-disk pointer is for cross-process
    // consistency, not for our own rendering.
  }
  // Re-open the SSE stream on the new board.
  _kanbanStopPolling();
  await loadKanban(true);
  await loadKanbanBoards();
  _kanbanStartPolling();
}

// ── Create / rename / archive board modals ──────────────────────────────────

function openKanbanCreateBoard(){
  const modal = document.getElementById('kanbanBoardModal');
  if (!modal) return;
  document.getElementById('kanbanBoardModalMode').value = 'create';
  document.getElementById('kanbanBoardModalSlug').value = '';
  document.getElementById('kanbanBoardModalTitle').textContent = t('kanban_new_board') || 'New board';
  document.getElementById('kanbanBoardModalName').value = '';
  document.getElementById('kanbanBoardModalSlugInput').value = '';
  document.getElementById('kanbanBoardModalSlugInput').disabled = false;
  document.getElementById('kanbanBoardModalSlugRow').style.display = '';
  document.getElementById('kanbanBoardModalDesc').value = '';
  document.getElementById('kanbanBoardModalError').textContent = '';
  modal.hidden = false;
  if (_kanbanBoardModalFocusCleanup) {
    _kanbanBoardModalFocusCleanup();
    _kanbanBoardModalFocusCleanup = null;
  }
  _kanbanBoardModalFocusCleanup = _trapModalFocus(modal);
  // Auto-focus name field
  setTimeout(() => document.getElementById('kanbanBoardModalName').focus(), 50);
  // Auto-suggest slug from name as user types
  const nameEl = document.getElementById('kanbanBoardModalName');
  const slugEl = document.getElementById('kanbanBoardModalSlugInput');
  let userEditedSlug = false;
  slugEl.addEventListener('input', () => { userEditedSlug = true; }, {once: false});
  const onName = () => {
    if (!userEditedSlug) {
      slugEl.value = String(nameEl.value || '').toLowerCase().replace(/[^a-z0-9-_ ]+/g, '').replace(/\s+/g, '-').slice(0, 48);
    }
  };
  nameEl.removeEventListener('input', nameEl._kanbanOnNameInput || (() => {}));
  nameEl._kanbanOnNameInput = onName;
  nameEl.addEventListener('input', onName);
  // Close on Escape
  document.addEventListener('keydown', _kanbanBoardModalEsc);
}

function openKanbanRenameBoard(){
  const modal = document.getElementById('kanbanBoardModal');
  if (!modal) return;
  const current = _kanbanCurrentBoard || 'default';
  if (current === 'default') return;  // default's slug is immutable
  const meta = (_kanbanBoardsList || []).find(b => b.slug === current);
  if (!meta) return;
  document.getElementById('kanbanBoardModalMode').value = 'rename';
  document.getElementById('kanbanBoardModalSlug').value = current;
  document.getElementById('kanbanBoardModalTitle').textContent = t('kanban_rename_board') || 'Rename board';
  document.getElementById('kanbanBoardModalName').value = meta.name || '';
  document.getElementById('kanbanBoardModalSlugInput').value = current;
  document.getElementById('kanbanBoardModalSlugInput').disabled = true;  // slug is immutable
  // Hide the slug row — it's locked, less visual noise.
  document.getElementById('kanbanBoardModalSlugRow').style.display = 'none';
  document.getElementById('kanbanBoardModalDesc').value = meta.description || '';
  document.getElementById('kanbanBoardModalError').textContent = '';
  modal.hidden = false;
  if (_kanbanBoardModalFocusCleanup) {
    _kanbanBoardModalFocusCleanup();
    _kanbanBoardModalFocusCleanup = null;
  }
  _kanbanBoardModalFocusCleanup = _trapModalFocus(modal);
  setTimeout(() => document.getElementById('kanbanBoardModalName').focus(), 50);
  document.addEventListener('keydown', _kanbanBoardModalEsc);
}

function _kanbanBoardModalEsc(ev){
  if (ev.key === 'Escape') closeKanbanBoardModal();
}

function closeKanbanBoardModal(){
  const modal = document.getElementById('kanbanBoardModal');
  if (modal) modal.hidden = true;
  if (_kanbanBoardModalFocusCleanup) {
    _kanbanBoardModalFocusCleanup();
    _kanbanBoardModalFocusCleanup = null;
  }
  document.removeEventListener('keydown', _kanbanBoardModalEsc);
}

async function submitKanbanBoardModal(){
  const errEl = document.getElementById('kanbanBoardModalError');
  errEl.textContent = '';
  const mode = document.getElementById('kanbanBoardModalMode').value;
  const name = (document.getElementById('kanbanBoardModalName').value || '').trim();
  const slugInput = (document.getElementById('kanbanBoardModalSlugInput').value || '').trim();
  const description = (document.getElementById('kanbanBoardModalDesc').value || '').trim();
  const submitBtn = document.getElementById('kanbanBoardModalSubmit');
  if (!name) {
    errEl.textContent = t('kanban_board_name_required') || 'Name is required';
    return;
  }
  if (mode === 'create') {
    if (!slugInput) {
      errEl.textContent = t('kanban_board_slug_required') || 'Slug is required';
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await api('/api/kanban/boards', {
        method: 'POST',
        body: JSON.stringify({slug: slugInput, name, description, switch: true}),
      });
      closeKanbanBoardModal();
      // Switch to the new board and reload
      const newSlug = (res && res.board && res.board.slug) || slugInput;
      _kanbanCurrentBoard = (newSlug === 'default') ? null : newSlug;
      _kanbanSetSavedBoard(newSlug);
      _kanbanLatestEventId = 0;
      _kanbanStopPolling();
      await loadKanban(true);
      await loadKanbanBoards();
      _kanbanStartPolling();
    } catch(e) {
      errEl.textContent = (e && (e.message || e.error)) || String(e);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  } else if (mode === 'rename') {
    const slug = document.getElementById('kanbanBoardModalSlug').value;
    if (!slug) { errEl.textContent = 'Missing slug'; return; }
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api('/api/kanban/boards/' + encodeURIComponent(slug), {
        method: 'PATCH',
        body: JSON.stringify({name, description}),
      });
      closeKanbanBoardModal();
      await loadKanbanBoards();  // refresh switcher label/icon
    } catch(e) {
      errEl.textContent = (e && (e.message || e.error)) || String(e);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }
}

async function archiveKanbanBoard(){
  const current = _kanbanCurrentBoard || 'default';
  if (current === 'default') return;
  const meta = (_kanbanBoardsList || []).find(b => b.slug === current);
  const label = meta && meta.name ? meta.name : current;
  const ok = await showConfirmDialog({
    title: t('kanban_archive_board') || 'Archive board',
    message: (t('kanban_archive_board_confirm') || 'Archive board "{name}"? Tasks remain on disk and the board can be restored from kanban/boards/_archived/.').replace('{name}', label),
    confirmLabel: t('kanban_archive_board') || 'Archive',
    danger: true,
    focusCancel: true,
  });
  if (!ok) return;
  // CRITICAL: stop the SSE stream BEFORE the archive call. The library's
  // kb.connect(board=<slug>) auto-creates the on-disk directory + DB on
  // first call — so any in-flight stream that polls task_events while
  // we're archiving will silently re-materialise the directory we just
  // moved to _archived/. Tearing down the stream first avoids that race.
  _kanbanStopPolling();
  try {
    await api('/api/kanban/boards/' + encodeURIComponent(current), {method: 'DELETE'});
    // Server falls back to default — match that locally.
    _kanbanCurrentBoard = null;
    _kanbanSetSavedBoard('default');
    _kanbanLatestEventId = 0;
    await loadKanban(true);
    await loadKanbanBoards();
    _kanbanStartPolling();
    showToast(t('kanban_board_archived') || 'Board archived');
  } catch(e) {
    // Restart the stream on failure so the UI doesn't go stale.
    _kanbanStartPolling();
    showToast(t('kanban_unavailable') + ': ' + (e.message || e), 'error');
  }
}


// ── Logs panel ──
function _selectedLogsFile() {
  const el = $('logsFile');
  const value = (el && el.value) || 'agent';
  return value || 'agent';
}

function _selectedLogsTail() {
  const el = $('logsTail');
  const value = Number((el && el.value) || 200);
  return [100,200,500,1000].includes(value) ? value : 200;
}

function _severityForLine(line) {
  const text = String(line || '').toUpperCase();
  if (/\b(ERROR|CRITICAL|TRACEBACK)\b/.test(text)) return 'error';
  if (/\b(WARNING|WARN)\b/.test(text)) return 'warning';
  if (/\b(DEBUG)\b/.test(text)) return 'debug';
  if (/\b(INFO)\b/.test(text)) return 'info';
  return 'other';
}

function _filteredLogsLines() {
  if (_logsSeverityFilter === 'all') return _lastLogsLines;
  return _lastLogsLines.filter(line => {
    const sev = _severityForLine(line);
    if (_logsSeverityFilter === 'errors') return sev === 'error';
    if (_logsSeverityFilter === 'warnings') return sev === 'warning' || sev === 'error';
    return true;
  });
}

function _applyLogsSeverityFilter() {
  const el = $('logsSeverityFilter');
  _logsSeverityFilter = (el && el.value) || 'all';
  // Re-render from cached lines without re-fetching
  _renderLogs({ lines: _lastLogsLines, hint: '', truncated: false, _fromFilter: true });
}

function _logLineSeverityClass(line) {
  const text = String(line || '').toUpperCase();
  if (/\b(WARNING|WARN)\b/.test(text)) return 'log-line-warning';
  if (/\b(DEBUG)\b/.test(text)) return 'log-line-debug';
  if (/\b(INFO)\b/.test(text)) return 'log-line-info';
  if (/\b(ERROR|CRITICAL|TRACEBACK)\b/.test(text)) return 'log-line-error';
  return '';
}

function _syncLogsWrap() {
  const out = $('logsOutput');
  const wrap = $('logsWrap');
  if (out && wrap) out.classList.toggle('wrap', !!wrap.checked);
}

async function loadLogs(animate) {
  const box = $('logsOutput');
  const status = $('logsStatus');
  const refreshBtn = $('logsRefreshBtn');
  if (!box) return;
  if (animate && refreshBtn) {
    refreshBtn.style.opacity = '0.5';
    refreshBtn.disabled = true;
  }
  const file = _selectedLogsFile();
  const tail = _selectedLogsTail();
  try {
    if (status) status.textContent = t('logs_loading');
    const data = await api('/api/logs?file=' + encodeURIComponent(file) + '&tail=' + encodeURIComponent(tail));
    _updateLogsFileSelect(data.files || []);
    _renderLogs(data);
  } catch(e) {
    _lastLogsLines = [];
    box.innerHTML = `<div class="logs-empty">${esc(t('error_prefix') + e.message)}</div>`;
    if (status) status.textContent = t('logs_load_failed');
  } finally {
    if (animate && refreshBtn) {
      refreshBtn.style.opacity = '';
      refreshBtn.disabled = false;
    }
    _syncLogsAutoRefresh();
  }
}

function _updateLogsFileSelect(files) {
  const select = $('logsFile');
  if (!select) return;
  const current = select.value;
  const known = new Set(['agent','errors','gateway','system','dev','app']);
  const sorted = [];
  const knownOrder = ['agent','system','gateway','errors','dev','app'];
  for (const k of knownOrder) { if (files.includes(k)) sorted.push(k); }
  for (const f of files) { if (!known.has(f)) sorted.push(f); }
  let html = '';
  for (const f of sorted) {
    const label = t('logs_file_' + f) || f;
    html += `<option value="${esc(f)}"${f === current ? ' selected' : ''}>${esc(label)}</option>`;
  }
  select.innerHTML = html;
  if (!sorted.includes(current) && sorted.length) select.value = sorted[0];
}

function _renderLogs(data) {
  const box = $('logsOutput');
  const status = $('logsStatus');
  if (!box) return;
  const rawLines = Array.isArray(data && data.lines) ? data.lines : [];
  // Only update cache when loading fresh data (not when re-rendering from filter)
  if (data && !data._fromFilter) _lastLogsLines = rawLines.slice();
  const displayLines = _filteredLogsLines();
  const hint = data && data.hint ? `<div class="logs-hint">${esc(data.hint)}</div>` : '';
  const truncated = data && data.truncated ? `<div class="logs-hint warn">${esc(t('logs_truncated_hint'))}</div>` : '';
  const filterNote = _logsSeverityFilter !== 'all'
    ? `<div class="logs-hint">${esc(displayLines.length + ' / ' + _lastLogsLines.length + ' ' + t('logs_filter_active'))}</div>`
    : '';
  if (!displayLines.length) {
    box.innerHTML = `${hint}${truncated}${filterNote}<div class="logs-empty">${esc(t('logs_empty'))}</div>`;
  } else {
    box.innerHTML = `${hint}${truncated}${filterNote}` + displayLines.map(line => {
      const cls = _logLineSeverityClass(line);
      return `<div class="log-line ${cls}">${esc(line)}</div>`;
    }).join('');
  }
  _syncLogsWrap();
  if (status) {
    const bytes = data && Number(data.total_bytes || 0);
    const when = data && data.mtime ? new Date(data.mtime * 1000).toLocaleString() : t('logs_no_mtime');
    status.textContent = `${rawLines.length} / ${data.tail || _selectedLogsTail()} lines · ${bytes.toLocaleString()} bytes · ${when}`;
  }
}

function _startLogsAutoRefresh() {
  if (_logsAutoRefreshTimer) return;
  _logsAutoRefreshTimer = setInterval(() => {
    if (_currentPanel !== 'logs') { _stopLogsAutoRefresh(); return; }
    const toggle = $('logsAutoRefresh');
    if (toggle && !toggle.checked) return;
    loadLogs(false);
  }, 5000);
}

function _stopLogsAutoRefresh() {
  if (_logsAutoRefreshTimer) {
    clearInterval(_logsAutoRefreshTimer);
    _logsAutoRefreshTimer = null;
  }
}

function _syncLogsAutoRefresh() {
  const toggle = $('logsAutoRefresh');
  if (_currentPanel === 'logs' && (!toggle || toggle.checked)) _startLogsAutoRefresh();
  else _stopLogsAutoRefresh();
}

async function copyLogsAll() {
  const lines = _filteredLogsLines();
  const text = lines.join('\n');
  try {
    await _copyText(text);
    showToast(t('logs_copied'));
  } catch(e) {
    showToast(t('copy_failed'), 'error');
  }
}

// ── Insights panel ──
async function loadInsights(animate) {
  const box = $('insightsContent');
  const refreshBtn = $('insightsRefreshBtn');
  if (!box) return;
  if (animate && refreshBtn) {
    refreshBtn.style.opacity = '0.5';
    refreshBtn.disabled = true;
  }
  const period = ($('insightsPeriod') || {}).value || '30';
  try {
    const [data, skillUsage] = await Promise.all([
      api(`/api/insights?days=${period}`),
      api('/api/skills/usage').catch(() => ({usage:{}, skill_names:[], total_invocations:0, unique_skills_used:0})),
    ]);
    _renderInsights(data, box, skillUsage);
    if (typeof _syncSystemHealthMonitorVisibility === 'function') _syncSystemHealthMonitorVisibility();
    if (typeof pollSystemHealth === 'function') void pollSystemHealth();
  } catch(e) {
    box.innerHTML = `<div style="color:var(--accent);font-size:12px">${esc(t('error_prefix') + e.message)}</div>`;
  } finally {
    if (animate && refreshBtn) {
      refreshBtn.style.opacity = '';
      refreshBtn.disabled = false;
    }
  }
}

function _renderSystemHealthPanel() {
  return `
    <section class="insights-card system-health-panel loading" id="systemHealthPanel" aria-label="${esc(t('system_health_aria'))}" aria-live="polite">
      <div class="system-health-head">
        <div>
          <div class="insights-card-title">${esc(t('system_health_title'))}</div>
          <div class="system-health-sub">${esc(t('system_health_sub'))}</div>
        </div>
        <span class="system-health-status" id="systemHealthStatus"><span class="system-health-dot" aria-hidden="true"></span>${esc(t('system_health_loading'))}</span>
      </div>
      <div class="system-health-metrics">
        <div class="system-health-metric" data-system-health-metric="cpu">
          <div class="system-health-label"><span>${esc(t('system_health_cpu'))}</span><span class="system-health-value" data-system-health-value>—</span></div>
          <div class="system-health-bar" role="progressbar" aria-label="${esc(t('system_health_cpu_usage'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="system-health-bar-fill"></div></div>
        </div>
        <div class="system-health-metric" data-system-health-metric="memory">
          <div class="system-health-label"><span>${esc(t('system_health_ram'))}</span><span class="system-health-value" data-system-health-value>—</span></div>
          <div class="system-health-bar" role="progressbar" aria-label="${esc(t('system_health_ram_usage'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="system-health-bar-fill"></div></div>
        </div>
        <div class="system-health-metric" data-system-health-metric="disk">
          <div class="system-health-label"><span>${esc(t('system_health_disk'))}</span><span class="system-health-value" data-system-health-value>—</span></div>
          <div class="system-health-bar" role="progressbar" aria-label="${esc(t('system_health_disk_usage'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="system-health-bar-fill"></div></div>
        </div>
      </div>
      <div class="system-health-foot">${esc(t('system_health_foot'))}</div>
    </section>`;
}

/**
 * Bucket daily token rows for chart display.
 * Returns rows unchanged when length <= 30 (per-day resolution).
 * For longer ranges, groups consecutive days into buckets:
 *   31–90 days → 2-day buckets
 *   91–180 days → 3-day buckets
 *   181–365 days → 8-day buckets
 * Result is always <= ~52 bars.
 * Each bucket row has:
 *   - label: short label for axis (e.g. MM-DD or MM-DD–MM-DD)
 *   - title: full tooltip title (e.g. 2026-01-01 – 2026-01-05)
 *   - date: first date in bucket (used for date label slicing)
 *   - input_tokens, output_tokens, sessions, cost: summed across bucket
 */
function _bucketDailyTokensForChart(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const len = rows.length;
  if (len <= 30) return rows;  // per-day resolution for 7/30-day ranges

  // Target <= 75 bars; derive bucket size
  let bucketSize;
  if (len <= 90) {
    bucketSize = 2;
  } else if (len <= 180) {
    bucketSize = 3;
  } else if (len <= 365) {
    bucketSize = 8;  // <=52 bars for 365 days (ceil(365/8)=46)
  } else {
    bucketSize = 8;  // fallback for >365 (shouldn't occur in practice)
  }

  const result = [];
  for (let i = 0; i < len; i += bucketSize) {
    const slice = rows.slice(i, i + bucketSize);
    const input_tokens = slice.reduce((s, r) => s + Number(r.input_tokens || 0), 0);
    const output_tokens = slice.reduce((s, r) => s + Number(r.output_tokens || 0), 0);
    const sessions = slice.reduce((s, r) => s + Number(r.sessions || 0), 0);
    const cost = slice.reduce((s, r) => s + Number(r.cost || 0), 0);

    const firstDate = slice[0].date;
    const lastDate = slice[slice.length - 1].date;

    // Label: short form for axis
    const firstLabel = String(firstDate).slice(5);  // MM-DD
    const lastLabel = String(lastDate).slice(5);
    const label = (firstDate === lastDate) ? firstLabel : (firstLabel + '–' + lastLabel);

    result.push({
      label,
      title: firstDate + (firstDate !== lastDate ? ' – ' + lastDate : ''),
      date: firstDate,
      input_tokens,
      output_tokens,
      sessions,
      cost,
    });
  }
  return result;
}

function _renderSkillUsage(d) {
  const usage = d.usage || {};
  const skillNames = d.skill_names || [];
  const totalInvocations = d.total_invocations || 0;
  const uniqueUsed = d.unique_skills_used || 0;
  const entries = Object.entries(usage)
    .map(([name, meta]) => [name, Number(meta && meta.use_count) || 0, Number(meta && meta.view_count) || 0, Number(meta && meta.patch_count) || 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (!entries.length) {
    return `<div class="insights-card" id="skillUsageCard"><div class="insights-card-title">${esc(t('insights_skill_usage_title'))}</div><div class="insights-empty">${esc(t('insights_skill_usage_no_data'))}</div><div style="font-size:11px;color:var(--muted);margin-top:4px">${esc(t('insights_skill_usage_no_data_hint'))}</div></div>`;
  }
  const rows = entries.map(([name, useCount, viewCount, patchCount]) => {
    const share = totalInvocations > 0 ? (useCount / totalInvocations * 100).toFixed(1) : '0.0';
    return `<div class="insights-table-row"><span class="insights-model-name" title="${esc(name)}">${esc(name)}</span><span>${useCount}</span><span>${viewCount}</span><span>${patchCount}</span><span>${share}%</span></div>`;
  }).join('');
  return `<div class="insights-card" id="skillUsageCard"><div class="insights-card-title">${esc(t('insights_skill_usage_title'))}</div><div class="skill-usage-grid" style="margin-bottom:8px"><div><span>${esc(t('insights_skill_usage_total'))}</span><strong>${totalInvocations.toLocaleString()}</strong></div><div><span>${esc(t('insights_skill_usage_skills_used'))}</span><strong>${uniqueUsed}/${skillNames.length}</strong></div></div><div class="insights-table skill-usage-table"><div class="insights-table-head"><span>${esc(t('insights_skill_usage_col_skill'))}</span><span>${esc(t('insights_skill_usage_col_uses'))}</span><span>${esc(t('insights_skill_usage_col_views'))}</span><span>${esc(t('insights_skill_usage_col_patches'))}</span><span>${esc(t('insights_skill_usage_col_share'))}</span></div>${rows}</div><div class="skill-usage-footer" style="margin-top:8px">${esc(t('insights_skill_usage_footer'))}</div></div>`;
}

function _renderInsights(d, box, skillUsage) {
  const fmtNum = n => Number(n || 0).toLocaleString();
  const fmtCost = c => {
    const value = Number(c || 0);
    return value > 0 ? '$' + value.toFixed(value < 1 ? 4 : 2) : t('insights_no_cost');
  };
  const fmtTokens = n => {
    const value = Number(n || 0);
    return value >= 1e6 ? (value/1e6).toFixed(1) + 'M' : value >= 1e3 ? (value/1e3).toFixed(1) + 'K' : fmtNum(value);
  };

  // Overview cards
  const overviewCards = [
    { label: t('insights_sessions'), value: fmtNum(d.total_sessions), icon: li('message-square', 18) },
    { label: t('insights_messages'), value: fmtNum(d.total_messages), icon: li('hash', 18) },
    { label: t('insights_tokens'), value: fmtTokens(d.total_tokens), icon: li('cpu', 18) },
    { label: t('insights_cost'), value: fmtCost(d.total_cost), icon: li('dollar-sign', 18) },
  ];

  // Daily token trend — bucket long ranges to avoid horizontal overflow
  const dailyTokens = Array.isArray(d.daily_tokens) ? d.daily_tokens : [];
  const chartRows = _bucketDailyTokensForChart(dailyTokens);
  let dailyHtml = '';
  if (chartRows.length) {
    const maxDailyTokens = Math.max(...chartRows.map(r => Number(r.input_tokens || 0) + Number(r.output_tokens || 0)), 1);
    const labelEvery = Math.max(Math.ceil(chartRows.length / 7), 1);
    dailyHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_daily_tokens'))}</div><div class="insights-daily-token-chart">` +
      chartRows.map((r, idx) => {
        const input = Number(r.input_tokens || 0);
        const output = Number(r.output_tokens || 0);
        const inputPct = Math.max((input / maxDailyTokens) * 100, input ? 2 : 0).toFixed(1);
        const outputPct = Math.max((output / maxDailyTokens) * 100, output ? 2 : 0).toFixed(1);
        const showLabel = idx === 0 || idx === chartRows.length - 1 || idx % labelEvery === 0;
        const titleDate = r.title || r.date;
        const title = `${titleDate} · ${fmtTokens(input)} ${t('insights_input_tokens')} · ${fmtTokens(output)} ${t('insights_output_tokens')} · ${fmtCost(r.cost)} · ${fmtNum(r.sessions)} ${t('insights_sessions')}`;
        const labelText = r.label !== undefined ? r.label : String(r.date).slice(5);
        return `<div class="insights-daily-bar" title="${esc(title)}"><div class="insights-daily-stack" aria-label="${esc(title)}"><div class="insights-daily-bar-output" style="height:${outputPct}%"></div><div class="insights-daily-bar-input" style="height:${inputPct}%"></div></div><span>${showLabel ? esc(labelText) : ''}</span></div>`;
      }).join('') +
      `</div><div class="insights-daily-legend"><span><i class="insights-daily-legend-input"></i>${esc(t('insights_input_tokens'))}</span><span><i class="insights-daily-legend-output"></i>${esc(t('insights_output_tokens'))}</span></div></div>`;
  } else {
    dailyHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_daily_tokens'))}</div><div class="insights-empty">${esc(t('insights_no_usage_data'))}</div></div>`;
  }

  // Models table
  let modelsHtml = '';
  if (d.models && d.models.length) {
    modelsHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_models'))}</div><div class="insights-table insights-model-table"><div class="insights-table-head"><span>${esc(t('insights_model_name'))}</span><span>${esc(t('insights_model_sessions'))}</span><span>${esc(t('insights_model_tokens'))}</span><span>${esc(t('insights_model_cost'))}</span><span>${esc(t('insights_model_share'))}</span></div>` +
      d.models.map(m => {
        const share = Number(m.cost_share || m.token_share || m.session_share || 0);
        const title = `${m.model} · ${fmtTokens(m.input_tokens)} ${t('insights_input_tokens')} · ${fmtTokens(m.output_tokens)} ${t('insights_output_tokens')}`;
        return `<div class="insights-table-row"><span class="insights-model-name" title="${esc(m.model)}">${esc(m.model)}</span><span>${fmtNum(m.sessions)}</span><span class="insights-model-tokens" title="${esc(title)}">${fmtTokens(m.total_tokens || 0)}</span><span class="insights-model-cost">${fmtCost(m.cost)}</span><span>${share}%</span></div>`;
      }).join('') +
      `</div></div>`;
  } else {
    modelsHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_models'))}</div><div class="insights-empty">${esc(t('insights_no_usage_data'))}</div></div>`;
  }

  // Activity by day of week
  let dowHtml = '';
  if (d.activity_by_day) {
    const maxDow = Math.max(...d.activity_by_day.map(x => x.sessions), 1);
    dowHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_activity_by_day'))}</div><div class="insights-bars">` +
      d.activity_by_day.map(r => {
        const pct = (r.sessions / maxDow * 100).toFixed(0);
        return `<div class="insights-bar-row"><span class="insights-bar-label">${r.day}</span><div class="insights-bar-track"><div class="insights-bar-fill" style="width:${pct}%"></div></div><span class="insights-bar-value">${r.sessions}</span></div>`;
      }).join('') +
      `</div></div>`;
  }

  // Activity by hour
  let hodHtml = '';
  if (d.activity_by_hour) {
    const maxHod = Math.max(...d.activity_by_hour.map(x => x.sessions), 1);
    const peakHour = d.activity_by_hour.reduce((a, b) => b.sessions > a.sessions ? b : a, {hour:0,sessions:0});
    hodHtml = `<div class="insights-card"><div class="insights-card-title">${esc(t('insights_activity_by_hour'))} <span style="font-weight:400;font-size:11px;color:var(--muted)">${esc(t('insights_peak_hour').replace('{hour}', peakHour.hour + ':00'))}</span></div><div class="insights-bars">` +
      d.activity_by_hour.map(r => {
        const pct = (r.sessions / maxHod * 100).toFixed(0);
        const isPeak = r.hour === peakHour.hour && peakHour.sessions > 0;
        return `<div class="insights-bar-row"><span class="insights-bar-label">${String(r.hour).padStart(2,'0')}</span><div class="insights-bar-track"><div class="insights-bar-fill${isPeak ? ' insights-bar-peak' : ''}" style="width:${pct}%"></div></div><span class="insights-bar-value">${r.sessions}</span></div>`;
      }).join('') +
      `</div></div>`;
  }

  // Token breakdown
  const tokenCards = `
    <div class="insights-card">
      <div class="insights-card-title">${esc(t('insights_token_breakdown'))}</div>
      <div class="insights-token-row">
        <span class="insights-token-label">${esc(t('insights_input_tokens'))}</span>
        <span class="insights-token-value">${fmtTokens(d.total_input_tokens)}</span>
      </div>
      <div class="insights-token-row">
        <span class="insights-token-label">${esc(t('insights_output_tokens'))}</span>
        <span class="insights-token-value">${fmtTokens(d.total_output_tokens)}</span>
      </div>
      <div class="insights-token-row insights-token-total">
        <span class="insights-token-label">${esc(t('insights_total'))}</span>
        <span class="insights-token-value">${fmtTokens(d.total_tokens)}</span>
      </div>
    </div>`;

  box.innerHTML = `
    ${_renderSystemHealthPanel()}
    ${_renderSkillUsage(skillUsage)}
    <div class="insights-grid">
      ${overviewCards.map(c => `<div class="insights-stat"><div class="insights-stat-icon">${c.icon}</div><div class="insights-stat-info"><div class="insights-stat-value">${c.value}</div><div class="insights-stat-label">${esc(c.label)}</div></div></div>`).join('')}
    </div>
    ${dailyHtml}
    <div class="insights-row insights-usage-grid">
      ${tokenCards}
      ${modelsHtml}
    </div>
    ${dowHtml}
    ${hodHtml}
    <div style="text-align:center;color:var(--muted);font-size:10px;margin-top:12px;opacity:.6">${esc(t('insights_footer').replace('{days}', d.period_days))}</div>
  `;
}

async function clearConversation() {
  if(!S.session) return;
  const _clrMsg=await showConfirmDialog({title:t('clear_conversation_title'),message:t('clear_conversation_message'),confirmLabel:t('clear'),danger:true,focusCancel:true});
  if(!_clrMsg) return;
  try {
    const data = await api('/api/session/clear', {method:'POST',
      body: JSON.stringify({session_id: S.session.session_id})});
    S.session = data.session;
    S.messages = [];
    S.toolCalls = [];
    syncTopbar();
    renderMessages();
    showToast(t('conversation_cleared'));
  } catch(e) { setStatus(t('clear_failed') + e.message); }
}

// ── Skills panel ──
async function loadSkills() {
  if (_skillsData) { renderSkills(_skillsData); return; }
  const box = $('skillsList');
  try {
    const data = await api('/api/skills');
    _skillsData = data.skills || [];
    // Prune collapsed state to only keep categories present in fresh data,
    // avoiding stale keys when categories are renamed or removed server-side.
    const liveCats = new Set(_skillsData.map(s => s.category || '(general)'));
    for (const c of _collapsedCats) { if (!liveCats.has(c)) _collapsedCats.delete(c); }
    renderSkills(_skillsData);
  } catch(e) { box.innerHTML = `<div style="padding:12px;color:var(--accent);font-size:12px">Error: ${esc(e.message)}</div>`; }
}

let _collapsedCats = new Set(); // persisted collapsed state across re-renders

function _toggleCatCollapse(cat) {
  if (_collapsedCats.has(cat)) _collapsedCats.delete(cat);
  else _collapsedCats.add(cat);
  // Toggle DOM without full re-render
  document.querySelectorAll('.skills-category').forEach(sec => {
    const header = sec.querySelector('.skills-cat-header');
    if (header && header.dataset.cat === cat) {
      const collapsed = _collapsedCats.has(cat);
      sec.classList.toggle('collapsed', collapsed);
      header.querySelector('.cat-chevron').style.transform = collapsed ? '' : 'rotate(90deg)';
      sec.querySelectorAll('.skill-item').forEach(el => el.style.display = collapsed ? 'none' : '');
    }
  });
}

function renderSkills(skills) {
  const query = ($('skillsSearch').value || '').toLowerCase();
  const filtered = query ? skills.filter(s =>
    (s.name||'').toLowerCase().includes(query) ||
    (s.dir_name||'').toLowerCase().includes(query) ||
    (s.description||'').toLowerCase().includes(query) ||
    (s.category||'').toLowerCase().includes(query)
  ) : skills;
  // Group by category
  const cats = {};
  for (const s of filtered) {
    const cat = s.category || '(general)';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(s);
  }
  const box = $('skillsList');
  box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px">${esc(t('skills_no_match'))}</div>`; return; }
  for (const [cat, items] of Object.entries(cats).sort()) {
    const collapsed = _collapsedCats.has(cat);
    const sec = document.createElement('div');
    sec.className = 'skills-category' + (collapsed ? ' collapsed' : '');
    const hdr = document.createElement('div');
    hdr.className = 'skills-cat-header';
    hdr.dataset.cat = cat;
    hdr.innerHTML = `<span class="cat-chevron" style="display:inline-flex;transition:transform .15s;${collapsed ? '' : 'transform:rotate(90deg)'}">${li('chevron-right',12)}</span> ${esc(cat)} <span style="opacity:.5">(${items.length})</span>`;
    hdr.onclick = () => _toggleCatCollapse(cat);
    sec.appendChild(hdr);
    for (const skill of items.sort((a,b) => a.name.localeCompare(b.name))) {
      const el = document.createElement('div');
      const isDisabled = skill.enabled === false;
      el.className = 'skill-item' + (isDisabled ? ' disabled' : '');
      el.style.display = collapsed ? 'none' : '';
      const toggle = document.createElement('span');
      toggle.className = 'skill-toggle' + (isDisabled ? '' : ' enabled');
      toggle.title = isDisabled ? t('skill_disabled') : t('skill_enabled');
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleSkill(skill.name, !isDisabled);
      });
      const nameEl = document.createElement('span');
      nameEl.className = 'skill-name';
      nameEl.textContent = skill.dir_name || skill.name;
      nameEl.dataset.skillName = skill.name;
      const descEl = document.createElement('span');
      descEl.className = 'skill-desc';
      descEl.textContent = skill.description || '';
      el.append(toggle, nameEl, descEl);
      el.onclick = () => openSkill(skill.name, el);
      sec.appendChild(el);
    }
    box.appendChild(sec);
  }
}

function filterSkills() {
  if (_skillsData) renderSkills(_skillsData);
}


async function toggleSkill(name, currentlyEnabled) {
  const newEnabled = !currentlyEnabled;
  try {
    const result = await api('/api/skills/toggle', {
      method: 'POST',
      body: JSON.stringify({ name, enabled: newEnabled })
    });
    if (result && result.ok) {
      if (_skillsData) {
        const skill = _skillsData.find(s => s.name === name);
        if (skill) skill.enabled = newEnabled;
      }
      if(typeof window!=='undefined'&&typeof window.invalidateSlashSkillCaches==='function') window.invalidateSlashSkillCaches();
      renderSkills(_skillsData || []);
    } else {
      setStatus((result && result.error) || t('skill_toggle_failed'));
    }
  } catch(e) {
    setStatus(t('skill_toggle_failed') + e.message);
  }
}

// Currently selected skill detail — kept across panel switches so re-entering
// the Skills view shows the last-viewed skill.
let _currentSkillDetail = null; // { name, category, content }
let _skillMode = 'empty'; // 'empty' | 'read' | 'create' | 'edit'
let _skillPreFormDetail = null; // snapshot of previously-viewed skill when entering a form
let _editingSkillName = null;

function _stripYamlFrontmatter(content) {
  if (!content) return { frontmatter: null, body: '' };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length) };
}

function _skillMarkdownHtml(markdown) {
  return `<div class="preview-md">${renderMd(markdown || '')}</div>`;
}

function _enhanceSkillMarkdown(root) {
  if (!root) return;
  requestAnimationFrame(() => {
    const mdRoot = root.querySelector('.preview-md') || root;
    if (typeof highlightCode === 'function') highlightCode(mdRoot);
    if (typeof renderKatexBlocks === 'function') renderKatexBlocks(mdRoot);
  });
}

function _renderSkillDetail(name, content, linkedFiles) {
  const title = $('skillDetailTitle');
  const body = $('skillDetailBody');
  const empty = $('skillDetailEmpty');
  const editBtn = $('btnEditSkillDetail');
  const delBtn = $('btnDeleteSkillDetail');
  if (title) title.textContent = name;
  const { frontmatter, body: markdownBody } = _stripYamlFrontmatter(content);
  let html = '';
  if (frontmatter) {
    html += `<details class="skill-frontmatter"><summary>${esc(t('skill_metadata'))}</summary><pre><code>${esc(frontmatter)}</code></pre></details>`;
  }
  html += _skillMarkdownHtml(markdownBody || '(no content)');
  const lf = linkedFiles || {};
  const categories = Object.entries(lf).filter(([,files]) => files && files.length > 0);
  if (categories.length) {
    html += `<div class="skill-linked-files"><div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">${esc(t('linked_files'))}</div>`;
    for (const [cat, files] of categories) {
      html += `<div class="skill-linked-section"><h4>${esc(cat)}</h4>`;
      for (const f of files) {
        html += `<a class="skill-linked-file" href="#" data-skill-name="${esc(name)}" data-skill-file="${esc(f)}">${esc(f)}</a>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  body.innerHTML = `<div class="main-view-content skill-detail-content">${html}</div>`;
  _enhanceSkillMarkdown(body);
  body.querySelectorAll('.skill-linked-file').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); openSkillFile(a.dataset.skillName, a.dataset.skillFile); });
  });
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _skillMode = 'read';
  _setSkillHeaderButtons('read');
}

function _renderSkillError(name, message) {
  const title = $('skillDetailTitle');
  const body = $('skillDetailBody');
  const empty = $('skillDetailEmpty');
  if (title) title.textContent = name;
  if (body) {
    body.innerHTML = `<div class="main-view-content"><div class="detail-form-error" style="display:block">${esc(message || t('skill_load_failed'))}</div></div>`;
    body.style.display = '';
  }
  if (empty) empty.style.display = 'none';
  _currentSkillDetail = null;
  _skillMode = 'empty';
  _setSkillHeaderButtons('empty');
}

function _setSkillHeaderButtons(mode) {
  const editBtn = $('btnEditSkillDetail');
  const delBtn = $('btnDeleteSkillDetail');
  const cancelBtn = $('btnCancelSkillDetail');
  const saveBtn = $('btnSaveSkillDetail');
  const show = b => b && (b.style.display = '');
  const hide = b => b && (b.style.display = 'none');
  if (mode === 'read') { show(editBtn); show(delBtn); hide(cancelBtn); hide(saveBtn); }
  else if (mode === 'create' || mode === 'edit') { hide(editBtn); hide(delBtn); show(cancelBtn); show(saveBtn); }
  else { hide(editBtn); hide(delBtn); hide(cancelBtn); hide(saveBtn); }
}

async function openSkill(name, el) {
  // Highlight active skill in the sidebar list
  document.querySelectorAll('.skill-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  _skillPreFormDetail = null;
  _editingSkillName = null;
  try {
    const data = await api(`/api/skills/content?name=${encodeURIComponent(name)}`);
    if (data && (data.success === false || data.error)) {
      const message = data.error || t('skill_load_failed');
      _renderSkillError(name, message);
      setStatus(t('skill_load_failed') + message);
      return;
    }
    _currentSkillDetail = { name, content: data.content || '', linked_files: data.linked_files || {}, knowledge_paths: data.knowledge_paths || [], category: data.category || '' };
    _renderSkillDetail(name, data.content || '', data.linked_files || {});
  } catch(e) { setStatus(t('skill_load_failed') + e.message); }
}

async function openSkillFile(skillName, filePath) {
  try {
    const data = await api(`/api/skills/content?name=${encodeURIComponent(skillName)}&file=${encodeURIComponent(filePath)}`);
    if (data && data.error) {
      _renderSkillError(skillName, data.error);
      setStatus(t('skill_file_load_failed') + data.error);
      return;
    }
    const body = $('skillDetailBody');
    if (!body) return;
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const isMd = ['md','markdown'].includes(ext);
    const backLabel = t('skills_back_to').replace('{0}', skillName);
    const header = `<div class="skill-file-breadcrumb"><a href="#" class="skill-file-back" data-skill-name="${esc(skillName)}">&larr; ${esc(backLabel)}</a><span class="skill-file-path">${esc(filePath)}</span></div>`;
    let content;
    if (isMd) {
      content = `<div class="main-view-content">${_skillMarkdownHtml(data.content || '')}</div>`;
    } else {
      const escaped = esc(data.content || '');
      content = `<pre class="skill-file-code"><code>${escaped}</code></pre>`;
    }
    body.innerHTML = header + content;
    body.style.display = '';
    const empty = $('skillDetailEmpty');
    if (empty) empty.style.display = 'none';
    body.querySelectorAll('.skill-file-back').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        if (_currentSkillDetail && _currentSkillDetail.name === a.dataset.skillName) {
          _renderSkillDetail(_currentSkillDetail.name, _currentSkillDetail.content, _currentSkillDetail.linked_files);
        } else {
          openSkill(a.dataset.skillName, null);
        }
      });
    });
    if (isMd) _enhanceSkillMarkdown(body);
    else requestAnimationFrame(() => { if (typeof highlightCode === 'function') highlightCode(); });
  } catch(e) { setStatus(t('skill_file_load_failed') + e.message); }
}

function editCurrentSkill() {
  if (!_currentSkillDetail) return;
  const s = _currentSkillDetail;
  // 优先从 API 返回的 category 获取，回退到 _skillsData 列表查找
  let category = s.category || '';
  if (!category && _skillsData) {
    const match = _skillsData.find(x => x.name === s.name);
    if (match) category = match.category || '';
  }
  _skillPreFormDetail = { name: s.name, content: s.content, linked_files: s.linked_files };
  _editingSkillName = s.name;
  _skillMode = 'edit';
  _renderSkillForm({ name: s.name, category, content: s.content || '', isEdit: true, knowledgePaths: s.knowledge_paths || [] });
}

function openSkillCreate() {
  if (typeof switchPanel === 'function' && _currentPanel !== 'skills') switchPanel('skills');
  _skillPreFormDetail = _currentSkillDetail ? { ..._currentSkillDetail } : null;
  _editingSkillName = null;
  _skillMode = 'create';
  _renderSkillForm({ name: '', category: '', content: '', isEdit: false, knowledgePaths: [] });
}

function _renderSkillForm({ name, category, content, isEdit, knowledgePaths }) {
  const title = $('skillDetailTitle');
  const body = $('skillDetailBody');
  const empty = $('skillDetailEmpty');
  if (!body || !title) return;
  title.textContent = isEdit ? t('skills_edit') + ' · ' + name : t('new_skill');
  const nameDisabled = isEdit ? 'disabled' : '';
  const nameHint = isEdit ? `<div class="detail-form-hint">${esc(t('skill_rename_not_supported') || 'Renaming a skill is not supported. Create a new skill and delete the old one to rename.')}</div>` : '';
  const kp = Array.isArray(knowledgePaths) ? knowledgePaths : [];
  const pathsHtml = kp.map((p, i) => `<div class="skill-path-item" data-path="${esc(p)}"><span class="skill-path-text" title="${esc(p)}">${esc(p)}</span><button type="button" class="skill-path-remove" onclick="_removeSkillPath(${i})" aria-label="Remove">×</button></div>`).join('');
  body.innerHTML = `
    <div class="main-view-content">
      <form class="detail-form" onsubmit="event.preventDefault(); saveSkillForm();">
        <div class="detail-form-row">
          <label for="skillFormName">${esc(t('skill_name') || 'Name')}</label>
          <input type="text" id="skillFormName" value="${esc(name || '')}" placeholder="my-skill" autocomplete="off" ${nameDisabled} required>
          ${nameHint}
        </div>
        <div class="detail-form-row">
          <label for="skillFormCategory">${esc(t('skill_category') || 'Category')}</label>
          <input type="text" id="skillFormCategory" value="${esc(category || '')}" placeholder="${esc(t('skill_category_placeholder') || 'Optional, e.g. devops')}" autocomplete="off">
        </div>
        <div class="detail-form-row">
          <label for="skillFormContent">${esc(t('skill_content') || 'SKILL.md content')}</label>
          <textarea id="skillFormContent" rows="18" placeholder="${esc(t('skill_content_placeholder') || 'YAML frontmatter + markdown body')}">${esc(content || '')}</textarea>
        </div>
        <div class="detail-form-row">
          <label>${esc(t('skill_knowledge_paths') || 'Knowledge paths')}</label>
          <div id="skillFormPathsList" class="skill-paths-list">${pathsHtml}</div>
          <div class="skill-paths-buttons">
            <button type="button" class="btn secondary" onclick="_openSkillPathBrowser()">${esc(t('skill_browse_path') || 'Browse...')}</button>
            <button type="button" class="btn secondary" onclick="_addSkillPathManual()">${esc(t('skill_add_path_manual') || 'Add path manually')}</button>
          </div>
          <div class="detail-form-hint">${esc(t('skill_knowledge_paths_hint') || 'Select .md files or directories. Paths will be written to SKILL.md frontmatter so the AI can find resources.')}</div>
        </div>
        <div id="skillFormError" class="detail-form-error" style="display:none"></div>
      </form>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _setSkillHeaderButtons(isEdit ? 'edit' : 'create');
  const focusEl = isEdit ? $('skillFormCategory') : $('skillFormName');
  if (focusEl) focusEl.focus();
}

function cancelSkillForm() {
  _editingSkillName = null;
  if (_skillPreFormDetail) {
    const snap = _skillPreFormDetail;
    _skillPreFormDetail = null;
    _currentSkillDetail = snap;
    _renderSkillDetail(snap.name, snap.content || '', snap.linked_files || {});
    return;
  }
  // Revert to empty state
  _skillPreFormDetail = null;
  _currentSkillDetail = null;
  _skillMode = 'empty';
  const body = $('skillDetailBody');
  const empty = $('skillDetailEmpty');
  const title = $('skillDetailTitle');
  if (body) { body.innerHTML = ''; body.style.display = 'none'; }
  if (empty) empty.style.display = '';
  if (title) title.textContent = '';
  _setSkillHeaderButtons('empty');
}

async function saveSkillForm() {
  const nameInput = $('skillFormName');
  const catInput = $('skillFormCategory');
  const contentInput = $('skillFormContent');
  const errEl = $('skillFormError');
  if (!nameInput || !contentInput || !errEl) return;
  const name = (nameInput.value || '').trim().toLowerCase().replace(/\s+/g, '-');
  const category = (catInput ? (catInput.value || '').trim() : '');
  const content = contentInput.value;
  const knowledgePaths = _getSkillPaths();
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = t('skill_name_required'); errEl.style.display = ''; return; }
  if (!content.trim()) { errEl.textContent = t('content_required'); errEl.style.display = ''; return; }
  try {
    await api('/api/skills/save', {method:'POST', body: JSON.stringify({name, category: category||undefined, content, knowledge_paths: knowledgePaths})});
    showToast(_editingSkillName ? t('skill_updated') : t('skill_created'));
    _skillsData = null;
    _cronSkillsCache = null;
    if(typeof window!=='undefined'&&typeof window.invalidateSlashSkillCaches==='function') window.invalidateSlashSkillCaches();
    _editingSkillName = null;
    _skillPreFormDetail = null;
    await loadSkills();
    // Reload the saved skill in read mode with fresh content
    const match = document.querySelectorAll('.skill-item');
    let targetEl = null;
    match.forEach(el => {
      const nm = el.querySelector('.skill-name');
      // 匹配 name 或 dir_name
      if (nm && (nm.textContent === name || nm.dataset.skillName === name)) targetEl = el;
    });
    await openSkill(name, targetEl);
  } catch(e) { errEl.textContent = t('error_prefix') + e.message; errEl.style.display = ''; }
}

// Back-compat aliases (delete flow + any old callers)
const submitSkillSave = saveSkillForm;
function toggleSkillForm(){ openSkillCreate(); }

// ── Skill knowledge paths management ──
function _getSkillPaths() {
  const list = $('skillFormPathsList');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.skill-path-item')).map(el => el.dataset.path || '');
}

function _addSkillPath(path) {
  path = (path || '').trim().replace(/\\/g, '/');
  if (!path) return;
  const list = $('skillFormPathsList');
  if (!list) return;
  // 去重
  const existing = _getSkillPaths();
  if (existing.includes(path)) return;
  const i = existing.length;
  const item = document.createElement('div');
  item.className = 'skill-path-item';
  item.dataset.path = path;
  item.innerHTML = `<span class="skill-path-text" title="${esc(path)}">${esc(path)}</span><button type="button" class="skill-path-remove" onclick="_removeSkillPath(${i})" aria-label="Remove">×</button>`;
  list.appendChild(item);
}

function _removeSkillPath(index) {
  const list = $('skillFormPathsList');
  if (!list) return;
  const items = list.querySelectorAll('.skill-path-item');
  if (items[index]) items[index].remove();
  // 重新编号 onclick 索引
  const remaining = list.querySelectorAll('.skill-path-item');
  remaining.forEach((el, i) => {
    const btn = el.querySelector('.skill-path-remove');
    if (btn) btn.setAttribute('onclick', `_removeSkillPath(${i})`);
  });
}

async function _addSkillPathManual() {
  const path = prompt(t('skill_add_path_prompt') || 'Enter file or directory path:');
  if (path) _addSkillPath(path);
}

let _skillPathBrowserState = { current: '', parent: '' };

async function _openSkillPathBrowser() {
  // 创建模态框
  let modal = $('skillPathBrowserModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'skillPathBrowserModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content skill-path-browser">
        <div class="modal-header">
          <h3 id="skillPathBrowserTitle">${esc(t('skill_browse_path') || 'Browse...')}</h3>
          <button class="modal-close" onclick="_closeSkillPathBrowser()">×</button>
        </div>
        <div class="modal-body">
          <div id="skillPathBrowserCurrent" class="skill-path-current"></div>
          <button type="button" class="btn secondary skill-path-up" id="skillPathBrowserUp" onclick="_navigateSkillPathBrowser(_skillPathBrowserState.parent)">↑ ${esc(t('skill_parent_dir') || 'Up')}</button>
          <button type="button" class="btn secondary skill-path-select-dir" id="skillPathBrowserSelectDir" onclick="_selectSkillPathAsDir()">📁 ${esc(t('skill_select_dir') || 'Select this directory')}</button>
          <div id="skillPathBrowserList" class="skill-path-browser-list"></div>
        </div>
        <div class="modal-footer">
          <span id="skillPathBrowserError" class="detail-form-error" style="display:none"></span>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  // 从盘符列表开始浏览（支持多盘切换）
  await _navigateSkillPathBrowser('drives');
}

function _closeSkillPathBrowser() {
  const modal = $('skillPathBrowserModal');
  if (modal) modal.style.display = 'none';
}

async function _navigateSkillPathBrowser(path) {
  const list = $('skillPathBrowserList');
  const currentEl = $('skillPathBrowserCurrent');
  const errEl = $('skillPathBrowserError');
  const upBtn = $('skillPathBrowserUp');
  const selectDirBtn = $('skillPathBrowserSelectDir');
  if (!list) return;
  if (errEl) errEl.style.display = 'none';
  list.innerHTML = `<div class="skill-path-loading">${esc(t('loading') || 'Loading...')}</div>`;
  try {
    const url = '/api/skills/browse' + (path ? '?path=' + encodeURIComponent(path) : '');
    const data = await api(url);
    _skillPathBrowserState.current = data.current || '';
    _skillPathBrowserState.parent = data.parent || '';
    const isDrives = data.is_drives === true || _skillPathBrowserState.current === 'drives';
    if (currentEl) currentEl.textContent = isDrives ? (t('skill_my_computer') || 'My Computer') : _skillPathBrowserState.current;
    // "上一级"按钮：parent 为空时隐藏，为 "drives" 时显示"我的电脑"
    if (upBtn) {
      if (_skillPathBrowserState.parent) { upBtn.style.display = ''; }
      else { upBtn.style.display = 'none'; }
    }
    // "选择此目录"按钮：盘符列表视图时隐藏
    if (selectDirBtn) { selectDirBtn.style.display = isDrives ? 'none' : ''; }
    let html = '';
    if (data.error) {
      if (errEl) { errEl.textContent = data.error; errEl.style.display = ''; }
      list.innerHTML = '';
      return;
    }
    // 子目录（盘符列表视图时不拼接路径，直接用盘符名）
    (data.dirs || []).forEach(d => {
      const full = isDrives ? d : _skillPathBrowserState.current + '/' + d;
      html += `<div class="skill-path-browser-item skill-path-browser-dir" data-nav="${esc(full)}">📁 ${esc(d)}</div>`;
    });
    // .md 文件
    (data.files || []).forEach(f => {
      html += `<div class="skill-path-browser-item skill-path-browser-file" data-file="${esc(f)}">📄 ${esc(f)}</div>`;
    });
    if (!html) html = `<div class="skill-path-empty">${esc(t('skill_no_items') || 'No directories or .md files')}</div>`;
    list.innerHTML = html;
    // 事件委托
    list.querySelectorAll('.skill-path-browser-dir').forEach(el => {
      el.addEventListener('click', () => _navigateSkillPathBrowser(el.dataset.nav));
    });
    list.querySelectorAll('.skill-path-browser-file').forEach(el => {
      el.addEventListener('click', () => _selectSkillPathAsFile(el.dataset.file));
    });
  } catch(e) {
    list.innerHTML = '';
    if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
  }
}

function _selectSkillPathAsDir() {
  if (_skillPathBrowserState.current) {
    _addSkillPath(_skillPathBrowserState.current);
  }
}

function _selectSkillPathAsFile(fileName) {
  if (_skillPathBrowserState.current && fileName) {
    _addSkillPath(_skillPathBrowserState.current + '/' + fileName);
  }
}

async function deleteCurrentSkill() {
  if (!_currentSkillDetail) return;
  const name = _currentSkillDetail.name;
  const message = t('skill_delete_confirm')
    ? t('skill_delete_confirm').replace('{0}', name)
    : `Delete skill "${name}"?`;
  const ok = await showConfirmDialog({
    title: t('delete_title') || 'Delete',
    message,
    confirmLabel: t('delete_title') || 'Delete',
    danger: true,
    focusCancel: true,
  });
  if (!ok) return;
  try {
    await api('/api/skills/delete', { method:'POST', body: JSON.stringify({ name }) });
    _currentSkillDetail = null;
    _skillPreFormDetail = null;
    _skillsData = null;
    _cronSkillsCache = null;
    if(typeof window!=='undefined'&&typeof window.invalidateSlashSkillCaches==='function') window.invalidateSlashSkillCaches();
    _skillMode = 'empty';
    const body = $('skillDetailBody');
    const empty = $('skillDetailEmpty');
    const title = $('skillDetailTitle');
    if (body) { body.innerHTML = ''; body.style.display = 'none'; }
    if (empty) empty.style.display = '';
    if (title) title.textContent = '';
    _setSkillHeaderButtons('empty');
    await loadSkills();
    showToast(t('skill_deleted') || 'Skill deleted');
  } catch(e) { setStatus(t('error_prefix') + e.message); }
}

// ── Memory (main view) ──
let _memoryData = null;
let _notesSourcesData = null;
let _notesSearchResults = [];
let _notesSelectedSource = 'joplin';
let _notesPreviewNote = null;
let _notesSearchError = '';
let _notesSearchLoading = false;
let _currentMemorySection = null; // 'memory' | 'user' | 'soul' | 'project_context' | 'external_notes'
let _memoryMode = 'empty'; // 'empty' | 'read' | 'edit'

const MEMORY_SECTIONS = [
  { key: 'memory', labelKey: 'my_notes', emptyKey: 'no_notes_yet', iconKey: 'brain' },
  { key: 'user',   labelKey: 'user_profile', emptyKey: 'no_profile_yet', iconKey: 'user' },
  { key: 'soul',   labelKey: 'agent_soul', emptyKey: 'no_soul_yet', iconKey: 'sparkles' },
  { key: 'project_context', labelKey: 'memory_project_context_label', emptyKey: 'memory_project_context_empty', iconKey: 'file-text', readOnly: true },
  { key: 'external_notes', labelKey: 'external_notes_sources', emptyKey: 'external_notes_empty', iconKey: 'book-open' },
];

function _memorySectionMeta(key) {
  return MEMORY_SECTIONS.find(s => s.key === key) || MEMORY_SECTIONS[0];
}

function _memorySectionLabel(meta) {
  if (meta.label) return meta.label;
  return t(meta.labelKey);
}

function _memorySectionEmpty(meta) {
  if (meta.empty) return meta.empty;
  return t(meta.emptyKey);
}

function _memorySectionContent(key) {
  if (!_memoryData) return '';
  if (key === 'user') return _memoryData.user || '';
  if (key === 'soul') return _memoryData.soul || '';
  if (key === 'project_context') return _memoryData.project_context || '';
  return _memoryData.memory || '';
}

function _memorySectionMtime(key) {
  if (!_memoryData) return 0;
  if (key === 'user') return _memoryData.user_mtime || 0;
  if (key === 'soul') return _memoryData.soul_mtime || 0;
  if (key === 'project_context') return _memoryData.project_context_mtime || 0;
  return _memoryData.memory_mtime || 0;
}

function _setMemoryHeaderButtons(mode) {
  const show = b => b && (b.style.display = '');
  const hide = b => b && (b.style.display = 'none');
  const editBtn = $('btnEditMemoryDetail');
  const cancelBtn = $('btnCancelMemoryDetail');
  const saveBtn = $('btnSaveMemoryDetail');
  const meta = _memorySectionMeta(_currentMemorySection);
  if (mode === 'read' && _currentMemorySection !== 'external_notes' && !meta.readOnly) { show(editBtn); hide(cancelBtn); hide(saveBtn); }
  else if (mode === 'edit') { hide(editBtn); show(cancelBtn); show(saveBtn); }
  else { hide(editBtn); hide(cancelBtn); hide(saveBtn); }
}

function _renderExternalNotesSources() {
  const title = $('memoryDetailTitle');
  const body = $('memoryDetailBody');
  const empty = $('memoryDetailEmpty');
  if (!title || !body) return;
  title.textContent = t('external_notes_sources');
  const data = _notesSourcesData || {};
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const recall = data.automatic_recall_unchanged !== false
    ? `<div class="memory-detail-mtime">${esc(t('external_notes_auto_recall_hint'))}</div>`
    : '';
  if (!sources.length) {
    body.innerHTML = `<div class="main-view-content">${recall}<div class="memory-empty">${esc(t('external_notes_empty'))}</div></div>`;
  } else {
    const selected = sources.find(src => (src.name || '').toLowerCase() === (_notesSelectedSource || '').toLowerCase()) || sources[0];
    _notesSelectedSource = (selected && selected.name) || 'joplin';
    const sourceOptions = sources.map(src => `<option value="${esc(src.name||'')}" ${src.name===_notesSelectedSource?'selected':''}>${esc(src.label||src.name||'')}</option>`).join('');
    const recentAiNotes = Array.isArray(data.recent_ai_notes) ? data.recent_ai_notes : [];
    const recentAiHtml = recentAiNotes.length
      ? `<section class="notes-source-card notes-ai-recent-card">
          <div class="notes-source-card-head notes-ai-recent-head"><strong>${li('bot', 14)}${esc(t('external_notes_recent_ai'))}</strong><span class="detail-badge">${esc(t('external_notes_auto'))}</span></div>
          <div class="notes-ai-recent-list">${recentAiNotes.map(note => {
            const updated = note.updated_time ? new Date(Number(note.updated_time)).toLocaleString() : '';
            return `<button type="button" class="notes-result-card notes-ai-recent-item" onclick="previewExternalNote('${esc(note.source||'joplin')}','${esc(note.id||'')}')"><strong>${esc(note.title||note.label||'Untitled')}</strong><span>${li('clock', 14)}${esc(note.label||t('external_notes_recent_ai_reason'))}${updated ? ` · ${esc(updated)}` : ''}</span></button>`;
          }).join('')}</div>
        </section>`
      : '';
    const searchError = _notesSearchError ? `<div class="detail-form-error">${esc(_notesSearchError)}</div>` : '';
    const resultHtml = _notesSearchResults.length
      ? `<div class="notes-search-results">${_notesSearchResults.map(note => `<button type="button" class="notes-result-card" onclick="previewExternalNote('${esc(note.source||_notesSelectedSource)}','${esc(note.id||'')}')"><strong>${esc(note.title||'Untitled')}</strong>${note.snippet?`<span>${esc(note.snippet)}</span>`:''}</button>`).join('')}</div>`
      : `<div class="memory-empty">${esc(t('external_notes_search_empty'))}</div>`;
    const previewHtml = _notesPreviewNote
      ? `<section class="notes-source-card notes-preview-card"><div class="notes-source-card-head"><strong>${esc(_notesPreviewNote.title||'Untitled')}</strong><span class="detail-badge">${esc(_notesPreviewNote.source||_notesSelectedSource)}</span></div><div class="memory-content preview-md">${renderMd(_notesPreviewNote.body||'')}</div></section>`
      : '';
    const cards = sources.map(src => {
      const status = src.active ? t('source_active') : (src.status || t('source_configured'));
      const tools = Array.isArray(src.tools) ? src.tools : [];
      const hintHtml = src.tool_source === 'configured_hint'
        ? `<div class="memory-detail-mtime">${esc(t('external_notes_configured_hint'))}</div>`
        : '';
      const toolHtml = tools.length
        ? `<ul class="notes-source-tools">${tools.map(tool => `<li><strong>${esc(tool.name||'')}</strong>${tool.description?` — ${esc(tool.description)}`:''}</li>`).join('')}</ul>`
        : `<div class="memory-empty">${esc(t('external_notes_no_tools'))}</div>`;
      return `<section class="notes-source-card">
        <div class="notes-source-card-head"><strong>${esc(src.label||src.name||'')}</strong><span class="detail-badge ${src.active?'active':''}">${esc(status)}</span></div>
        <div class="memory-detail-mtime">${esc(t('external_notes_tool_count', src.tool_count||0))}</div>
        ${hintHtml}
        ${toolHtml}
      </section>`;
    }).join('');
    const searchUi = `<section class="notes-source-card notes-search-card">
      <form class="notes-search-form" onsubmit="event.preventDefault(); searchExternalNotes();">
        <select id="externalNotesSource" onchange="selectExternalNotesSource(this.value)">${sourceOptions}</select>
        <input id="externalNotesQuery" type="search" placeholder="${esc(t('external_notes_search_placeholder'))}" />
        <button type="submit" class="btn-secondary">${esc(_notesSearchLoading ? t('loading') : t('search'))}</button>
      </form>
      ${searchError}
      ${resultHtml}
    </section>`;
    body.innerHTML = `<div class="main-view-content">${recall}${recentAiHtml}${searchUi}${previewHtml}${cards}</div>`;
  }
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _memoryMode = 'read';
  _setMemoryHeaderButtons('read');
}

function _renderMemoryDetail(section) {
  if (section === 'external_notes') {
    _renderExternalNotesSources();
    return;
  }

  const meta = _memorySectionMeta(section);
  const title = $('memoryDetailTitle');
  const body = $('memoryDetailBody');
  const empty = $('memoryDetailEmpty');
  if (!title || !body) return;
  title.textContent = _memorySectionLabel(meta);
  const content = _memorySectionContent(section);
  const mtime = _memorySectionMtime(section);
  const mtimeStr = mtime ? new Date(mtime * 1000).toLocaleString() : '';
  const mtimeHtml = mtimeStr ? `<div class="memory-detail-mtime">${esc(mtimeStr)}</div>` : '';
  const path = section === 'project_context' && _memoryData ? (_memoryData.project_context_path || '') : '';
  const fileName = section === 'project_context' && _memoryData ? (_memoryData.project_context_name || (path.split(/[\\/]/).pop() || '')) : '';
  const pathHtml = path ? `<div class="memory-detail-mtime">${esc(fileName)} · ${esc(path)}</div>` : '';
  const shadowed = section === 'project_context' && _memoryData && Array.isArray(_memoryData.project_context_shadowed)
    ? _memoryData.project_context_shadowed
    : [];
  const shadowedHtml = shadowed.length
    ? `<div class="memory-detail-mtime">${esc(shadowed.map(item => `${item.name || 'Context file'} present, shadowed by ${item.shadowed_by || fileName || 'active context'}`).join('; '))}</div>`
    : '';
  const inner = content
    ? `<div class="memory-content preview-md">${renderMd(content)}</div>`
    : `<div class="memory-empty">${esc(_memorySectionEmpty(meta))}</div>`;
  body.innerHTML = `<div class="main-view-content">${pathHtml}${mtimeHtml}${shadowedHtml}${inner}</div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _memoryMode = 'read';
  _setMemoryHeaderButtons('read');
}

function _renderMemoryEdit(section) {
  const meta = _memorySectionMeta(section);
  const title = $('memoryDetailTitle');
  const body = $('memoryDetailBody');
  const empty = $('memoryDetailEmpty');
  if (!title || !body) return;
  title.textContent = _memorySectionLabel(meta);
  const content = _memorySectionContent(section);
  body.innerHTML = `
    <div class="main-view-content">
      <form class="detail-form" onsubmit="event.preventDefault(); submitMemorySave();">
        <div class="detail-form-row">
          <label for="memEditContent">${esc(t('memory_notes_label'))}</label>
          <textarea id="memEditContent" rows="20" spellcheck="false">${esc(content)}</textarea>
        </div>
        <div id="memEditError" class="detail-form-error" style="display:none"></div>
      </form>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _memoryMode = 'edit';
  _setMemoryHeaderButtons('edit');
  const ta = $('memEditContent');
  if (ta) ta.focus();
}

async function loadNotesSources(force) {
  if (_notesSourcesData && !force) return _notesSourcesData;
  try {
    _notesSourcesData = await api('/api/notes/sources');
  } catch (e) {
    _notesSourcesData = {sources: [], automatic_recall_unchanged: true, error: e && e.message ? e.message : String(e)};
  }
  return _notesSourcesData;
}

function selectExternalNotesSource(source) {
  _notesSelectedSource = source || 'joplin';
  _notesSearchResults = [];
  _notesPreviewNote = null;
  _notesSearchError = '';
  _renderExternalNotesSources();
}

async function searchExternalNotes() {
  const input = $('externalNotesQuery');
  const sourceEl = $('externalNotesSource');
  const q = input ? input.value.trim() : '';
  _notesSelectedSource = sourceEl ? sourceEl.value : (_notesSelectedSource || 'joplin');
  _notesPreviewNote = null;
  _notesSearchError = '';
  if (!q) {
    _notesSearchResults = [];
    _renderExternalNotesSources();
    return;
  }
  _notesSearchLoading = true;
  _renderExternalNotesSources();
  try {
    const data = await api(`/api/notes/search?source=${encodeURIComponent(_notesSelectedSource)}&q=${encodeURIComponent(q)}&limit=20`);
    _notesSearchResults = Array.isArray(data.results) ? data.results : [];
    _notesSearchError = data.error || '';
  } catch (e) {
    _notesSearchResults = [];
    _notesSearchError = e && e.message ? e.message : String(e);
  } finally {
    _notesSearchLoading = false;
    _renderExternalNotesSources();
    const nextInput = $('externalNotesQuery');
    if (nextInput) nextInput.value = q;
  }
}

async function previewExternalNote(source, id) {
  _notesSearchError = '';
  try {
    const data = await api(`/api/notes/item?source=${encodeURIComponent(source||_notesSelectedSource)}&id=${encodeURIComponent(id||'')}`);
    _notesPreviewNote = data && data.note ? data.note : null;
  } catch (e) {
    _notesPreviewNote = null;
    _notesSearchError = e && e.message ? e.message : String(e);
  }
  _renderExternalNotesSources();
}

async function openMemorySection(section, el) {
  if (section === 'external_notes' && _memoryData && !_memoryData.external_notes_enabled) return;
  _currentMemorySection = section;
  document.querySelectorAll('#memoryPanel .side-menu-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  if (section === 'external_notes') {
    await loadNotesSources(false);
  }
  _renderMemoryDetail(section);
}

function editCurrentMemory() {
  const meta = _memorySectionMeta(_currentMemorySection);
  if (!_currentMemorySection || _currentMemorySection === 'external_notes' || meta.readOnly) return;
  _renderMemoryEdit(_currentMemorySection);
}

function cancelMemoryEdit() {
  if (!_currentMemorySection) return;
  _renderMemoryDetail(_currentMemorySection);
}

// Legacy alias (kept for any stale references)
function toggleMemoryEdit() { editCurrentMemory(); }
function closeMemoryEdit() { cancelMemoryEdit(); }

async function submitMemorySave() {
  if (!_currentMemorySection) return;
  if (_memorySectionMeta(_currentMemorySection).readOnly) return;
  const ta = $('memEditContent');
  const errEl = $('memEditError');
  if (!ta) return;
  if (errEl) errEl.style.display = 'none';
  try {
    const body = {section: _currentMemorySection, content: ta.value};
    if (S.session && S.session.session_id) body.session_id = S.session.session_id;
    await api('/api/memory/write', {method:'POST', body: JSON.stringify(body)});
    showToast(t('memory_saved'));
    await loadMemory(true);
    _renderMemoryDetail(_currentMemorySection);
  } catch(e) {
    if (errEl) { errEl.textContent = t('error_prefix') + e.message; errEl.style.display = ''; }
  }
}

// ── Workspace management ──
let _workspaceList = [];  // cached from /api/workspaces
let _wsSuggestTimer = null;
let _wsSuggestReq = 0;
let _wsSuggestIndex = -1;

function closeWorkspacePathSuggestions(){
  const box=$('workspaceFormPathSuggestions');
  if(box){
    box.innerHTML='';
    box.style.display='none';
  }
  _wsSuggestIndex=-1;
}

function _applyWorkspaceSuggestion(path){
  const input=$('workspaceFormPath');
  const next=(path||'').endsWith('/')?(path||''):`${path||''}/`;
  if(input){
    input.value=next;
    input.focus();
    input.setSelectionRange(next.length, next.length);
  }
  scheduleWorkspacePathSuggestions();
}

function _highlightWorkspaceSuggestion(idx){
  const box=$('workspaceFormPathSuggestions');
  if(!box)return;
  const items=[...box.querySelectorAll('.ws-suggest-item')];
  items.forEach((el,i)=>{
    const active=i===idx;
    el.classList.toggle('active', active);
    if(active) el.scrollIntoView({block:'nearest'});
  });
}

function _renderWorkspacePathSuggestions(paths){
  const box=$('workspaceFormPathSuggestions');
  if(!box)return;
  box.innerHTML='';
  if(!paths || !paths.length){
    box.style.display='none';
    _wsSuggestIndex=-1;
    return;
  }
  paths.forEach((path, idx)=>{
    const pathParts=(path||'').split('/').filter(Boolean);
    const leaf=pathParts[pathParts.length-1]||path;
    const parent=pathParts.length>1?`/${pathParts.slice(0,-1).join('/')}`:'/';
    const item=document.createElement('button');
    item.type='button';
    item.className='ws-suggest-item';
    item.innerHTML=`<span class="ws-suggest-leaf">${esc(leaf)}</span><span class="ws-suggest-parent">${esc(parent)}</span>`;
    item.dataset.path=path;
    item.onmouseenter=()=>{_wsSuggestIndex=idx;_highlightWorkspaceSuggestion(idx);};
    item.onmousedown=(e)=>{e.preventDefault();_applyWorkspaceSuggestion(path);};
    box.appendChild(item);
  });
  box.style.display='block';
  _wsSuggestIndex=0;
  _highlightWorkspaceSuggestion(_wsSuggestIndex);
}

async function _loadWorkspacePathSuggestions(prefix){
  const reqId=++_wsSuggestReq;
  try{
    const qs=new URLSearchParams({prefix:prefix||''}).toString();
    const data=await api(`/api/workspaces/suggest?${qs}`);
    if(reqId!==_wsSuggestReq)return;
    _renderWorkspacePathSuggestions(data.suggestions||[]);
  }catch(_){
    if(reqId!==_wsSuggestReq)return;
    closeWorkspacePathSuggestions();
  }
}

function scheduleWorkspacePathSuggestions(){
  const input=$('workspaceFormPath');
  if(!input)return;
  const prefix=input.value.trim();
  if(!prefix){
    closeWorkspacePathSuggestions();
    return;
  }
  if(_wsSuggestTimer) clearTimeout(_wsSuggestTimer);
  _wsSuggestTimer=setTimeout(()=>{
    _loadWorkspacePathSuggestions(prefix);
  }, 120);
}

function getWorkspaceFriendlyName(path){
  // Look up the friendly name from the workspace list cache, fallback to last path segment
  if(_workspaceList && _workspaceList.length){
    const match=_workspaceList.find(w=>w.path===path);
    if(match && match.name) return match.name;
  }
  return path.split('/').filter(Boolean).pop()||path;
}

function syncWorkspaceDisplays(){
  const hasSession=!!(S.session&&S.session.workspace);
  // Fall back to the profile default workspace when no session is active yet.
  // S._profileDefaultWorkspace is set during boot and profile switches from /api/settings.
  const defaultWs=(typeof S._profileDefaultWorkspace==='string'&&S._profileDefaultWorkspace)||'';
  const ws=hasSession?S.session.workspace:(defaultWs||'');
  const hasWorkspace=!!(ws);
  const label=hasWorkspace?getWorkspaceFriendlyName(ws):t('no_workspace');

  const sidebarName=$('sidebarWsName');
  const sidebarPath=$('sidebarWsPath');
  if(sidebarName) sidebarName.textContent=label;
  if(sidebarPath) sidebarPath.textContent=ws;

  const composerChip=$('composerWorkspaceChip');
  const composerLabel=$('composerWorkspaceLabel');
  const mobileAction=$('composerMobileWorkspaceAction');
  const mobileLabel=$('composerMobileWorkspaceLabel');
  const composerDropdown=$('composerWsDropdown');
  if(!hasWorkspace && composerDropdown) composerDropdown.classList.remove('open');
  // Only show workspace label once boot has finished to prevent
  // flash of "No workspace" before the saved session finishes loading.
  if(composerLabel) composerLabel.textContent=S._bootReady?label:'';
  if(mobileLabel) mobileLabel.textContent=S._bootReady?label:'';
  if(composerChip){
    composerChip.disabled=false; // 始终允许点击以选择工作区
    composerChip.title=hasWorkspace?ws:t('no_workspace');
    composerChip.classList.toggle('active',!!(composerDropdown&&composerDropdown.classList.contains('open')));
  }
  if(mobileAction){
    mobileAction.title=hasWorkspace?ws:t('no_workspace');
    mobileAction.classList.toggle('active',!!(composerDropdown&&composerDropdown.classList.contains('open')));
  }
}

async function loadWorkspaceList(){
  try{
    const data = await api('/api/workspaces');
    if(typeof syncTerminalBackendState==='function') syncTerminalBackendState(data);
    _workspaceList = data.workspaces || [];
    syncWorkspaceDisplays();
    if(typeof syncTerminalButton==='function') syncTerminalButton();
    return {workspaces: data.workspaces || [], last: data.last || ''};
  }catch(e){ return {workspaces:[], last:''}; }
}

function _renderWorkspaceAction(label, meta, iconSvg, onClick){
  const opt=document.createElement('div');
  opt.className='ws-opt ws-opt-action';
  opt.innerHTML=`<span class="ws-opt-icon">${iconSvg}</span><span><span class="ws-opt-name">${esc(label)}</span>${meta?`<span class="ws-opt-meta">${esc(meta)}</span>`:''}</span>`;
  opt.onclick=onClick;
  return opt;
}

function _positionComposerWsDropdown(){
  const dd=$('composerWsDropdown');
  const chip=$('composerWorkspaceGroup')||$('composerWorkspaceChip');
  const mobileAction=$('composerMobileWorkspaceAction');
  const panel=$('composerMobileConfigPanel');
  const footer=document.querySelector('.composer-footer');
  // While the mobile config panel is open, anchor to #composerMobileWorkspaceAction instead of only the desktop workspace chip.
  const anchor=(panel&&panel.classList.contains('open')&&mobileAction)?mobileAction:chip;
  if(!dd||!anchor||!footer)return;
  const chipRect=anchor.getBoundingClientRect();
  const footerRect=footer.getBoundingClientRect();
  let left=chipRect.left-footerRect.left;
  const maxLeft=Math.max(0, footer.clientWidth-dd.offsetWidth);
  left=Math.max(0, Math.min(left, maxLeft));
  dd.style.left=`${left}px`;
}

function _positionProfileDropdown(){
  const dd=$('profileDropdown');
  const chip=$('profileChip');
  const footer=document.querySelector('.composer-footer');
  if(!dd||!chip||!footer)return;
  const chipRect=chip.getBoundingClientRect();
  const footerRect=footer.getBoundingClientRect();
  let left=chipRect.left-footerRect.left;
  const maxLeft=Math.max(0, footer.clientWidth-dd.offsetWidth);
  left=Math.max(0, Math.min(left, maxLeft));
  dd.style.left=`${left}px`;
}

function renderWorkspaceDropdownInto(dd, workspaces, currentWs){
  if(!dd)return;
  dd.innerHTML='';

  // ── Search row ──────────────────────────────────────────────────────────
  const searchRow=document.createElement('div');
  searchRow.className='ws-search-row';
  searchRow.innerHTML=`<input class="ws-search-input" type="text" placeholder="${esc(t('ws_search_placeholder')||'Search workspaces…')}" spellcheck="false" autocomplete="off"><button class="ws-search-clear" title="Clear search">${li('x',10)}</button>`;
  const si=searchRow.querySelector('.ws-search-input');
  const sc=searchRow.querySelector('.ws-search-clear');
  dd.appendChild(searchRow);

  // ── Workspace list ──────────────────────────────────────────────────────
  // Sort alphabetically by name (case-insensitive) before rendering.
  const sorted=[...workspaces].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const listContainer=document.createElement('div');
  listContainer.className='ws-list-container';
  dd.appendChild(listContainer);

  // Pre-create noResults element so filterWs can reference it safely from the start.
  const noResults=document.createElement('div');
  noResults.className='ws-no-results';
  noResults.textContent=t('ws_no_results')||'No workspaces found';
  noResults.style.display='none';

  function filterWs(term){
    term=(term||'').trim().toLowerCase();
    let visible=0;
    const opts=listContainer.querySelectorAll('.ws-opt');
    for(const opt of opts){
      const name=(opt.dataset.name||'').toLowerCase();
      const path=(opt.dataset.path||'').toLowerCase();
      const show=!term||name.includes(term)||path.includes(term);
      opt.style.display=show?'':'none';
      if(show) visible++;
    }
    noResults.style.display=visible?'none':'';
  }

  function renderList(){
    listContainer.innerHTML='';
    for(const w of sorted){
      const opt=document.createElement('div');
      opt.className='ws-opt'+(w.path===currentWs?' active':'');
      opt.dataset.name=w.name||'';
      opt.dataset.path=w.path||'';
      opt.innerHTML=`<span class="ws-opt-name">${esc(w.name)}</span><span class="ws-opt-path">${esc(w.path)}</span>`;
      opt.onclick=()=>switchToWorkspace(w.path,w.name);
      listContainer.appendChild(opt);
    }
    listContainer.appendChild(noResults);
  }

  renderList();
  filterWs('');

  si.addEventListener('input',()=>{ filterWs(si.value); });
  sc.addEventListener('click',()=>{ si.value=''; filterWs(''); si.focus(); });

  // ── Footer actions ────────────────────────────────────────────────────────
  dd.appendChild(document.createElement('div')).className='ws-divider';
  dd.appendChild(_renderWorkspaceAction(
    t('workspace_choose_path'),
    t('workspace_choose_path_meta'),
    li('folder',12),
    ()=>promptWorkspacePath()
  ));
  const div=document.createElement('div');div.className='ws-divider';dd.appendChild(div);
  dd.appendChild(_renderWorkspaceAction(
    t('workspace_manage'),
    t('workspace_manage_meta'),
    li('settings',12),
    ()=>{closeWsDropdown();mobileSwitchPanel('workspaces');}
  ));
}

function toggleWsDropdown(){
  const dd=$('wsDropdown');
  if(!dd)return;
  const open=dd.classList.contains('open');
  if(open){closeWsDropdown();}
  else{
    closeProfileDropdown(); // close profile dropdown if open
    loadWorkspaceList().then(data=>{
      renderWorkspaceDropdownInto(dd, data.workspaces, S.session?S.session.workspace:'');
      dd.classList.add('open');
    });
  }
}

function toggleComposerWsDropdown(){
  const dd=$('composerWsDropdown');
  const chip=$('composerWorkspaceChip');
  const mobileAction=$('composerMobileWorkspaceAction');
  const panel=$('composerMobileConfigPanel');
  const usingMobileAction=!!(panel&&panel.classList.contains('open')&&mobileAction);
  if(!dd||(!usingMobileAction&&!chip))return;
  const open=dd.classList.contains('open');
  if(open){closeWsDropdown();}
  else{
    closeProfileDropdown();
    if(typeof closeModelDropdown==='function') closeModelDropdown();
    if(typeof closeReasoningDropdown==='function') closeReasoningDropdown();
    loadWorkspaceList().then(data=>{
      renderWorkspaceDropdownInto(dd, data.workspaces, S.session?S.session.workspace:'');
      dd.classList.add('open');
      _positionComposerWsDropdown();
      if(chip) chip.classList.add('active');
      if(mobileAction) mobileAction.classList.add('active');
    });
  }
}

function closeWsDropdown(){
  const dd=$('wsDropdown');
  const composerDd=$('composerWsDropdown');
  const composerChip=$('composerWorkspaceChip');
  const mobileAction=$('composerMobileWorkspaceAction');
  if(dd)dd.classList.remove('open');
  if(composerDd)composerDd.classList.remove('open');
  if(composerChip)composerChip.classList.remove('active');
  if(mobileAction)mobileAction.classList.remove('active');
}
document.addEventListener('click',e=>{
  if(
    !e.target.closest('#composerWorkspaceChip') &&
    !e.target.closest('#composerMobileWorkspaceAction') &&
    !e.target.closest('#composerWsDropdown')
  ) closeWsDropdown();
});
window.addEventListener('resize',()=>{
  const dd=$('composerWsDropdown');
  if(dd&&dd.classList.contains('open')) _positionComposerWsDropdown();
});

async function loadWorkspacesPanel(){
  const panel=$('workspacesPanel');
  if(!panel)return;
  const data=await loadWorkspaceList();
  renderWorkspacesPanel(data.workspaces);
}

function renderWorkspacesPanel(workspaces){
  const panel=$('workspacesPanel');
  panel.innerHTML='';
  const activePath = S.session ? S.session.workspace : '';
  for(let i=0;i<workspaces.length;i++){
    const w=workspaces[i];
    const row=document.createElement('div');
    row.className='ws-row';
    row.dataset.path = w.path;
    row.draggable=true;
    const isActive = w.path === activePath;
    const activeBadge = isActive ? `<span class="detail-badge active" style="margin-left:6px;font-size:9px;padding:1px 6px">${esc(t('profile_active'))}</span>` : '';
    row.innerHTML=`
      <span class="ws-drag-handle" title="${esc(t('workspace_drag_hint'))}">${li('grip-vertical',12)}</span>
      <div class="ws-row-info">
        <div class="ws-row-name">${esc(w.name)}${activeBadge}</div>
        <div class="ws-row-path">${esc(w.path)}</div>
      </div>`;
    // Click on info area only — not on drag handle
    const info=row.querySelector('.ws-row-info');
    if(info) info.onclick = (e) => { e.stopPropagation(); openWorkspaceDetail(w.path, row); };
    if (_currentWorkspaceDetail && _currentWorkspaceDetail.path === w.path) row.classList.add('active');

    // ── Drag-and-drop reorder ──
    row.addEventListener('dragstart', (e) => {
      // Only allow drag from the grip handle or the row itself
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain', w.path);
      // Required for Firefox drag ghost
      if(e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(row, 0, 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      panel.querySelectorAll('.ws-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect='move';
      // Highlight drop target
      panel.querySelectorAll('.ws-row.drag-over').forEach(r => r.classList.remove('drag-over'));
      if(!row.classList.contains('dragging')) row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromPath = e.dataTransfer.getData('text/plain');
      const toPath = w.path;
      if(fromPath === toPath) return; // Same item, no-op
      // Compute new order
      const currentPaths = workspaces.map(ws => ws.path);
      const fromIdx = currentPaths.indexOf(fromPath);
      const toIdx = currentPaths.indexOf(toPath);
      if(fromIdx < 0 || toIdx < 0) return;
      currentPaths.splice(fromIdx, 1);
      currentPaths.splice(toIdx, 0, fromPath);
      try {
        const res = await api('/api/workspaces/reorder', {
          method: 'POST',
          body: JSON.stringify({ paths: currentPaths })
        });
        if(res && res.ok){
          renderWorkspacesPanel(res.workspaces);
          // Also refresh sidebar dropdown
          loadWorkspaceList().then(() => {});
        }
      } catch(err){
        showToast(t('workspace_reorder_failed'), 'error');
      }
    });

    panel.appendChild(row);
  }
  const hint=document.createElement('div');
  hint.style.cssText='font-size:11px;color:var(--muted);padding:8px 0';
  hint.textContent=t('workspace_paths_validated_hint');
  panel.appendChild(hint);
  // Re-render detail if we have one cached and we're not in a form
  if (_currentWorkspaceDetail && _workspaceMode !== 'create' && _workspaceMode !== 'edit') {
    const refreshed = workspaces.find(w => w.path === _currentWorkspaceDetail.path);
    if (refreshed) _renderWorkspaceDetail(refreshed);
    else _clearWorkspaceDetail();
  }
}

function _renderWorkspaceDetail(ws){
  _currentWorkspaceDetail = ws;
  const title = $('workspaceDetailTitle');
  const body = $('workspaceDetailBody');
  const empty = $('workspaceDetailEmpty');
  if (!title || !body) return;
  title.textContent = ws.name || ws.path;
  const activePath = S.session ? S.session.workspace : '';
  const isActive = ws.path === activePath;
  const isDefault = !!ws.is_default;
  const statusBadge = isActive
    ? `<span class="detail-badge active">${esc(t('profile_active'))}</span>`
    : `<span class="detail-badge">${esc(t('profile_inactive'))}</span>`;
  const defaultBadge = isDefault ? ` <span class="detail-badge">${esc(t('profile_default_label'))}</span>` : '';
  body.innerHTML = `
    <div class="main-view-content">
      <div class="detail-card">
        <div class="detail-card-title">${esc(t('workspace_space'))}</div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('workspace_name'))}</div><div class="detail-row-value">${esc(ws.name || '')}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('workspace_path'))}</div><div class="detail-row-value"><code>${esc(ws.path)}</code></div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('profile_status'))}</div><div class="detail-row-value">${statusBadge}${defaultBadge}</div></div>
      </div>
      <div class="detail-card" style="margin-top:12px">
        <div class="detail-card-title">${esc(t('checkpoint_title'))}</div>
        <div id="checkpointListContainer">
          <div style="color:var(--muted);font-size:12px;padding:8px 0">${esc(t('checkpoint_loading'))}</div>
        </div>
      </div>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _workspaceMode = 'read';
  _setWorkspaceHeaderButtons('read', ws);
  _loadCheckpoints(ws.path);
}

function _setWorkspaceHeaderButtons(mode, ws){
  const actBtn = $('btnActivateWorkspaceDetail');
  const editBtn = $('btnEditWorkspaceDetail');
  const delBtn = $('btnDeleteWorkspaceDetail');
  const cancelBtn = $('btnCancelWorkspaceDetail');
  const saveBtn = $('btnSaveWorkspaceDetail');
  const show = b => b && (b.style.display = '');
  const hide = b => b && (b.style.display = 'none');
  if (mode === 'read') {
    const activePath = S.session ? S.session.workspace : '';
    const isActive = ws && ws.path === activePath;
    const isDefault = !!(ws && ws.is_default);
    if (isActive) hide(actBtn); else show(actBtn);
    show(editBtn);
    if (isDefault) hide(delBtn); else show(delBtn);
    hide(cancelBtn); hide(saveBtn);
  } else if (mode === 'create' || mode === 'edit') {
    hide(actBtn); hide(editBtn); hide(delBtn); show(cancelBtn); show(saveBtn);
  } else {
    [actBtn, editBtn, delBtn, cancelBtn, saveBtn].forEach(hide);
  }
}

function openWorkspaceDetail(path, el){
  if (!_workspaceList) return;
  const ws = _workspaceList.find(w => w.path === path);
  if (!ws) return;
  document.querySelectorAll('.ws-row').forEach(e => e.classList.remove('active'));
  const target = el || document.querySelector(`.ws-row[data-path="${CSS.escape(path)}"]`);
  if (target) target.classList.add('active');
  _workspacePreFormDetail = null;
  _renderWorkspaceDetail(ws);
}

function _clearWorkspaceDetail(){
  _currentWorkspaceDetail = null;
  _workspaceMode = 'empty';
  const title = $('workspaceDetailTitle');
  const body = $('workspaceDetailBody');
  const empty = $('workspaceDetailEmpty');
  if (title) title.textContent = '';
  if (body) { body.innerHTML = ''; body.style.display = 'none'; }
  if (empty) empty.style.display = '';
  _setWorkspaceHeaderButtons('empty');
}

async function activateCurrentWorkspace(){
  if (!_currentWorkspaceDetail) return;
  await switchToWorkspace(_currentWorkspaceDetail.path, _currentWorkspaceDetail.name);
  // Re-render detail after activation so the active badge updates
  _renderWorkspaceDetail(_currentWorkspaceDetail);
}

async function deleteCurrentWorkspace(){
  if (!_currentWorkspaceDetail) return;
  const path = _currentWorkspaceDetail.path;
  const _ok = await showConfirmDialog({title:t('workspace_remove_confirm_title'),message:t('workspace_remove_confirm_message',path),confirmLabel:t('remove'),danger:true,focusCancel:true});
  if(!_ok) return;
  try{
    const data=await api('/api/workspaces/remove',{method:'POST',body:JSON.stringify({path})});
    _workspaceList=data.workspaces;
    _clearWorkspaceDetail();
    renderWorkspacesPanel(data.workspaces);
    showToast(t('workspace_removed'));
  }catch(e){setStatus(t('remove_failed')+e.message);}
}

function openWorkspaceCreate(){
  if (typeof switchPanel === 'function' && _currentPanel !== 'workspaces') switchPanel('workspaces');
  _workspacePreFormDetail = _currentWorkspaceDetail ? { ..._currentWorkspaceDetail } : null;
  _workspaceMode = 'create';
  _renderWorkspaceForm({ name:'', path:'', isEdit:false });
}

function editCurrentWorkspace(){
  if (!_currentWorkspaceDetail) return;
  _workspacePreFormDetail = { ..._currentWorkspaceDetail };
  _workspaceMode = 'edit';
  _renderWorkspaceForm({ name: _currentWorkspaceDetail.name || '', path: _currentWorkspaceDetail.path || '', isEdit: true });
}

function _renderWorkspaceForm({ name, path, isEdit }){
  const title = $('workspaceDetailTitle');
  const body = $('workspaceDetailBody');
  const empty = $('workspaceDetailEmpty');
  if (!title || !body) return;
  title.textContent = isEdit ? (t('edit') + ' · ' + (name || path)) : (t('workspace_new_title') || 'New space');
  const pathDisabled = isEdit ? 'disabled' : '';
  const pathHint = isEdit
    ? `<div class="detail-form-hint">${esc(t('workspace_path_readonly') || 'Path cannot be changed. Rename only.')}</div>`
    : `<div class="detail-form-hint">${esc(t('workspace_paths_validated_hint'))}</div>`;
  body.innerHTML = `
    <div class="main-view-content">
      <form class="detail-form" onsubmit="event.preventDefault(); saveWorkspaceForm();">
        <div class="detail-form-row">
          <label for="workspaceFormName">${esc(t('workspace_name_label') || 'Name')}</label>
          <input type="text" id="workspaceFormName" value="${esc(name || '')}" placeholder="${esc(t('workspace_name_placeholder') || 'Optional friendly name')}" autocomplete="off">
        </div>
        <div class="detail-form-row">
          <label for="workspaceFormPath">${esc(t('workspace_path_label') || 'Path')}</label>
          <div class="workspace-form-path-wrap" style="position:relative">
            <input type="text" id="workspaceFormPath" value="${esc(path || '')}" placeholder="${esc(t('workspace_add_path_placeholder') || '/absolute/path/to/folder')}" autocomplete="off" ${pathDisabled} required>
            <div id="workspaceFormPathSuggestions" class="ws-suggestions" style="display:none"></div>
          </div>
          ${pathHint}
        </div>
        <div id="workspaceFormError" class="detail-form-error" style="display:none"></div>
      </form>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _setWorkspaceHeaderButtons(isEdit ? 'edit' : 'create');
  if (!isEdit) _wireWorkspaceFormPathSuggestions();
  const focus = isEdit ? $('workspaceFormName') : $('workspaceFormPath');
  if (focus) focus.focus();
}

function cancelWorkspaceForm(){
  closeWorkspacePathSuggestions();
  if (_workspacePreFormDetail) {
    const snap = _workspacePreFormDetail;
    _workspacePreFormDetail = null;
    _renderWorkspaceDetail(snap);
    return;
  }
  _clearWorkspaceDetail();
}

async function saveWorkspaceForm(){
  const nameEl = $('workspaceFormName');
  const pathEl = $('workspaceFormPath');
  const errEl = $('workspaceFormError');
  if (!pathEl || !errEl) return;
  const name = (nameEl ? nameEl.value : '').trim();
  const path = (pathEl.value || '').trim();
  errEl.style.display = 'none';
  if (!path) { errEl.textContent = t('workspace_path_required') || 'Path is required'; errEl.style.display = ''; return; }
  try {
    if (_workspaceMode === 'edit' && _currentWorkspaceDetail) {
      const targetPath = _currentWorkspaceDetail.path;
      const newName = name || _currentWorkspaceDetail.name || '';
      await api('/api/workspaces/rename', { method:'POST', body: JSON.stringify({ path: targetPath, name: newName }) });
      // Refresh list and re-render detail
      const data = await api('/api/workspaces');
      _workspaceList = data.workspaces || [];
      _workspacePreFormDetail = null;
      showToast(t('workspace_renamed') || t('workspace_added'));
      renderWorkspacesPanel(_workspaceList);
      openWorkspaceDetail(targetPath);
      return;
    }
    const data = await api('/api/workspaces/add', { method:'POST', body: JSON.stringify({ path }) });
    _workspaceList = data.workspaces || [];
    _workspacePreFormDetail = null;
    // Apply rename if a friendly name was supplied
    if (name) {
      try { await api('/api/workspaces/rename', { method:'POST', body: JSON.stringify({ path, name }) }); } catch(_) {}
      const refreshed = await api('/api/workspaces');
      _workspaceList = refreshed.workspaces || _workspaceList;
    }
    renderWorkspacesPanel(_workspaceList);
    showToast(t('workspace_added'));
    const added = _workspaceList.find(w => w.path === path) || _workspaceList[_workspaceList.length - 1];
    if (added) openWorkspaceDetail(added.path);
  } catch (e) {
    errEl.textContent = t('error_prefix') + e.message;
    errEl.style.display = '';
  }
}

// Back-compat: any legacy caller of addWorkspace() opens the new form instead.
function addWorkspace(){ openWorkspaceCreate(); }

function _wireWorkspaceFormPathSuggestions(){
  const input=$('workspaceFormPath');
  if(!input) return;
  input.oninput=()=>scheduleWorkspacePathSuggestions();
  input.onfocus=()=>{
    if(input.value.trim()) scheduleWorkspacePathSuggestions();
    else closeWorkspacePathSuggestions();
  };
  input.onkeydown=(e)=>{
    const box=$('workspaceFormPathSuggestions');
    const items=box?[...box.querySelectorAll('.ws-suggest-item')]:[];
    if(!items.length){
      return;
    }
    if(e.key==='ArrowDown'){
      e.preventDefault();
      _wsSuggestIndex=Math.min(items.length-1,Math.max(-1,_wsSuggestIndex)+1);
      _highlightWorkspaceSuggestion(_wsSuggestIndex);
      return;
    }
    if(e.key==='ArrowUp'){
      e.preventDefault();
      _wsSuggestIndex=_wsSuggestIndex<=0?0:_wsSuggestIndex-1;
      _highlightWorkspaceSuggestion(_wsSuggestIndex);
      return;
    }
    if(e.key==='Escape'){
      e.preventDefault();
      closeWorkspacePathSuggestions();
      return;
    }
    if(e.key==='Enter' && _wsSuggestIndex>=0 && items[_wsSuggestIndex]){
      e.preventDefault();
      _applyWorkspaceSuggestion(items[_wsSuggestIndex].dataset.path||'');
      return;
    }
    if(e.key==='Tab' && _wsSuggestIndex>=0 && items[_wsSuggestIndex]){
      e.preventDefault();
      _applyWorkspaceSuggestion(items[_wsSuggestIndex].dataset.path||'');
      return;
    }
  };
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.workspace-form-path-wrap')) closeWorkspacePathSuggestions();
});

async function removeWorkspace(path){
  const _rmWs=await showConfirmDialog({title:t('workspace_remove_confirm_title'),message:t('workspace_remove_confirm_message',path),confirmLabel:t('remove'),danger:true,focusCancel:true});
  if(!_rmWs) return;
  try{
    const data=await api('/api/workspaces/remove',{method:'POST',body:JSON.stringify({path})});
    _workspaceList=data.workspaces;
    renderWorkspacesPanel(data.workspaces);
    showToast(t('workspace_removed'));
  }catch(e){setStatus(t('remove_failed')+e.message);}
}

async function promptWorkspacePath(){
  // Fetch folder suggestions from backend (empty prefix returns home directory)
  let suggestions=[];
  let defaultPath='';
  try{
    const suggestData=await api('/api/workspaces/suggest');
    suggestions=(suggestData&&suggestData.suggestions)||[];
    if(suggestions.length>0) defaultPath=suggestions[0];
  }catch(e){}
  // Build picker items
  const pickerItems=suggestions.map(p=>({label:p,value:p}));
  const selectedPath=await showFolderPickerDialog({
    title:t('workspace_switch_prompt_title'),
    message:t('workspace_switch_prompt_message'),
    items:pickerItems,
    confirmLabel:t('workspace_switch_prompt_confirm'),
    cancelLabel:t('cancel')
  });
  // User cancelled → use default (home) path
  const path=(selectedPath||defaultPath||'').trim();
  if(!path)return;
  // If no session, auto-create one with the selected workspace
  if(!S.session){
    try{
      const r=await api('/api/session/new',{method:'POST',body:JSON.stringify({workspace:path})});
      if(r&&r.session){S.session=r.session;S.messages=[];if(typeof syncTopbar==='function')syncTopbar();if(typeof renderMessages==='function')renderMessages();if(typeof renderSessionList==='function')await renderSessionList();}
    }catch(e){showToast(t('workspace_switch_failed')+e.message);return;}
    if(!S.session)return;
  }
  try{
    const data=await api('/api/workspaces/add',{method:'POST',body:JSON.stringify({path})});
    _workspaceList=data.workspaces||[];
    const target=_workspaceList[_workspaceList.length-1];
    if(!target) throw new Error(t('workspace_not_added'));
    await switchToWorkspace(target.path,target.name);
  }catch(e){
    if(String(e.message||'').includes('Workspace already in list')){
      showToast(t('workspace_already_saved'));
      return;
    }
    showToast(t('workspace_switch_failed')+e.message);
  }
}

async function switchToWorkspace(path,name){
  // Opus review Q6: if called from blank page, auto-create a session bound to
  // the requested workspace so the switch doesn't silently no-op.
  if(!S.session){
    const ws=path||(typeof S._profileDefaultWorkspace==='string'&&S._profileDefaultWorkspace)||'';
    if(!ws){showToast(t('no_workspace'));return;}
    try{
      const r=await api('/api/session/new',{method:'POST',body:JSON.stringify({workspace:ws})});
      if(r&&r.session){S.session=r.session;S.messages=[];if(typeof syncTopbar==='function')syncTopbar();if(typeof renderMessages==='function')renderMessages();if(typeof renderSessionList==='function')await renderSessionList();}
    }catch(e){if(typeof setStatus==='function')setStatus(t('switch_failed')+e.message);return;}
    if(!S.session)return;
  }
  if(S.busy){
    showToast(t('workspace_busy_switch'));
    return;
  }
  if(typeof _previewDirty!=='undefined'&&_previewDirty){
    const discard=await showConfirmDialog({
      title:t('discard_file_edits_title'),
      message:t('discard_file_edits_message'),
      confirmLabel:t('discard'),
      danger:true
    });
    if(!discard)return;
    if(typeof cancelEditMode==='function')cancelEditMode();
    if(typeof clearPreview==='function')clearPreview();
  }
  try{
    closeWsDropdown();
    await api('/api/session/update',{method:'POST',body:JSON.stringify({
      session_id:S.session.session_id, workspace:path, model:S.session.model, model_provider:S.session.model_provider||null
    })});
    S.session.workspace=path;
    // Explicit workspace switch = user overriding any pending profile-switch default.
    // Clear the one-shot flag so a subsequent newSession() inherits this choice instead.
    S._profileSwitchWorkspace=null;
    syncTopbar();
    await loadDir('.');
    if (_currentPanel === 'memory') await loadMemory(true);
    showToast(t('workspace_switched_to',name||getWorkspaceFriendlyName(path)));
  }catch(e){setStatus(t('switch_failed')+e.message);}
}

// ── Profile panel + dropdown ──
let _profilesCache = null;
let _profileSwitchGeneration = 0;

async function _profileSwitchPanelLoad(){
  if (_currentPanel === 'skills') await loadSkills();
  if (_currentPanel === 'memory') await loadMemory();
  if (_currentPanel === 'tasks') await loadCrons();
  if (_currentPanel === 'kanban') await loadKanban();
  if (_currentPanel === 'profiles') await loadProfilesPanel();
  if (_currentPanel === 'workspaces') await loadWorkspacesPanel();
}

function _refreshProfileSwitchBackground(gen){
  window._modelDropdownReady=null;
  if (typeof window._ensureModelDropdownReady === 'function') {
    Promise.resolve(window._ensureModelDropdownReady()).catch(()=>{});
  }
  Promise.resolve(loadWorkspaceList()).then(()=>{
    if (gen !== _profileSwitchGeneration) return;
    if (S.session && typeof syncTopbar === 'function') syncTopbar();
  }).catch(()=>{});
  // Reconcile per-profile sidebar tab visibility. hidden_tabs is a per-profile
  // appearance setting; without this fetch, Profile A's hidden-tabs choice
  // would remain in effect under Profile B until the user opens Settings.
  // Stage-394 follow-up to #2636 deep review.
  Promise.resolve(api('/api/settings')).then(function(s){
    if (gen !== _profileSwitchGeneration) return;
    var hidden = (s && Array.isArray(s.hidden_tabs)) ? s.hidden_tabs : [];
    hidden = hidden.filter(function(x){ return typeof x === 'string' && x.trim(); });
    var order = (s && Array.isArray(s.tab_order)) ? s.tab_order : [];
    order = order.filter(function(x){ return typeof x === 'string' && x.trim(); });
    if (typeof _setHiddenTabs === 'function') _setHiddenTabs(hidden);
    if (typeof _setTabOrder === 'function') _setTabOrder(order);
    if (typeof _applyTabOrder === 'function') _applyTabOrder(order);
    if (typeof _applyTabVisibility === 'function') _applyTabVisibility(hidden);
  }).catch(function(){});
}

async function loadProfilesPanel() {
  const panel = $('profilesPanel');
  if (!panel) return;
  try {
    const data = await api('/api/profiles');
    _profilesCache = data;
    panel.innerHTML = '';
    const explainer = document.createElement('div');
    explainer.className = 'profile-card profile-help-card';
    explainer.innerHTML = `
      <div class="profile-card-header">
        <div style="min-width:0;flex:1">
          <div class="profile-card-name">${esc(t('profile_vs_workspace_title'))}</div>
          <div class="profile-card-meta">${esc(t('profile_vs_workspace_subtitle'))}</div>
        </div>
      </div>`;
    explainer.onclick = () => _renderProfileConceptHelp(data.active || 'default');
    panel.appendChild(explainer);
    if (!data.profiles || !data.profiles.length) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'padding:16px;color:var(--muted);font-size:12px';
      emptyMsg.textContent = t('profiles_no_profiles');
      panel.appendChild(emptyMsg);
      if (_profileMode !== 'create') _clearProfileDetail();
      return;
    }
    const activeName = (S.activeProfile && data.profiles.some(p => p.name === S.activeProfile))
      ? S.activeProfile
      : (data.active || 'default');
    for (const p of data.profiles) {
      const card = document.createElement('div');
      card.className = 'profile-card';
      card.dataset.name = p.name;
      const meta = [];
      if (p.model) meta.push(p.model.split('/').pop());
      if (p.provider) meta.push(p.provider);
      if (p.total_skills && p.total_skills > 0) meta.push(t('profile_skill_count', p.total_skills).replace(String(p.total_skills), `${p.enabled_skills} / ${p.total_skills}`));
      const gwDot = p.gateway_running
        ? `<span class="profile-opt-badge running" title="${esc(t('profile_gateway_running'))}"></span>`
        : `<span class="profile-opt-badge stopped" title="${esc(t('profile_gateway_stopped'))}"></span>`;
      const isActive = p.name === activeName;
      const activeBadge = isActive ? `<span style="color:var(--link);font-size:10px;font-weight:600;margin-left:6px">${esc(t('profile_active'))}</span>` : '';
      const defaultBadge = p.is_default ? ` <span style="opacity:.5">${esc(t('profile_default_label'))}</span>` : '';
      const hiddenBadge = p.visible === false ? ` <span class="detail-badge" title="${esc(t('profile_hidden_from_chat'))}">${esc(t('profile_hidden_from_chat'))}</span>` : '';
      card.innerHTML = `
        <div class="profile-card-header">
          <div style="min-width:0;flex:1">
            <div class="profile-card-name${isActive ? ' is-active' : ''}">${gwDot}${esc(p.name)}${defaultBadge}${activeBadge}${hiddenBadge}</div>
            ${meta.length ? `<div class="profile-card-meta">${esc(meta.join(' \u00b7 '))}</div>` : `<div class="profile-card-meta">${esc(t('profile_no_configuration'))}</div>`}
          </div>
        </div>`;
      card.onclick = () => openProfileDetail(p.name, card);
      if (_currentProfileDetail && _currentProfileDetail.name === p.name) card.classList.add('active');
      panel.appendChild(card);
    }
    // Re-render detail with fresh data if we have one and we're not in a form
    if (_currentProfileDetail && _profileMode !== 'create') {
      const refreshed = data.profiles.find(p => p.name === _currentProfileDetail.name);
      if (refreshed) _renderProfileDetail(refreshed, data.active);
      else _clearProfileDetail();
    }
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--accent);font-size:12px;padding:12px">${esc(t('error_prefix'))}${esc(e.message)}</div>`;
  }
}

function _renderProfileConceptHelp(activeName){
  const title = $('profileDetailTitle');
  const body = $('profileDetailBody');
  const empty = $('profileDetailEmpty');
  if (!title || !body) return;
  title.textContent = t('profile_vs_workspace_title');
  body.innerHTML = `
    <div class="main-view-content">
      <div class="detail-card">
        <div class="detail-card-title">${esc(t('profile_concept_title'))}</div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('profile_concept_profiles'))}</div><div class="detail-row-value">${esc(t('profile_concept_profiles_desc'))}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('profile_concept_workspaces'))}</div><div class="detail-row-value">${esc(t('profile_concept_workspaces_desc'))}</div></div>
        <div class="detail-row"><div class="detail-row-label">${esc(t('profile_concept_together'))}</div><div class="detail-row-value">${esc(t('profile_concept_together_desc'))}</div></div>
      </div>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _profileMode = 'read';
  _currentProfileDetail = null;
  _setProfileHeaderButtons('empty');
}

function _renderProfileDetail(p, activeName){
  _currentProfileDetail = p;
  const title = $('profileDetailTitle');
  const body = $('profileDetailBody');
  const empty = $('profileDetailEmpty');
  if (!title || !body) return;
  title.textContent = p.name;
  const isActive = p.name === activeName;
  const isDefault = !!p.is_default;
  const statusBadge = isActive
    ? `<span class="detail-badge active">${esc(t('profile_active'))}</span>`
    : `<span class="detail-badge">${esc(t('profile_inactive'))}</span>`;
  const defaultBadge = isDefault ? ` <span class="detail-badge">${esc(t('profile_default_label'))}</span>` : '';
  const gwBadge = p.gateway_running
    ? `<span class="detail-badge ok">${esc(t('profile_gateway_running'))}</span>`
    : `<span class="detail-badge">${esc(t('profile_gateway_stopped'))}</span>`;
  const rows = [];
  rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_status'))}</div><div class="detail-row-value">${statusBadge}${defaultBadge}</div></div>`);
  rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_gateway'))}</div><div class="detail-row-value">${gwBadge}</div></div>`);
  if (p.model) rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_model'))}</div><div class="detail-row-value"><code>${esc(p.model)}</code></div></div>`);
  if (p.provider) rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_provider'))}</div><div class="detail-row-value">${esc(p.provider)}</div></div>`);
  if (p.base_url) rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_base_url'))}</div><div class="detail-row-value"><code>${esc(p.base_url)}</code></div></div>`);
  rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_api_key'))}</div><div class="detail-row-value">${p.has_env ? esc(t('profile_api_keys_configured')) : `<span style="color:var(--muted)">${esc(t('profile_not_configured'))}</span>`}</div></div>`);
  if (p.total_skills && p.total_skills > 0) rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_skills'))}</div><div class="detail-row-value">${esc(t('profile_skill_count', p.total_skills).replace(String(p.total_skills), `${p.enabled_skills} / ${p.total_skills}`))}</div></div>`);
  if (p.default_workspace) rows.push(`<div class="detail-row"><div class="detail-row-label">${esc(t('profile_default_space'))}</div><div class="detail-row-value"><code>${esc(p.default_workspace)}</code></div></div>`);
  body.innerHTML = `
    <div class="main-view-content">
      <div class="detail-card">
        <div class="detail-card-title">${esc(t('profile_card_title'))}</div>
        ${rows.join('')}
      </div>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _profileMode = 'read';
  _setProfileHeaderButtons('read', p, activeName);
}

function _setProfileHeaderButtons(mode, p, activeName){
  const actBtn = $('btnActivateProfileDetail');
  const delBtn = $('btnDeleteProfileDetail');
  const cancelBtn = $('btnCancelProfileDetail');
  const saveBtn = $('btnSaveProfileDetail');
  const show = b => b && (b.style.display = '');
  const hide = b => b && (b.style.display = 'none');
  if (mode === 'read') {
    const isActive = p && p.name === activeName;
    const isDefault = !!(p && p.is_default);
    if (isActive) hide(actBtn); else show(actBtn);
    if (isDefault) hide(delBtn); else show(delBtn);
    hide(cancelBtn); hide(saveBtn);
  } else if (mode === 'create') {
    hide(actBtn); hide(delBtn); show(cancelBtn); show(saveBtn);
  } else {
    [actBtn, delBtn, cancelBtn, saveBtn].forEach(hide);
  }
}

function openProfileDetail(name, el){
  if (!_profilesCache || !_profilesCache.profiles) return;
  const p = _profilesCache.profiles.find(x => x.name === name);
  if (!p) return;
  document.querySelectorAll('.profile-card').forEach(e => e.classList.remove('active'));
  const target = el || document.querySelector(`.profile-card[data-name="${CSS.escape(name)}"]`);
  if (target) target.classList.add('active');
  _profilePreFormDetail = null;
  _renderProfileDetail(p, _profilesCache.active);
}

function _clearProfileDetail(){
  _currentProfileDetail = null;
  _profileMode = 'empty';
  const title = $('profileDetailTitle');
  const body = $('profileDetailBody');
  const empty = $('profileDetailEmpty');
  if (title) title.textContent = '';
  if (body) { body.innerHTML = ''; body.style.display = 'none'; }
  if (empty) empty.style.display = '';
  _setProfileHeaderButtons('empty');
}

async function activateCurrentProfile(){
  if (!_currentProfileDetail) return;
  await switchToProfile(_currentProfileDetail.name);
}

async function deleteCurrentProfile(){
  if (!_currentProfileDetail) return;
  const name = _currentProfileDetail.name;
  const _ok = await showConfirmDialog({title:t('profile_delete_confirm_title',name),message:t('profile_delete_confirm_message'),confirmLabel:t('delete_title'),danger:true,focusCancel:true});
  if(!_ok) return;
  try {
    await api('/api/profile/delete', { method: 'POST', body: JSON.stringify({ name }) });
    _invalidateKanbanProfileCache();
    _clearProfileDetail();
    await loadProfilesPanel();
    showToast(t('profile_deleted', name));
  } catch (e) { showToast(t('delete_failed') + e.message); }
}

function _getCurrentWorkMode() {
  const sid = (typeof S !== 'undefined' && S.session && S.session.session_id) || '';
  // 会话切换时自动清除缓存，确保每个会话读取各自的工作模式
  if (sid !== _currentWorkModeSid) {
    _currentWorkMode = null;
    _currentWorkModeSid = sid;
  }
  // 优先读取会话级别的工作模式，实现每个会话独立切换
  // 读取时只读不写：避免会话级键不存在时静默继承全局键并写回会话级键，
  // 导致刚切过来的会话被其他会话的模式污染（横跳根因）。
  if (sid) {
    try {
      const sessionMode = localStorage.getItem(WORK_MODE_STORAGE_KEY + '_' + sid);
      if (sessionMode && WORK_MODES.some(m => m.id === sessionMode)) {
        _currentWorkMode = sessionMode;
        return sessionMode;
      }
    } catch (_) {}
    // 会话未设置过工作模式时，只读取全局键作为默认值（不写回会话级键）。
    // 全局键仅在无活动会话时由 _setCurrentWorkMode 写入，作为新会话的默认模式。
    try {
      const globalMode = localStorage.getItem(WORK_MODE_STORAGE_KEY);
      if (globalMode && WORK_MODES.some(m => m.id === globalMode)) {
        _currentWorkMode = globalMode;
        return globalMode;
      }
    } catch (_) {}
    _currentWorkMode = WORK_MODES[0].id;
    return _currentWorkMode;
  }
  // 无活动会话时回退到全局工作模式
  if (_currentWorkMode) return _currentWorkMode;
  try {
    const saved = localStorage.getItem(WORK_MODE_STORAGE_KEY);
    if (saved && WORK_MODES.some(m => m.id === saved)) {
      _currentWorkMode = saved;
      return saved;
    }
  } catch (_) {}
  _currentWorkMode = WORK_MODES[0].id;
  return _currentWorkMode;
}

function _workModeLabel(m) {
  return (typeof t === 'function' && t(m.labelKey)) || m.id;
}
function _workModeDesc(m) {
  return (typeof t === 'function' && t(m.descKey)) || '';
}

function _setCurrentWorkMode(mode) {
  if (!WORK_MODES.some(m => m.id === mode)) return false;
  _currentWorkMode = mode;
  const sid = (typeof S !== 'undefined' && S.session && S.session.session_id) || '';
  if (sid) {
    // 有活动会话时只写会话级键，不污染全局键（避免横跳：每个会话独立保存）
    try { localStorage.setItem(WORK_MODE_STORAGE_KEY + '_' + sid, mode); } catch (_) {}
  } else {
    // 无活动会话时写全局键，作为新会话的默认模式
    try { localStorage.setItem(WORK_MODE_STORAGE_KEY, mode); } catch (_) {}
  }
  const chipLabel = $('profileChipLabel');
  const modeObj = WORK_MODES.find(m => m.id === mode);
  if (chipLabel && modeObj) chipLabel.textContent = _workModeLabel(modeObj);
  return true;
}

// 切换会话时同步工作模式 UI：清除缓存并按当前会话重新加载
// _switchingSession 标志：loadSession 开始时置 true，_syncWorkModeForSession 完成后置 false。
// 期间 syncTopbar 等异步触发的 chip 更新应跳过，避免用旧 S.session 调用
// _getCurrentWorkMode 把 chip 写成旧会话模式（横跳主因）。
let _switchingSession = false;
function _syncWorkModeForSession() {
  const sid = (typeof S !== 'undefined' && S.session && S.session.session_id) || '';
  _currentWorkMode = null;
  _currentWorkModeSid = sid;
  const mode = _getCurrentWorkMode();
  const chipLabel = $('profileChipLabel');
  const modeObj = WORK_MODES.find(m => m.id === mode);
  if (chipLabel && modeObj) chipLabel.textContent = _workModeLabel(modeObj);
  _switchingSession = false;
}

function renderWorkModeDropdown() {
  const dd = $('profileDropdown');
  if (!dd) return;
  dd.innerHTML = '';
  // 强制清缓存重读：下拉框打开时确保读取当前会话的真实模式，
  // 避免缓存值是旧会话的导致 active 标记错位。
  _currentWorkMode = null;
  _currentWorkModeSid = null;
  const active = _getCurrentWorkMode();
  // Section title
  const title = document.createElement('div');
  title.className = 'profile-opt-section-title';
  title.textContent = (typeof t === 'function' && t('work_mode_title')) || 'Work Mode';
  dd.appendChild(title);
  for (const m of WORK_MODES) {
    const opt = document.createElement('div');
    opt.className = 'profile-opt work-mode-opt' + (m.id === active ? ' active' : '');
    const checkmark = m.id === active ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--link)" stroke-width="3" style="vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg>' : '';
    opt.innerHTML = `<div class="profile-opt-name">${esc(_workModeLabel(m))}${checkmark}</div>` +
      `<div class="profile-opt-meta">${esc(_workModeDesc(m))}</div>`;
    opt.onclick = () => {
      closeProfileDropdown();
      if (m.id === active) return;
      _setCurrentWorkMode(m.id);
      if (m.id === 'claude-code') {
        showToast((typeof t === 'function' && t('work_mode_switched_claude')) || 'Switched to Claude Code mode');
      } else {
        showToast((typeof t === 'function' && t('work_mode_switched_hermes')) || 'Switched to Hermes Agent mode');
      }
    };
    dd.appendChild(opt);
  }
}

function renderProfileDropdown(data) {
  // Re-purposed profile chip now controls work mode instead of Hermes profiles.
  renderWorkModeDropdown();
}

function toggleProfileDropdown() {
  const dd = $('profileDropdown');
  if (!dd) return;
  if (dd.classList.contains('open')) { closeProfileDropdown(); return; }
  closeWsDropdown(); // close workspace dropdown if open
  if(typeof closeModelDropdown==='function') closeModelDropdown();
  renderWorkModeDropdown();
  dd.classList.add('open');
  _positionProfileDropdown();
  const chip=$('profileChip');
  if(chip) chip.classList.add('active');
}

function closeProfileDropdown() {
  const dd = $('profileDropdown');
  if (dd) dd.classList.remove('open');
  const chip=$('profileChip');
  if(chip) chip.classList.remove('active');
}
document.addEventListener('click', e => {
  if (!e.target.closest('#profileChipWrap') && !e.target.closest('#profileDropdown')) closeProfileDropdown();
});
window.addEventListener('resize',()=>{
  const dd=$('profileDropdown');
  if(dd&&dd.classList.contains('open')) _positionProfileDropdown();
});

async function switchToProfile(name) {
  // Profile switches are per-client cookie/TLS scoped, so a running stream in
  // the current session can safely continue while this tab moves to another
  // profile. The in-flight session stays attached to its original profile.

  // ── Loading indicator ───────────────────────────────────────────────────
  // Show spinner on the profile chip immediately so the user gets visual
  // feedback while the async switch is in progress.
  const _chip = $('profileChip');
  const _switchGen = ++_profileSwitchGeneration;
  if (_chip) { _chip.classList.add('switching'); _chip.disabled = true; }
  // Note: the profile chip now shows the work mode (Hermes Agent / Claude Code),
  // not the active profile name, so we no longer update the chip label here.

  // Determine whether the current session has any messages.
  // A session with messages is "in progress" and belongs to the current profile —
  // we must not retag it.  We'll start a fresh session for the new profile instead.
  const sessionInProgress = S.session && (
    (S.messages && S.messages.length > 0) ||
    S.session.active_stream_id ||
    S.session.pending_user_message
  );

  try {
    const data = await api('/api/profile/switch', { method: 'POST', body: JSON.stringify({ name }) });
    if (_switchGen !== _profileSwitchGeneration) return;
    S.activeProfile = data.active || name;
    S.activeProfileIsDefault = !!data.is_default;

    // Update composer placeholder and title bar while the core profile-switch
    // state is still close to the profile API response.
    if (typeof applyBotName === 'function') applyBotName();

    // ── Model + Workspace ──────────────────────────────────────────────────
    // Apply the profile defaults returned by /api/profile/switch immediately.
    // Refreshing the full model/workspace catalogs is useful, but it should not
    // hold the visible switch animation open.
    if(typeof _clearPersistedModelState==='function') _clearPersistedModelState();
    else localStorage.removeItem('voldp-ai-agent-model');
    _skillsData = null;
    _workspaceList = null;
    if (data.default_model) window._defaultModel = data.default_model;
    if (data.default_model_provider) window._activeProvider = data.default_model_provider;

    // ── Apply model ────────────────────────────────────────────────────────
    if (data.default_model) {
      const sel = $('modelSelect');
      const providerId = data.default_model_provider || window._activeProvider || null;
      const existingDefaultOpt = sel ? Array.from(sel.options).find(o => o.value === data.default_model) : null;
      if (existingDefaultOpt && providerId && !existingDefaultOpt.dataset.provider) {
        existingDefaultOpt.dataset.provider = providerId;
      }
      if (sel && !existingDefaultOpt) {
        const opt = document.createElement('option');
        opt.value = data.default_model;
        opt.textContent = typeof getModelLabel === 'function' ? getModelLabel(data.default_model) : data.default_model;
        opt.dataset.custom = '1';
        if (providerId) opt.dataset.provider = providerId;
        sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
        sel.appendChild(opt);
      }
      const resolved = _applyModelToDropdown(data.default_model, sel, providerId);
      const modelToUse = resolved || data.default_model;
      const modelState = (typeof _modelStateForSelect==='function')
        ? _modelStateForSelect(sel, modelToUse)
        : {model:modelToUse,model_provider:providerId};
      S._pendingProfileModel = modelToUse;
      S._pendingProfileModelProvider = modelState.model_provider||providerId||null;
      // Only patch the in-memory session model if we're NOT about to replace the session
      if (S.session && !sessionInProgress) {
        S.session.model = modelToUse;
        S.session.model_provider = modelState.model_provider||providerId||null;
        S.session.profile = data.active || name;
      }
    }
    // #3331 follow-up (Codex gate): retag the in-memory session's profile on
    // ANY profile switch, even when the switched-to profile returns no
    // default_model (empty session / model-less profile). Without this the
    // profile chip + project-picker filter keep the stale profile after a
    // switch to a model-less profile. Guarded by !sessionInProgress like the
    // model patch above (don't touch a session about to be replaced).
    if (S.session && !sessionInProgress) {
      S.session.profile = data.active || name;
    }

    // ── Apply workspace ────────────────────────────────────────────────────
    if (data.default_workspace) {
      // Always store the persistent profile default — used for blank-page display
      // and workspace auto-bind throughout the session lifecycle (#804, #823).
      S._profileDefaultWorkspace = data.default_workspace;
      // Also set the one-shot flag consumed by newSession() so the first new
      // session after a profile switch inherits this workspace (#424).
      S._profileSwitchWorkspace = data.default_workspace;

      if (S.session && !sessionInProgress) {
        // Empty session (no messages yet) — safe to update it in place
        try {
          await api('/api/session/update', { method: 'POST', body: JSON.stringify({
            session_id: S.session.session_id,
            workspace: data.default_workspace,
            model: S.session.model,
            model_provider: S.session.model_provider||null,
          })});
          S.session.workspace = data.default_workspace;
        } catch (_) {}
      }
    }

    // ── Session ────────────────────────────────────────────────────────────
    _showAllProfiles = false;
    if (typeof animateNextSessionListRefresh === 'function') animateNextSessionListRefresh();

    if (sessionInProgress) {
      // The current session has messages and belongs to the previous profile.
      // Start a new session for the new profile so nothing gets cross-tagged.
      const workspaceVisible = typeof _workspacePanelMode !== 'undefined' && _workspacePanelMode !== 'closed';
      await newSession(false, {awaitWorkspaceLoad: workspaceVisible});
      if (_switchGen !== _profileSwitchGeneration) return;
      // Keep topbar chips (workspace/profile) in sync after creating the
      // new profile-scoped session.
      syncTopbar();
      await renderSessionList();
      showToast(t('profile_switched_new_conversation', name));
    } else {
      // No messages yet — just refresh the list and topbar in place
      await renderSessionList();
      if (_switchGen !== _profileSwitchGeneration) return;
      syncTopbar();
      // Refresh workspace file tree so the right panel shows the new
      // profile's workspace, not the previous one (#1214).
      if (S.session && S.session.workspace) {
        const dirLoad = loadDir('.');
        if (typeof _workspacePanelMode !== 'undefined' && _workspacePanelMode !== 'closed') await dirLoad;
      }
      showToast(t('profile_switched', name));
    }

    await _profileSwitchPanelLoad();
    _refreshProfileSwitchBackground(_switchGen);

  } catch (e) {
    if (_switchGen === _profileSwitchGeneration) showToast(t('switch_failed') + e.message);
  } finally {
    // Always remove loading indicator regardless of success or failure
    if (_switchGen === _profileSwitchGeneration && _chip) { _chip.classList.remove('switching'); _chip.disabled = false; }
  }
}

function openProfileCreate(){
  if (typeof switchPanel === 'function' && _currentPanel !== 'profiles') switchPanel('profiles');
  _profilePreFormDetail = _currentProfileDetail ? { ..._currentProfileDetail } : null;
  _profileMode = 'create';
  _renderProfileForm();
}

function _renderProfileForm(){
  const title = $('profileDetailTitle');
  const body = $('profileDetailBody');
  const empty = $('profileDetailEmpty');
  if (!title || !body) return;
  title.textContent = t('new_profile');
  body.innerHTML = `
    <div class="main-view-content">
      <form class="detail-form" onsubmit="event.preventDefault(); saveProfileForm();">
        <div class="detail-form-row">
          <label for="profileFormName">${esc(t('profile_name_label') || 'Name')}</label>
          <input type="text" id="profileFormName" placeholder="${esc(t('profile_name_placeholder') || 'lowercase, a-z 0-9 hyphens')}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required>
          <div class="detail-form-hint">${esc(t('profile_name_rule') || 'Lowercase letters, numbers, hyphens, underscores only.')}</div>
        </div>
        <div class="detail-form-row">
          <label class="detail-form-check" for="profileFormClone">
            <input type="checkbox" id="profileFormClone"> <span>${esc(t('profile_clone_label') || 'Clone config from active profile')}</span>
          </label>
        </div>
        <div class="detail-form-row">
          <label for="profileFormModel">${esc(t('profile_model_label') || 'Model / provider')}</label>
          <select id="profileFormModel"></select>
          <div class="detail-form-hint">${esc(t('profile_model_hint') || 'Choose from configured providers and models for this new profile.')}</div>
        </div>
        <div class="detail-form-row">
          <label for="profileFormBaseUrl">${esc(t('profile_base_url_label') || 'Base URL')}</label>
          <input type="text" id="profileFormBaseUrl" placeholder="${esc(t('profile_base_url_placeholder') || 'Optional, e.g. http://localhost:11434')}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
        </div>
        <div class="detail-form-row" style="position:relative;">
          <label for="profileFormApiKey">${esc(t('profile_api_key_label') || 'API key')}</label>
          <input type="password" id="profileFormApiKey" placeholder="${esc(t('profile_api_key_placeholder') || 'Optional')}" autocomplete="off" style="padding-right:40px;">
          <button id="_profileAPIKeyToggle" type="button" title="${t('providers_show_api_key')||'Show API key'}" style="position:absolute;right:8px;bottom:8px;background:none;border:none;cursor:pointer;color:var(--muted);padding:4px;display:flex;align-items:center;justify-content:center;border-radius:4px;">
            <svg id="_profileAPIKeyIconShow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            <svg id="_profileAPIKeyIconHide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
          </button>
        </div>
        <div id="profileFormError" class="detail-form-error" style="display:none"></div>
      </form>
    </div>`;
  body.style.display = '';
  if (empty) empty.style.display = 'none';
  _setProfileHeaderButtons('create');
  const n = $('profileFormName');
  if (n) n.focus();
  _populateProfileFormModelSelect();
  // Toggle API key visibility (Profile)
  _wirePasswordToggle(document,'#profileFormApiKey','#_profileAPIKeyToggle','#_profileAPIKeyIconShow','#_profileAPIKeyIconHide');
}

async function _populateProfileFormModelSelect(){
  const sel = $('profileFormModel');
  if (!sel) return;
  sel.innerHTML = `<option value="">${esc(t('profile_model_use_default') || 'Use active profile default')}</option>`;
  try {
    const data = await api('/api/models');
    const groups = (Array.isArray(data && data.groups) && data.groups.length) ? data.groups : [];
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.provider || g.provider_id || 'Configured';
      if (g.provider_id) og.dataset.provider = g.provider_id;
      for (const m of (Array.isArray(g.models) ? g.models : [])) {
        if (!m || !m.id) continue;
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        og.appendChild(opt);
      }
      if (og.children.length) sel.appendChild(og);
    }
    if (data && data.default_model && typeof _applyModelToDropdown === 'function') {
      _applyModelToDropdown(data.default_model, sel, data.active_provider || window._activeProvider || null);
    }
  } catch (e) {
    console.warn('Failed to load profile model picker:', e.message);
  }
}

function cancelProfileForm(){
  if (_profilePreFormDetail) {
    const snap = _profilePreFormDetail;
    _profilePreFormDetail = null;
    const activeName = _profilesCache ? _profilesCache.active : null;
    _renderProfileDetail(snap, activeName);
    return;
  }
  _clearProfileDetail();
}

async function saveProfileForm(){
  const nameEl = $('profileFormName');
  const cloneEl = $('profileFormClone');
  const modelEl = $('profileFormModel');
  const baseEl = $('profileFormBaseUrl');
  const apiKeyEl = $('profileFormApiKey');
  const errEl = $('profileFormError');
  if (!nameEl || !errEl) return;
  const name = (nameEl.value || '').trim().toLowerCase();
  const cloneConfig = !!(cloneEl && cloneEl.checked);
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = t('name_required'); errEl.style.display = ''; return; }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) { errEl.textContent = t('profile_name_rule'); errEl.style.display = ''; return; }
  const baseUrl = (baseEl ? (baseEl.value || '') : '').trim();
  const apiKey = (apiKeyEl ? (apiKeyEl.value || '') : '').trim();
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) { errEl.textContent = t('profile_base_url_rule'); errEl.style.display = ''; return; }
  try {
    const payload = { name, clone_config: cloneConfig };
    if (cloneConfig) payload.clone_from = 'default';
    const selectedModel = modelEl ? (modelEl.value || '').trim() : '';
    if (selectedModel) {
      const modelState = (typeof _modelStateForSelect === 'function')
        ? _modelStateForSelect(modelEl, selectedModel)
        : { model: selectedModel, model_provider: null };
      if (modelState.model) payload.default_model = modelState.model;
      if (modelState.model_provider) payload.model_provider = modelState.model_provider;
    }
    if (baseUrl) payload.base_url = baseUrl;
    if (apiKey) payload.api_key = apiKey;
    await api('/api/profile/create', { method: 'POST', body: JSON.stringify(payload) });
    _invalidateKanbanProfileCache();
    _profilePreFormDetail = null;
    await loadProfilesPanel();
    showToast(t('profile_created', name));
    openProfileDetail(name);
  } catch (e) {
    errEl.textContent = e.message || t('create_failed');
    errEl.style.display = '';
  }
}

// Back-compat
const submitProfileCreate = saveProfileForm;
function toggleProfileForm(){ openProfileCreate();
}

async function deleteProfile(name) {
  const _delProf=await showConfirmDialog({title:t('profile_delete_confirm_title',name),message:t('profile_delete_confirm_message'),confirmLabel:t('delete_title'),danger:true,focusCancel:true});
  if(!_delProf) return;
  try {
    await api('/api/profile/delete', { method: 'POST', body: JSON.stringify({ name }) });
    _invalidateKanbanProfileCache();
    await loadProfilesPanel();
    showToast(t('profile_deleted', name));
  } catch (e) { showToast(t('delete_failed') + e.message); }
}

// ── Memory panel ──
async function loadMemory(force) {
  const panel = $('memoryPanel');
  try {
    const memoryUrl = S.session && S.session.session_id
      ? `/api/memory?session_id=${encodeURIComponent(S.session.session_id)}`
      : '/api/memory';
    const data = await api(memoryUrl);
    _memoryData = data;
    if (_currentMemorySection === 'external_notes' && !data.external_notes_enabled) {
      _currentMemorySection = null;
    }
    if (_currentMemorySection === 'external_notes') {
      await loadNotesSources(!!force);
    }
    if (panel) {
      panel.innerHTML = '';
      for (const s of MEMORY_SECTIONS) {
        if (s.key === 'external_notes' && !_memoryData.external_notes_enabled) continue;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'side-menu-item';
        if (_currentMemorySection === s.key) el.classList.add('active');
        el.innerHTML = `${li(s.iconKey,16)}<span>${esc(_memorySectionLabel(s))}</span>`;
        el.onclick = () => openMemorySection(s.key, el);
        panel.appendChild(el);
      }
    }
    if (_currentMemorySection && _memoryMode !== 'edit') {
      _renderMemoryDetail(_currentMemorySection);
    }
  } catch(e) {
    if (panel) panel.innerHTML = `<div style="padding:12px;color:var(--accent);font-size:12px">${esc(t('error_prefix'))}${esc(e.message)}</div>`;
  }
}

// Drag and drop
const wrap=$('composerWrap');let dragCounter=0;
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('dragenter',e=>{e.preventDefault();
  const isWsPath=e.dataTransfer.types.includes('application/ws-path');
  const isFiles=e.dataTransfer.types.includes('Files');
  if(isFiles||isWsPath){
    dragCounter++;
    // Context-aware hint: a workspace-file drag inserts an @path reference;
    // an OS-file drag attaches the file to the message.
    const hint=$('dropHintText');
    if(hint) hint.textContent=isWsPath?'Drop to insert workspace reference':'Drop files to attach';
    wrap.classList.add('drag-over');
  }
});
document.addEventListener('dragleave',e=>{dragCounter--;if(dragCounter<=0){dragCounter=0;wrap.classList.remove('drag-over');}});
document.addEventListener('drop',e=>{
  e.preventDefault();dragCounter=0;wrap.classList.remove('drag-over');
  // Workspace file/folder drag → insert @path reference into composer
  const wsPath=e.dataTransfer.getData('application/ws-path');
  if(wsPath){
    const msgEl=$('msg');
    if(msgEl){
      const start=msgEl.selectionStart;const end=msgEl.selectionEnd;
      const val=msgEl.value;
      const prefix=start>0&&!val[start-1].match(/\s/)?' ':'';
      const insert=prefix+'@'+wsPath+' ';
      msgEl.value=val.slice(0,start)+insert+val.slice(end);
      msgEl.selectionStart=msgEl.selectionEnd=start+insert.length;
      msgEl.focus();
    }
    return;
  }
  // OS file drag → attach files
  const files=Array.from(e.dataTransfer.files);
  if(files.length){addFiles(files);$('msg').focus();}
});

// ── Settings panel ───────────────────────────────────────────────────────────

let _settingsDirty = false;
let _settingsThemeOnOpen = null; // track theme at open time for discard revert
let _settingsSkinOnOpen = null; // track skin at open time for discard revert
let _settingsFontSizeOnOpen = null; // track font size at open time for discard revert
let _settingsHermesDefaultModelOnOpen = '';
let _settingsSection = 'conversation';
let _currentSettingsSection = 'conversation';
let _settingsAppearanceAutosaveTimer = null;
let _settingsAppearanceAutosaveRetryPayload = null;
let _settingsPreferencesAutosaveTimer = null;
let _settingsPreferencesAutosaveRetryPayload = null;

// ── Sidebar tab visibility/order ────────────────────────────────────────────
const _ALWAYS_VISIBLE_TABS = new Set(['chat','settings']);
const _HIDDEN_TABS_LS_KEY = 'voldp-ai-agent-hidden-tabs';
const _TAB_ORDER_LS_KEY = 'voldp-ai-agent-tab-order';
let _tabVisibilityDragSuppressUntil = 0;

function _sanitizeTabPanelList(panels){
  if(!Array.isArray(panels)) return [];
  var out=[];
  panels.forEach(function(panel){
    if(typeof panel!=='string') return;
    panel=panel.trim();
    if(!panel||_ALWAYS_VISIBLE_TABS.has(panel)) return;
    if(out.indexOf(panel)===-1) out.push(panel);
  });
  return out;
}

function _getHiddenTabs(){
  try{var h=localStorage.getItem(_HIDDEN_TABS_LS_KEY);if(h)return _sanitizeTabPanelList(JSON.parse(h));}catch(e){}
  return[];
}

function _setHiddenTabs(panels){
  try{localStorage.setItem(_HIDDEN_TABS_LS_KEY,JSON.stringify(_sanitizeTabPanelList(panels)));}catch(e){}
}

function _getTabOrder(){
  try{var h=localStorage.getItem(_TAB_ORDER_LS_KEY);if(h)return _sanitizeTabPanelList(JSON.parse(h));}catch(e){}
  return[];
}

function _setTabOrder(panels){
  try{localStorage.setItem(_TAB_ORDER_LS_KEY,JSON.stringify(_sanitizeTabPanelList(panels)));}catch(e){}
}

function _availableSidebarPanels(){
  var out=[];
  var tabs=document.querySelectorAll('.rail .rail-btn.nav-tab[data-panel], .sidebar-nav .nav-tab[data-panel]');
  tabs.forEach(function(tab){
    var panel=tab.dataset.panel;
    if(!panel||_ALWAYS_VISIBLE_TABS.has(panel)) return;
    if(tab.classList.contains('dashboard-link')||tab.hasAttribute('data-dashboard-link')) return;
    if(out.indexOf(panel)===-1) out.push(panel);
  });
  return out;
}

function _orderedSidebarPanels(order){
  var available=_availableSidebarPanels();
  var requested=_sanitizeTabPanelList(Array.isArray(order)?order:_getTabOrder());
  var out=[];
  requested.forEach(function(panel){ if(available.indexOf(panel)!==-1&&out.indexOf(panel)===-1) out.push(panel); });
  available.forEach(function(panel){ if(out.indexOf(panel)===-1) out.push(panel); });
  return out;
}

function _applyTabOrder(order){
  var ordered=_orderedSidebarPanels(order);
  ['.rail','.sidebar-nav'].forEach(function(selector){
    var container=document.querySelector(selector);
    if(!container) return;
    var anchor=Array.prototype.find.call(container.children,function(child){
      if(child.classList&&child.classList.contains('rail-spacer')) return true;
      if(child.classList&&child.classList.contains('dashboard-link')) return true;
      if(child.hasAttribute&&child.hasAttribute('data-dashboard-link')) return true;
      return child.dataset&&child.dataset.panel==='settings';
    });
    ordered.forEach(function(panel){
      var node=container.querySelector('.nav-tab[data-panel="'+panel+'"]');
      if(node) container.insertBefore(node,anchor||null);
    });
  });
}

function _applyTabVisibility(hidden){
  hidden=_sanitizeTabPanelList(hidden);
  _applyTabOrder(_getTabOrder());
  // Hide/unhide all [data-panel] elements (sidebar-nav buttons + rail buttons)
  document.querySelectorAll('[data-panel]').forEach(function(el){
    var panel=el.dataset.panel;
    if(!panel)return;
    var shouldHide=hidden.indexOf(panel)!==-1;
    // Never hide always-visible panels (chat, settings) even if present in hidden_tabs
    if(_ALWAYS_VISIBLE_TABS.has(panel)) shouldHide=false;
    el.classList.toggle('nav-tab-hidden',shouldHide);
  });
  // If the currently active tab is hidden, switch to chat
  var activeRail=document.querySelector('.rail .rail-btn.nav-tab.active[data-panel]');
  var activeSidebar=document.querySelector('.sidebar-nav .nav-tab.active[data-panel]');
  var activeEl=activeRail||activeSidebar;
  if(activeEl&&activeEl.classList.contains('nav-tab-hidden')){
    if(typeof switchPanel==='function') switchPanel('chat');
  }
}

function _renderTabVisibilityChips(){
  var container=$('tabVisibilityChips');
  if(!container)return;
  var hidden=_getHiddenTabs();
  var panels=_orderedSidebarPanels();
  container.innerHTML='';
  panels.forEach(function(panel){
    var tab=document.querySelector('.rail .rail-btn.nav-tab[data-panel="'+panel+'"]')
      ||document.querySelector('.sidebar-nav .nav-tab[data-panel="'+panel+'"]');
    var label=(tab&&(tab.dataset.tooltip||tab.dataset.label))||panel;
    // Capitalize first letter
    label=label.charAt(0).toUpperCase()+label.slice(1);
    var chip=document.createElement('button');
    chip.type='button';
    chip.className='tab-visibility-chip';
    var isOff=hidden.indexOf(panel)!==-1;
    if(isOff)chip.classList.add('chip-off');
    chip.textContent=label;
    chip.setAttribute('data-tab-panel',panel);
    chip.setAttribute('draggable','true');
    // Use role="switch" + aria-checked instead of aria-pressed so screen
    // readers narrate "Tasks switch on/off" (matches user mental model) rather
    // than "Tasks toggle button pressed/not-pressed" (where the polarity is
    // confusing because chip-off looks like the "off" state).
    chip.setAttribute('role','switch');
    chip.setAttribute('aria-checked',isOff?'false':'true');
    chip.onclick=function(){
      if(Date.now()<_tabVisibilityDragSuppressUntil)return;
      _toggleTabVisibilityChip(panel);
    };
    _wireTabChipDrag(chip,panel);
    container.appendChild(chip);
  });
}

function _wireTabChipDrag(chip,panel){
  if(!chip)return;
  chip.addEventListener('dragstart',function(e){
    chip.classList.add('dragging');
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain',panel);
    }
  });
  chip.addEventListener('dragend',function(){chip.classList.remove('dragging');});
  chip.addEventListener('dragover',function(e){e.preventDefault();chip.classList.add('drag-over');if(e.dataTransfer)e.dataTransfer.dropEffect='move';});
  chip.addEventListener('dragleave',function(){chip.classList.remove('drag-over');});
  chip.addEventListener('drop',function(e){_handleTabVisibilityChipDrop(e,panel);});
}

function _moveTabOrderPanel(sourcePanel,targetPanel){
  if(!sourcePanel||!targetPanel||sourcePanel===targetPanel) return false;
  var order=_orderedSidebarPanels();
  var from=order.indexOf(sourcePanel);
  var to=order.indexOf(targetPanel);
  if(from===-1||to===-1) return false;
  order.splice(from,1);
  order.splice(to,0,sourcePanel);
  _setTabOrder(order);
  _applyTabOrder(order);
  _renderTabVisibilityChips();
  _scheduleAppearanceAutosave();
  return true;
}

function _handleTabVisibilityChipDrop(e,targetPanel){
  if(e){e.preventDefault();e.stopPropagation();}
  document.querySelectorAll('.tab-visibility-chip.drag-over').forEach(function(el){el.classList.remove('drag-over');});
  var sourcePanel=e&&e.dataTransfer?e.dataTransfer.getData('text/plain'):'';
  if(_moveTabOrderPanel(sourcePanel,targetPanel)) _tabVisibilityDragSuppressUntil=Date.now()+250;
}

function _toggleTabVisibilityChip(panel){
  if(_ALWAYS_VISIBLE_TABS.has(panel))return;
  var hidden=_getHiddenTabs();
  var idx=hidden.indexOf(panel);
  if(idx!==-1){
    hidden.splice(idx,1);
  }else{
    hidden.push(panel);
  }
  _setHiddenTabs(hidden);
  _applyTabVisibility(hidden);
  _renderTabVisibilityChips();
  _scheduleAppearanceAutosave();
}

function switchSettingsSection(name){
  // If the main content is not showing settings, just remember the section
  // without force-switching the panel. The section will be applied when the
  // user next opens settings via switchPanel(). (#appearance-auto-reopen)
  if (_currentPanel !== 'settings') {
    _currentSettingsSection = name;
    _settingsSection = name;
    return;
  }
  let section=(name==='appearance'||name==='preferences'||name==='providers'||name==='plugins'||name==='system'||name==='help'||name==='adapters')?name:'conversation';
  // Deep-linking to the Plugins pane when the tab is hidden (no plugins
  // installed, #3457) falls back to Conversation. Resolve this BEFORE toggling
  // panes/sidebar/dropdown below so every downstream selection uses the
  // corrected section — otherwise the plugins pane would still render active
  // but empty. (#3457)
  if(section==='plugins'){
    const pluginsTabBtn=document.querySelector('[data-settings-section="plugins"]');
    if(pluginsTabBtn && pluginsTabBtn.style.display==='none') section='conversation';
  }
  _settingsSection=section;
  _currentSettingsSection=section;
  const map={conversation:'Conversation',appearance:'Appearance',preferences:'Preferences',providers:'Providers',plugins:'Plugins',system:'System',help:'Help',adapters:'Adapters'};
  // Sidebar menu items
  document.querySelectorAll('#settingsMenu .side-menu-item').forEach(it=>{
    it.classList.toggle('active', it.dataset.settingsSection===section);
  });
  // Panes in main
  ['conversation','appearance','preferences','providers','plugins','system','help','adapters'].forEach(key=>{
    const pane=$('settingsPane'+map[key]);
    if(pane) pane.classList.toggle('active', key===section);
  });
  // Sync mobile dropdown
  const dd=$('settingsSectionDropdown');
  if(dd && dd.value!==section) dd.value=section;
  // Lazy-load integration panels when their tabs are opened
  if(section==='providers') loadProvidersPanel();
  if(section==='plugins') loadPluginsPanel();
  if(section==='adapters') loadAdaptersPanel();
}

function _syncHermesPanelSessionActions(){
  const hasSession=!!S.session;
  const visibleMessages=hasSession?(S.messages||[]).filter(m=>m&&m.role&&m.role!=='tool').length:0;
  const title=hasSession?(S.session.title||t('untitled')):t('active_conversation_none');
  const meta=$('hermesSessionMeta');
  if(meta){
    meta.textContent=hasSession
      ? t('active_conversation_meta', title, visibleMessages)
      : t('active_conversation_none');
  }
  const setDisabled=(id,disabled)=>{
    const el=$(id);
    if(!el)return;
    el.disabled=!!disabled;
    el.classList.toggle('disabled',!!disabled);
  };
  setDisabled('btnDownload',!hasSession||visibleMessages===0);
  setDisabled('btnExportJSON',!hasSession);
  setDisabled('btnClearConvModal',!hasSession||visibleMessages===0);
}

// Thin wrapper: settings now live in the main content area. External callers
// (keyboard shortcuts, commands) keep working through this name.
function toggleSettings(){
  if(_currentPanel==='settings'){
    _closeSettingsPanel();
  } else {
    switchPanel('settings');
  }
}

function _resetSettingsPanelState(){
  const bar=$('settingsUnsavedBar');
  if(bar) bar.style.display='none';
  _setAppearanceAutosaveStatus('');
}

function _hideSettingsPanel(){
  _resetSettingsPanelState();
  const target = _consumeSettingsTargetPanel('chat');
  if(_currentPanel==='settings') switchPanel(target, {bypassSettingsGuard:true});
}

// Close with unsaved-changes check. If dirty, show a confirm dialog.
function _closeSettingsPanel(){
  if(!_settingsDirty){
    _revertSettingsPreview();
    _hideSettingsPanel();
    return;
  }
  _pendingSettingsTargetPanel = _pendingSettingsTargetPanel || 'chat';
  _showSettingsUnsavedBar();
}

// Revert live DOM/localStorage to what they were when the panel opened
function _revertSettingsPreview(){
  // Appearance controls autosave immediately. Closing/discarding the settings
  // panel must not roll back theme, skin, or font-size after the user sees the
  // inline saved state.
}

// Show the "Unsaved changes" bar inside the settings panel
function _showSettingsUnsavedBar(){
  let bar = $('settingsUnsavedBar');
  if(bar){ bar.style.display=''; return; }
  // Create it
  bar = document.createElement('div');
  bar.id = 'settingsUnsavedBar';
  bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(233,69,96,.12);border:1px solid rgba(233,69,96,.3);border-radius:8px;padding:10px 14px;margin:0 0 12px;font-size:13px;';
  bar.innerHTML = `<span style="color:var(--text)">${esc(t('settings_unsaved_changes'))}</span>`
    + '<span style="display:flex;gap:8px">'
    + `<button onclick="_discardSettings()" style="padding:5px 12px;border-radius:6px;border:1px solid var(--border2);background:rgba(255,255,255,.06);color:var(--muted);cursor:pointer;font-size:12px;font-weight:600">${esc(t('discard'))}</button>`
    + `<button onclick="saveSettings(true)" style="padding:5px 12px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:12px;font-weight:600">${esc(t('save'))}</button>`
    + '</span>';
  const body = document.querySelector('#mainSettings .settings-main') || document.querySelector('.settings-main');
  if(body) body.prepend(bar);
}

function _discardSettings(){
  _revertSettingsPreview();
  _settingsDirty = false;
  _hideSettingsPanel();
}

// Mark settings as dirty whenever anything changes
function _markSettingsDirty(){
  _settingsDirty = true;
}

// Apply TTS enabled state: toggles a body class so the CSS rule
// `body.tts-enabled .msg-tts-btn` shows/hides the speaker icon. We toggle the
// body class instead of writing inline `style.display` because the parent
// `.msg-action-btn` has no display rule, so clearing the inline style let the
// `.msg-tts-btn{display:none;}` cascade re-hide the button (#1409).
function _applyTtsEnabled(enabled){
  document.body.classList.toggle('tts-enabled', !!enabled);
}

function _appearancePayloadFromUi(){
  const worklogDetailsExpanded=!!($('settingsWorklogDetailsExpandedDefault')||{}).checked;
  const chatActivityModeSel=$('settingsChatActivityDisplayMode');
  return {
    theme: ($('settingsTheme')||{}).value || localStorage.getItem('hermes-theme') || 'dark',
    skin: ($('settingsSkin')||{}).value || localStorage.getItem('hermes-skin') || 'default',
    font_size: ($('settingsFontSize')||{}).value || localStorage.getItem('hermes-font-size') || 'default',
    chat_activity_display_mode: chatActivityModeSel&&chatActivityModeSel.value==='transparent_stream'?'transparent_stream':'compact_worklog',
    session_jump_buttons: !!($('settingsSessionJumpButtons')||{}).checked,
    session_endless_scroll: !!($('settingsSessionEndlessScroll')||{}).checked,
    auto_scroll_follow: !!($('settingsAutoScrollFollow')||{}).checked,
    worklog_details_expanded_default: worklogDetailsExpanded,
    activity_feed_expanded_default: worklogDetailsExpanded,
    hidden_tabs: _getHiddenTabs(),
    tab_order: _getTabOrder(),
  };
}

function _syncChatActivityDisplayModeControl(mode){
  const next=mode==='transparent_stream'?'transparent_stream':'compact_worklog';
  const select=$('settingsChatActivityDisplayMode');
  if(select) select.value=next;
  document.querySelectorAll('[data-chat-activity-mode]').forEach(btn=>{
    const active=btn.getAttribute('data-chat-activity-mode')===next;
    btn.classList.toggle('active',active);
    btn.setAttribute('aria-pressed',active?'true':'false');
  });
  window._chatActivityDisplayMode=next;
  window._transparentStream=next==='transparent_stream';
}

function _pickChatActivityDisplayMode(mode){
  _syncChatActivityDisplayModeControl(mode);
  if(typeof clearMessageRenderCache==='function') clearMessageRenderCache();
  if(typeof renderMessages==='function') renderMessages({preserveScroll:true});
  _scheduleAppearanceAutosave();
}
if(typeof window!=='undefined') window._pickChatActivityDisplayMode=_pickChatActivityDisplayMode;

function _setAppearanceAutosaveStatus(state){
  const el=$('settingsAppearanceAutosaveStatus');
  if(!el) return;
  el.className='settings-autosave-status';
  if(!state){
    el.textContent='';
    return;
  }
  el.classList.add('is-'+state);
  if(state==='saving'){
    el.textContent=t('settings_autosave_saving');
  }else if(state==='saved'){
    el.textContent=t('settings_autosave_saved');
  }else if(state==='failed'){
    el.innerHTML=`<span>${esc(t('settings_autosave_failed'))}</span> <button type="button" onclick="_retryAppearanceAutosave()">${esc(t('settings_autosave_retry'))}</button>`;
  }
}

function _rememberAppearanceSaved(payload){
  if(!payload) return;
  _settingsThemeOnOpen=payload.theme||localStorage.getItem('hermes-theme')||'dark';
  _settingsSkinOnOpen=payload.skin||localStorage.getItem('hermes-skin')||'default';
  _settingsFontSizeOnOpen=payload.font_size||localStorage.getItem('hermes-font-size')||'default';
}

function _scheduleAppearanceAutosave(){
  const payload=_appearancePayloadFromUi();
  // Keep discard/close behavior aligned with the new mental model: appearance
  // changes are committed immediately instead of treated as preview-only edits.
  _rememberAppearanceSaved(payload);
  _settingsAppearanceAutosaveRetryPayload=payload;
  _setAppearanceAutosaveStatus('saving');
  if(_settingsAppearanceAutosaveTimer) clearTimeout(_settingsAppearanceAutosaveTimer);
  _settingsAppearanceAutosaveTimer=setTimeout(()=>_autosaveAppearanceSettings(payload),350);
}

async function _autosaveAppearanceSettings(payload){
  try{
    const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(payload)});
    _settingsAppearanceAutosaveRetryPayload=null;
    _rememberAppearanceSaved(payload);
    if(saved&&saved.font_size){
      localStorage.setItem('hermes-font-size',saved.font_size);
    }
    if(saved){
      window._sessionJumpButtonsEnabled=!!saved.session_jump_buttons;
      if(Object.prototype.hasOwnProperty.call(saved,'chat_activity_display_mode')){
        const beforeMode=window._chatActivityDisplayMode;
        _syncChatActivityDisplayModeControl(saved.chat_activity_display_mode);
        if(window._chatActivityDisplayMode!==beforeMode){
          if(typeof clearMessageRenderCache==='function') clearMessageRenderCache();
          if(typeof renderMessages==='function') renderMessages({preserveScroll:true});
        }
      }
      if(typeof _applySessionNavigationPrefs==='function') _applySessionNavigationPrefs();
    }
    window._sessionEndlessScrollEnabled=!!(saved&&saved.session_endless_scroll===true);
    window._autoScrollFollow=!saved||saved.auto_scroll_follow!==false;
    if(saved&&payload&&Object.prototype.hasOwnProperty.call(payload,'worklog_details_expanded_default')&&(
      Object.prototype.hasOwnProperty.call(saved,'worklog_details_expanded_default') ||
      Object.prototype.hasOwnProperty.call(saved,'activity_feed_expanded_default')
    )){
      window._worklogDetailsExpandedByDefault=!!(
        Object.prototype.hasOwnProperty.call(saved,'worklog_details_expanded_default')
          ? saved.worklog_details_expanded_default
          : saved.activity_feed_expanded_default
      );
    }
    _setAppearanceAutosaveStatus('saved');
  }catch(e){
    console.warn('[settings] appearance autosave failed', e);
    _setAppearanceAutosaveStatus('failed');
  }
}

function _retryAppearanceAutosave(){
  const payload=_settingsAppearanceAutosaveRetryPayload||_appearancePayloadFromUi();
  _setAppearanceAutosaveStatus('saving');
  _autosaveAppearanceSettings(payload);
}

// ── Phase 2: Preferences autosave (Issue #1003) ───────────────────────

function _preferencesPayloadFromUi(){
  const payload={};
  const sendKeySel=$('settingsSendKey');
  if(sendKeySel) payload.send_key=sendKeySel.value;
  const langSel=$('settingsLanguage');
  if(langSel) payload.language=langSel.value;
  const aiTimeoutField=$('settingsAiRequestTimeout');
  if(aiTimeoutField){
    let v=parseInt(aiTimeoutField.value,10)||600;
    if(v<30) v=30;
    if(v>1800) v=1800;
    payload.ai_request_timeout=v;
  }
  const maxIterField=$('settingsMaxIterations');
  if(maxIterField){
    let v=parseInt(maxIterField.value,10)||0;
    if(v<0) v=0;
    if(v>200) v=200;
    payload.max_iterations=v;
  }
  const autoLoadMemCb=$('settingsAutoLoadMemory');
  if(autoLoadMemCb) payload.auto_load_memory=autoLoadMemCb.checked;
  const showUsageCb=$('settingsShowTokenUsage');
  if(showUsageCb) payload.show_token_usage=showUsageCb.checked;
  const showQuotaChipCb=$('settingsShowQuotaChip');
  if(showQuotaChipCb) payload.show_quota_chip=showQuotaChipCb.checked;
  const showConversationOutlineCb=$('settingsShowConversationOutline');
  if(showConversationOutlineCb) payload.show_conversation_outline=showConversationOutlineCb.checked;
  const hideSuggestionsCb=$('settingsHideSuggestions');
  if(hideSuggestionsCb) payload.hide_empty_state_suggestions=hideSuggestionsCb.checked;
  const showTpsCb=$('settingsShowTps');
  if(showTpsCb) payload.show_tps=showTpsCb.checked;
  const fadeTextCb=$('settingsFadeTextEffect');
  if(fadeTextCb) payload.fade_text_effect=fadeTextCb.checked;
  const terminalAutoExpandCb=$('settingsTerminalAutoExpand');
  if(terminalAutoExpandCb) payload.terminal_auto_expand_on_output=terminalAutoExpandCb.checked;
  const showCliCb=$('settingsShowCliSessions');
  if(showCliCb) payload.show_cli_sessions=showCliCb.checked;
  const showCronCb=$('settingsShowCronSessions');
  // Gate cron sessions on CLI sessions (the server short-circuits otherwise),
  // identically to the explicit saveSettings() path, so neither save route can
  // persist show_cron_sessions=true while show_cli_sessions=false. (#3514)
  if(showCronCb) payload.show_cron_sessions=!!(showCliCb&&showCliCb.checked&&showCronCb.checked);
  const syncCb=$('settingsSyncInsights');
  if(syncCb) payload.sync_to_insights=syncCb.checked;
  const updateCb=$('settingsCheckUpdates');
  if(updateCb) payload.check_for_updates=updateCb.checked;
  const whatsNewSummaryCb=$('settingsWhatsNewSummary');
  if(whatsNewSummaryCb) payload.whats_new_summary_enabled=whatsNewSummaryCb.checked;
  const soundCb=$('settingsSoundEnabled');
  if(soundCb) payload.sound_enabled=soundCb.checked;
  const rtlCb=$('settingsRtl');
  if(rtlCb) payload.rtl=rtlCb.checked;
  const notifCb=$('settingsNotificationsEnabled');
  if(notifCb) payload.notifications_enabled=notifCb.checked;
  const sidebarDensitySel=$('settingsSidebarDensity');
  if(sidebarDensitySel) payload.sidebar_density=sidebarDensitySel.value;
  const autoTitleRefreshSel=$('settingsAutoTitleRefresh');
  if(autoTitleRefreshSel) payload.auto_title_refresh_every=parseInt(autoTitleRefreshSel.value,10);
  const busyInputModeSel=$('settingsBusyInputMode');
  if(busyInputModeSel) payload.busy_input_mode=busyInputModeSel.value;
  const botNameField=$('settingsBotName');
  if(botNameField) payload.bot_name=botNameField.value;
  return payload;
}

function adjustAiRequestTimeout(step){
  const el=$('settingsAiRequestTimeout');
  if(!el) return;
  let v=(parseInt(el.value,10)||600)+step;
  if(v<30) v=30;
  if(v>1800) v=1800;
  el.value=v;
  _schedulePreferencesAutosave();
}

function adjustMaxIterations(step){
  const el=$('settingsMaxIterations');
  if(!el) return;
  let v=(parseInt(el.value,10)||0)+step;
  if(v<0) v=0;
  if(v>200) v=200;
  el.value=v;
  _schedulePreferencesAutosave();
}

function _setPreferencesAutosaveStatus(state){
  const el=$('settingsPreferencesAutosaveStatus');
  if(!el) return;
  el.className='settings-autosave-status';
  if(!state){
    el.textContent='';
    return;
  }
  el.classList.add('is-'+state);
  if(state==='saving'){
    el.textContent=t('settings_autosave_saving');
  }else if(state==='saved'){
    el.textContent=t('settings_autosave_saved');
  }else if(state==='failed'){
    el.innerHTML=`<span>${esc(t('settings_autosave_failed'))}</span> <button type=\"button\" onclick=\"_retryPreferencesAutosave()\">${esc(t('settings_autosave_retry'))}</button>`;
  }
}

function _rememberPreferencesSaved(payload){
  if(!payload) return;
  if(payload.send_key!==undefined) localStorage.setItem('hermes-pref-send_key',payload.send_key);
  if(payload.language!==undefined) localStorage.setItem('hermes-pref-language',payload.language);
}

function _schedulePreferencesAutosave(){
  const payload=_preferencesPayloadFromUi();
  _rememberPreferencesSaved(payload);
  _settingsPreferencesAutosaveRetryPayload=payload;
  _setPreferencesAutosaveStatus('saving');
  if(_settingsPreferencesAutosaveTimer) clearTimeout(_settingsPreferencesAutosaveTimer);
  _settingsPreferencesAutosaveTimer=setTimeout(()=>_autosavePreferencesSettings(payload),350);
}

async function _autosavePreferencesSettings(payload){
  try{
    const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(payload)});
    if(payload&&payload.terminal_auto_expand_on_output!==undefined){
      window._terminalAutoExpandOnOutput=!!(saved&&saved.terminal_auto_expand_on_output);
    }
    if(payload&&Object.prototype.hasOwnProperty.call(payload,'fade_text_effect')) window._fadeTextEffect=!!payload.fade_text_effect;
    if(payload&&payload.show_tps!==undefined){
      window._showTps=!!(saved&&saved.show_tps);
      if(typeof clearMessageRenderCache==='function') clearMessageRenderCache();
      if(typeof renderMessages==='function') renderMessages();
    }
    if(payload&&payload.hide_empty_state_suggestions!==undefined){
      window._hideEmptyStateSuggestions=!!(saved&&saved.hide_empty_state_suggestions);
      if(typeof applyEmptyStateSuggestionPref==='function') applyEmptyStateSuggestionPref();
    }
    if(payload&&payload.show_conversation_outline!==undefined){
      window._showConversationOutline=!!(saved&&saved.show_conversation_outline);
      document.documentElement.dataset.conversationOutline=window._showConversationOutline?'enabled':'disabled';
      if(typeof applyConversationOutlinePreference==='function') applyConversationOutlinePreference();
    }
    _settingsPreferencesAutosaveRetryPayload=null;
    _setPreferencesAutosaveStatus('saved');
    // Only clear the global dirty flag and hide the unsaved-changes bar when
    // there is no pending edit on a manually-saved field. Password and model
    // are still committed via the explicit "Save Settings" button (password
    // for security; model goes through /api/default-model). Without this
    // guard, autosaving a checkbox right after a user typed in the password
    // field would silently dismiss the password edit. (Opus pre-release
    // review of v0.50.250, SHOULD-FIX Q1.)
    const pwField=$('settingsPassword');
    const pwDirty=!!(pwField&&pwField.value);
    const modelSel=$('settingsModel');
    const modelDirty=!!(modelSel&&((modelSel.value||'')!==(_settingsHermesDefaultModelOnOpen||'')));
    if(!pwDirty&&!modelDirty){
      _settingsDirty=false;
      const bar=$('settingsUnsavedBar');
      if(bar) bar.style.display='none';
    }
  }catch(e){
    console.warn('[settings] preferences autosave failed', e);
    _setPreferencesAutosaveStatus('failed');
  }
}

function _retryPreferencesAutosave(){
  const payload=_settingsPreferencesAutosaveRetryPayload||_preferencesPayloadFromUi();
  _setPreferencesAutosaveStatus('saving');
  _autosavePreferencesSettings(payload);
}

async function loadSettingsPanel(){
  try{
    const settings=await api('/api/settings');
    // Populate the version badges from the server — keeps them in sync with git
    // tags automatically without any manual release step.
    const webuiBadge = $('settings-webui-version-badge');
    if(webuiBadge){
      webuiBadge.textContent = `WebUI: ${settings.webui_version || 'not detected'}`;
    }
    const agentBadge = $('settings-agent-version-badge');
    if(agentBadge){
      const agentVersion = (settings.agent_version || 'not detected').toString().trim() || 'not detected';
      agentBadge.textContent = `Agent: ${agentVersion}`;
    }
    // Hydrate appearance controls first so a slow /api/models request
    // cannot overwrite an in-progress theme/skin selection.
    const themeSel=$('settingsTheme');
    const themeVal=settings.theme||'dark';
    if(themeSel) themeSel.value=themeVal;
    if(typeof _syncThemePicker==='function') _syncThemePicker(themeVal);
    const skinVal=(localStorage.getItem('hermes-skin')||settings.skin||'default').toLowerCase();
    const skinSel=$('settingsSkin');
    if(skinSel) skinSel.value=skinVal;
    if(typeof _buildSkinPicker==='function') _buildSkinPicker(skinVal);
    const fontSizeVal=settings.font_size||localStorage.getItem('hermes-font-size')||'default';
    localStorage.setItem('hermes-font-size',fontSizeVal);
    if(typeof _applyFontSize==='function') _applyFontSize(fontSizeVal);
    const fontSizeSel=$('settingsFontSize');
    if(fontSizeSel) fontSizeSel.value=fontSizeVal;
    if(typeof _syncFontSizePicker==='function') _syncFontSizePicker(fontSizeVal);
    const jumpButtonsCb=$('settingsSessionJumpButtons');
    if(jumpButtonsCb){
      jumpButtonsCb.checked=!!settings.session_jump_buttons;
      window._sessionJumpButtonsEnabled=jumpButtonsCb.checked;
      jumpButtonsCb.onchange=function(){
        window._sessionJumpButtonsEnabled=this.checked;
        if(typeof _applySessionNavigationPrefs==='function') _applySessionNavigationPrefs();
        _scheduleAppearanceAutosave();
      };
    }
    if(typeof _applySessionNavigationPrefs==='function') _applySessionNavigationPrefs();
    // Workspace panel default-open toggle (localStorage-backed)
    // Uses a separate key (voldp-ai-agent-workspace-panel-pref) so that
    // closing the panel via toolbar X does not clear the user's preference.
    const wsPanelCb=$('settingsWorkspacePanelOpen');
    if(wsPanelCb){
      wsPanelCb.checked=localStorage.getItem('voldp-ai-agent-workspace-panel-pref')==='open';
      wsPanelCb.onchange=function(){
        const open=this.checked;
        localStorage.setItem('voldp-ai-agent-workspace-panel-pref',open?'open':'closed');
        // Also sync the runtime key so the current session reflects the change
        localStorage.setItem('voldp-ai-agent-workspace-panel',open?'open':'closed');
        document.documentElement.dataset.workspacePanel=open?'open':'closed';
        if(open&&_workspacePanelMode==='closed') openWorkspacePanel('browse');
        else if(!open&&_workspacePanelMode!=='closed') toggleWorkspacePanel(false);
      };
    }
    const endlessScrollCb=$('settingsSessionEndlessScroll');
    if(endlessScrollCb){
      endlessScrollCb.checked=settings.session_endless_scroll===true;
      window._sessionEndlessScrollEnabled=endlessScrollCb.checked;
      endlessScrollCb.onchange=function(){
        window._sessionEndlessScrollEnabled=this.checked;
        _scheduleAppearanceAutosave();
      };
    }
    const autoScrollFollowCb=$('settingsAutoScrollFollow');
    if(autoScrollFollowCb){
      autoScrollFollowCb.checked=settings.auto_scroll_follow!==false;
      window._autoScrollFollow=autoScrollFollowCb.checked;
      autoScrollFollowCb.onchange=function(){
        window._autoScrollFollow=this.checked;
        _scheduleAppearanceAutosave();
      };
    }
    const worklogDetailsExpandedCb=$('settingsWorklogDetailsExpandedDefault');
    const chatActivityModeSel=$('settingsChatActivityDisplayMode');
    if(chatActivityModeSel){
      _syncChatActivityDisplayModeControl(settings.chat_activity_display_mode);
      chatActivityModeSel.addEventListener('change',()=>{
        _pickChatActivityDisplayMode(chatActivityModeSel.value);
      },{once:false});
    }
    if(worklogDetailsExpandedCb){
      const worklogDetailsExpanded=Object.prototype.hasOwnProperty.call(settings,'worklog_details_expanded_default')
        ? settings.worklog_details_expanded_default
        : Object.prototype.hasOwnProperty.call(settings,'activity_feed_expanded_default')
          ? settings.activity_feed_expanded_default
          : true;
      worklogDetailsExpandedCb.checked=!!worklogDetailsExpanded;
      window._worklogDetailsExpandedByDefault=worklogDetailsExpandedCb.checked;
      worklogDetailsExpandedCb.onchange=function(){
        window._worklogDetailsExpandedByDefault=this.checked;
        if(typeof _applyWorklogDetailsExpandedDefault==='function') _applyWorklogDetailsExpandedDefault();
        _scheduleAppearanceAutosave();
      };
    }
    // Tab visibility/order chips (dynamically populated from DOM)
    var hiddenTabs=[];
    if(Array.isArray(settings.hidden_tabs)){
      // Server value takes priority — even an empty array means "no tabs hidden"
      hiddenTabs=settings.hidden_tabs.filter(function(s){return typeof s==='string'&&s.trim();});
    }else{
      // Server has no hidden_tabs key — fall back to localStorage
      hiddenTabs=_getHiddenTabs();
    }
    var tabOrder=[];
    if(Array.isArray(settings.tab_order)){
      tabOrder=settings.tab_order.filter(function(s){return typeof s==='string'&&s.trim();});
    }else{
      tabOrder=_getTabOrder();
    }
    _setTabOrder(tabOrder);
    _applyTabOrder(tabOrder);
    _setHiddenTabs(hiddenTabs);
    _applyTabVisibility(hiddenTabs);
    _renderTabVisibilityChips();
    const resolvedLanguage=(typeof resolvePreferredLocale==='function')
      ? resolvePreferredLocale(settings.language, localStorage.getItem('hermes-lang'))
      : (settings.language || localStorage.getItem('hermes-lang') || 'en');
    // Keep settings modal and current page strings in sync with the resolved locale.
    if(typeof setLocale==='function'){
      setLocale(resolvedLanguage);
      if(typeof applyLocaleToDOM==='function') applyLocaleToDOM();
    }
    // Populate model dropdown from /api/models + live model fetch (#872)
    const modelSel=$('settingsModel');
    if(modelSel){
      modelSel.innerHTML='';
      let models=null;
      try{
        models=await api('/api/models');
        for(const g of ((models||{}).groups||[])){
          const og=document.createElement('optgroup');
          og.label=g.provider;
          if(g.provider_id) og.dataset.provider=g.provider_id;
          for(const m of g.models){
            const opt=document.createElement('option');
            opt.value=m.id;opt.textContent=m.label;
            og.appendChild(opt);
          }
          modelSel.appendChild(og);
        }
        // Append live-fetched models for the active provider, same as the
        // chat-header dropdown does via _fetchLiveModels() (#872).
        if(models.active_provider && typeof _fetchLiveModels==='function'){
          _fetchLiveModels(models.active_provider, modelSel);
        }
      }catch(e){}
      _settingsHermesDefaultModelOnOpen=(models&&models.default_model)||'';
      // Use the smart matcher so a saved bare form like "anthropic/claude-opus-4.6"
      // (what the CLI's `hermes model` command writes) still selects the matching
      // `@nous:anthropic/claude-opus-4.6` option on a Nous setup. Without this, the
      // picker renders blank for any user whose default was persisted without the
      // @-prefix — CLI-first users, legacy installs, etc.
      if(typeof _applyModelToDropdown==='function'){
        _applyModelToDropdown(_settingsHermesDefaultModelOnOpen, modelSel, (models&&models.active_provider)||window._activeProvider||null);
      }else{
        modelSel.value=_settingsHermesDefaultModelOnOpen;
      }
      modelSel.addEventListener('change',_markSettingsDirty,{once:false});
    }
    // Auxiliary models — load task assignments and provider/model options
    _loadAuxiliaryModels();
    // Send key preference
    const sendKeySel=$('settingsSendKey');
    if(sendKeySel){sendKeySel.value=settings.send_key||'enter';sendKeySel.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    // Language preference — populate from LOCALES bundle
    const langSel=$('settingsLanguage');
    if(langSel){
      langSel.innerHTML='';
      if(typeof LOCALES!=='undefined'){
        for(const [code,bundle] of Object.entries(LOCALES)){
          const opt=document.createElement('option');
          opt.value=code;opt.textContent=bundle._label||code;
          langSel.appendChild(opt);
        }
      }
      langSel.value=resolvedLanguage;
      langSel.addEventListener('change',function(){
        if(typeof setLocale==='function'){setLocale(this.value);if(typeof applyLocaleToDOM==='function')applyLocaleToDOM();}
        _schedulePreferencesAutosave();
      },{once:false});
    }
    // AI request timeout preference
    const aiTimeoutField=$('settingsAiRequestTimeout');
    if(aiTimeoutField){
      let v=parseInt(settings.ai_request_timeout,10);
      if(isNaN(v)||v<30) v=30;
      if(v>1800) v=1800;
      aiTimeoutField.value=v;
      aiTimeoutField.addEventListener('change',function(){
        let nv=parseInt(this.value,10)||600;
        if(nv<30) nv=30;
        if(nv>1800) nv=1800;
        this.value=nv;
        _schedulePreferencesAutosave();
      },{once:false});
      aiTimeoutField.addEventListener('input',function(){
        let nv=parseInt(this.value,10);
        if(isNaN(nv)) return;
        if(nv<30) nv=30;
        if(nv>1800) nv=1800;
        this.value=nv;
      },{once:false});
    }
    // Max iterations preference
    const maxIterField=$('settingsMaxIterations');
    if(maxIterField){
      let v=parseInt(settings.max_iterations,10);
      if(isNaN(v)||v<0) v=0;
      if(v>200) v=200;
      maxIterField.value=v;
      maxIterField.addEventListener('change',function(){
        let nv=parseInt(this.value,10)||0;
        if(nv<0) nv=0;
        if(nv>200) nv=200;
        this.value=nv;
        _schedulePreferencesAutosave();
      },{once:false});
      maxIterField.addEventListener('input',function(){
        let nv=parseInt(this.value,10);
        if(isNaN(nv)) return;
        if(nv<0) nv=0;
        if(nv>200) nv=200;
        this.value=nv;
      },{once:false});
    }
    // Auto-load memory preference
    const autoLoadMemCb=$('settingsAutoLoadMemory');
    if(autoLoadMemCb){
      autoLoadMemCb.checked=settings.auto_load_memory!==false;
      autoLoadMemCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});
    }
    const showUsageCb=$('settingsShowTokenUsage');
    if(showUsageCb){showUsageCb.checked=!!settings.show_token_usage;showUsageCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    // Ambient provider quota chip toggle — default off; only shows at ≥1400px viewport
    // when enabled (see style.css @media (max-width:1399.98px) rule).
    const showQuotaChipCb=$('settingsShowQuotaChip');
    if(showQuotaChipCb){
      showQuotaChipCb.checked=settings.show_quota_chip===true;
      window._showQuotaChip=showQuotaChipCb.checked;
      showQuotaChipCb.addEventListener('change',()=>{
        window._showQuotaChip=showQuotaChipCb.checked;
        if(typeof refreshProviderQuotaIndicator==='function') refreshProviderQuotaIndicator();
        _schedulePreferencesAutosave();
      },{once:false});
    }
    const hideSuggestionsCb=$('settingsHideSuggestions');
    if(hideSuggestionsCb){
      hideSuggestionsCb.checked=settings.hide_empty_state_suggestions===true;
      window._hideEmptyStateSuggestions=hideSuggestionsCb.checked;
      if(typeof applyEmptyStateSuggestionPref==='function') applyEmptyStateSuggestionPref();
      hideSuggestionsCb.addEventListener('change',()=>{
        window._hideEmptyStateSuggestions=hideSuggestionsCb.checked;
        if(typeof applyEmptyStateSuggestionPref==='function') applyEmptyStateSuggestionPref();
        _schedulePreferencesAutosave();
      },{once:false});
    }
    const showConversationOutlineCb=$('settingsShowConversationOutline');
    if(showConversationOutlineCb){
      showConversationOutlineCb.checked=settings.show_conversation_outline===true;
      window._showConversationOutline=showConversationOutlineCb.checked;
      document.documentElement.dataset.conversationOutline=window._showConversationOutline?'enabled':'disabled';
      if(typeof applyConversationOutlinePreference==='function') applyConversationOutlinePreference();
      showConversationOutlineCb.addEventListener('change',()=>{
        _schedulePreferencesAutosave();
        window._showConversationOutline=showConversationOutlineCb.checked;
        document.documentElement.dataset.conversationOutline=window._showConversationOutline?'enabled':'disabled';
        if(typeof applyConversationOutlinePreference==='function') applyConversationOutlinePreference();
      },{once:false});
    }
    const showTpsCb=$('settingsShowTps');
    if(showTpsCb){showTpsCb.checked=!!settings.show_tps;showTpsCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const fadeTextCb=$('settingsFadeTextEffect');
    if(fadeTextCb){
      fadeTextCb.checked=!!settings.fade_text_effect;
      window._fadeTextEffect=fadeTextCb.checked;
      fadeTextCb.addEventListener('change',()=>{
        window._fadeTextEffect=fadeTextCb.checked;
        _schedulePreferencesAutosave();
      },{once:false});
    }
    const terminalAutoExpandCb=$('settingsTerminalAutoExpand');
    if(terminalAutoExpandCb){terminalAutoExpandCb.checked=!!settings.terminal_auto_expand_on_output;window._terminalAutoExpandOnOutput=terminalAutoExpandCb.checked;terminalAutoExpandCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const showCliCb=$('settingsShowCliSessions');
    if(showCliCb){showCliCb.checked=!!settings.show_cli_sessions;showCliCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const showCronCb=$('settingsShowCronSessions');
    if(showCronCb){
      showCronCb.checked=!!settings.show_cron_sessions;
      showCronCb.disabled=showCliCb?!showCliCb.checked:true;
      showCronCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});
      if(showCliCb){showCliCb.addEventListener('change',function(){showCronCb.disabled=!showCliCb.checked;},{once:false});}
    }
    const syncCb=$('settingsSyncInsights');
    if(syncCb){syncCb.checked=!!settings.sync_to_insights;syncCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const updateCb=$('settingsCheckUpdates');
    if(updateCb){updateCb.checked=settings.check_for_updates!==false;updateCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const whatsNewSummaryCb=$('settingsWhatsNewSummary');
    if(whatsNewSummaryCb){whatsNewSummaryCb.checked=!!settings.whats_new_summary_enabled;whatsNewSummaryCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    const soundCb=$('settingsSoundEnabled');
    if(soundCb){soundCb.checked=!!settings.sound_enabled;soundCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    // Right-to-left chat layout (#1721 salvage) — Settings-only, no composer button.
    const rtlCb=$('settingsRtl');
    if(rtlCb){
      const saved=!!settings.rtl || localStorage.getItem('hermes-rtl')==='true';
      rtlCb.checked=saved;
      try{localStorage.setItem('hermes-rtl',saved?'true':'false');}catch(_){}
      document.documentElement.classList.toggle('chat-content-rtl',saved);
      rtlCb.addEventListener('change',()=>{
        const on=rtlCb.checked;
        try{localStorage.setItem('hermes-rtl',on?'true':'false');}catch(_){}
        document.documentElement.classList.toggle('chat-content-rtl',on);
        _schedulePreferencesAutosave();
      },{once:false});
    }
    // TTS settings (localStorage-only, no server round-trip needed)
    const ttsEnabledCb=$('settingsTtsEnabled');
    if(ttsEnabledCb){ttsEnabledCb.checked=localStorage.getItem('hermes-tts-enabled')==='true';ttsEnabledCb.onchange=function(){localStorage.setItem('hermes-tts-enabled',this.checked?'true':'false');_applyTtsEnabled(this.checked);};}
    const ttsAutoReadCb=$('settingsTtsAutoRead');
    if(ttsAutoReadCb){ttsAutoReadCb.checked=localStorage.getItem('hermes-tts-auto-read')==='true';ttsAutoReadCb.onchange=function(){localStorage.setItem('hermes-tts-auto-read',this.checked?'true':'false');};}
    // Voice-mode button visibility (#1488). localStorage-only; no server round-trip.
    // Toggling re-applies immediately via the boot.js helper so the user sees
    // the audio-waveform button appear/disappear without a reload.
    const voiceModeCb=$('settingsVoiceModeEnabled');
    if(voiceModeCb){
      voiceModeCb.checked=localStorage.getItem('hermes-voice-mode-button')==='true';
      voiceModeCb.onchange=function(){
        localStorage.setItem('hermes-voice-mode-button',this.checked?'true':'false');
        if(typeof window._applyVoiceModePref==='function') window._applyVoiceModePref();
      };
    }
    // TTS engine selector
    const ttsEngineSel=$('settingsTtsEngine');
    if(ttsEngineSel){
      const saved=localStorage.getItem('hermes-tts-engine')||'browser';
      ttsEngineSel.value=saved;
      ttsEngineSel.onchange=function(){
        localStorage.setItem('hermes-tts-engine',this.value);
        window._populateTtsVoices();
      };
    }
    // Populate voice selector based on engine
    const ttsVoiceSel=$('settingsTtsVoice');
    window._populateTtsVoices=function(){
      if(!ttsVoiceSel) return;
      const engine=localStorage.getItem('hermes-tts-engine')||'browser';
      const current=localStorage.getItem('hermes-tts-voice')||'';
      if(engine==='edge'){
        const edgeVoices=[
          {value:'zh-CN-XiaoxiaoNeural',label:'Xiaoxiao (Chinese, Female)'},
          {value:'zh-CN-XiaoyiNeural',label:'Xiaoyi (Chinese, Female)'},
          {value:'zh-CN-YunxiNeural',label:'Yunxi (Chinese, Male)'},
          {value:'zh-CN-YunjianNeural',label:'Yunjian (Chinese, Male)'},
          {value:'zh-CN-YunyangNeural',label:'Yunyang (Chinese, Male)'},
          {value:'en-US-AriaNeural',label:'Aria (English, Female)'},
          {value:'en-US-GuyNeural',label:'Guy (English, Male)'},
        ];
        ttsVoiceSel.innerHTML='<option value="">Default (Xiaoxiao)</option>';
        edgeVoices.forEach(v=>{
          const opt=document.createElement('option');
          opt.value=v.value;opt.textContent=v.label;
          if(v.value===current) opt.selected=true;
          ttsVoiceSel.appendChild(opt);
        });
      } else {
        if(!('speechSynthesis' in window)){
          ttsVoiceSel.innerHTML='<option value="">Speech synthesis not available</option>';
          return;
        }
        const voices=speechSynthesis.getVoices();
        const uiLang=(typeof navigator!=='undefined'&&(navigator.language||navigator.userLanguage||''))||'en';
        const priority=['zh','ja','ko','en','de','fr','es','it','pt','ru'];
        const sorted=[...voices].sort((a,b)=>{
          const aLang=(a.lang||'').toLowerCase().slice(0,2);
          const bLang=(b.lang||'').toLowerCase().slice(0,2);
          const aIdx=priority.indexOf(aLang);
          const bIdx=priority.indexOf(bLang);
          if(aIdx!==bIdx){
            if(aIdx===-1) return 1;
            if(bIdx===-1) return -1;
            return aIdx-bIdx;
          }
          return (a.name||'').localeCompare(b.name||'');
        });
        ttsVoiceSel.innerHTML='<option value="">'+esc(t('tts_default_voice')||'默认系统语音')+'</option>';
        sorted.forEach(v=>{
          const opt=document.createElement('option');
          opt.value=v.name;
          const langLabel=v.lang?' ('+v.lang+')':'';
          opt.textContent=v.name+langLabel;
          if(v.name===current) opt.selected=true;
          ttsVoiceSel.appendChild(opt);
        });
      }
    };
    if(ttsVoiceSel&&'speechSynthesis' in window){
      window._populateTtsVoices();
      speechSynthesis.addEventListener('voiceschanged',function(){
        const engine=localStorage.getItem('hermes-tts-engine')||'browser';
        if(engine==='browser') window._populateTtsVoices();
      },{once:false});
      ttsVoiceSel.onchange=function(){localStorage.setItem('hermes-tts-voice',this.value);};
    }
    // TTS rate/pitch sliders
    const ttsRateSlider=$('settingsTtsRate');
    const ttsRateValue=$('settingsTtsRateValue');
    if(ttsRateSlider){
      const savedRate=localStorage.getItem('hermes-tts-rate');
      ttsRateSlider.value=savedRate||'1';
      if(ttsRateValue) ttsRateValue.textContent=parseFloat(ttsRateSlider.value).toFixed(1)+'x';
      ttsRateSlider.oninput=function(){if(ttsRateValue)ttsRateValue.textContent=parseFloat(this.value).toFixed(1)+'x';localStorage.setItem('hermes-tts-rate',this.value);};
    }
    const ttsPitchSlider=$('settingsTtsPitch');
    const ttsPitchValue=$('settingsTtsPitchValue');
    if(ttsPitchSlider){
      const savedPitch=localStorage.getItem('hermes-tts-pitch');
      ttsPitchSlider.value=savedPitch||'1';
      if(ttsPitchValue) ttsPitchValue.textContent=parseFloat(ttsPitchSlider.value).toFixed(1);
      ttsPitchSlider.oninput=function(){if(ttsPitchValue)ttsPitchValue.textContent=parseFloat(this.value).toFixed(1);localStorage.setItem('hermes-tts-pitch',this.value);};
    }
    const notifCb=$('settingsNotificationsEnabled');
    if(notifCb){notifCb.checked=settings.notifications_enabled!==false;notifCb.addEventListener('change',_schedulePreferencesAutosave,{once:false});}
    // show_thinking has no settings panel checkbox — controlled via /reasoning show|hide
    const sidebarDensitySel=$('settingsSidebarDensity');
    if(sidebarDensitySel){
      sidebarDensitySel.value=settings.sidebar_density==='detailed'?'detailed':'compact';
      sidebarDensitySel.addEventListener('change',_schedulePreferencesAutosave,{once:false});
    }
    const autoTitleRefreshSel=$('settingsAutoTitleRefresh');
    if(autoTitleRefreshSel){
      const val=String(settings.auto_title_refresh_every||'0');
      autoTitleRefreshSel.value=['0','5','10','20'].includes(val)?val:'0';
      autoTitleRefreshSel.addEventListener('change',_schedulePreferencesAutosave,{once:false});
    }
    // Busy input mode
    const busyInputModeSel=$('settingsBusyInputMode');
    if(busyInputModeSel){
      const val=String(settings.busy_input_mode||'queue');
      busyInputModeSel.value=['queue','interrupt','steer'].includes(val)?val:'queue';
      busyInputModeSel.addEventListener('change',_schedulePreferencesAutosave,{once:false});
    }
    // Bot name — debounced autosave (text input)
    const botNameField=$('settingsBotName');
    if(botNameField){
      botNameField.value=settings.bot_name||'Hermes';
      let botNameTimer=null;
      botNameField.addEventListener('input',()=>{
        if(botNameTimer) clearTimeout(botNameTimer);
        botNameTimer=setTimeout(_schedulePreferencesAutosave,500);
      },{once:false});
    }
    // Password field: always blank (we don't send hash back)
    const pwField=$('settingsPassword');
    if(pwField){pwField.value='';pwField.addEventListener('input',_markSettingsDirty,{once:false});}
    // Toggle password visibility (Settings)
    _wirePasswordToggle(document,'#settingsPassword','#_settingsPasswordToggle','#_settingsPasswordIconShow','#_settingsPasswordIconHide');
    // #1560: when HERMES_WEBUI_PASSWORD env var is set, the settings password
    // field silently no-ops. Disable it + reveal the lock banner so the UI
    // tells the truth before a user tries (and the backend now also returns
    // 409 as defense-in-depth).
    const pwEnvLocked=!!settings.password_env_var;
    _settingsPasswordEnvLocked=pwEnvLocked;
    const pwLockBanner=$('settingsPasswordEnvLock');
    if(pwField){
      pwField.disabled=pwEnvLocked;
      if(pwEnvLocked){
        pwField.value='';
        pwField.placeholder=t('password_env_var_locked_placeholder')||pwField.placeholder;
      }
    }
    if(pwLockBanner) pwLockBanner.style.display=pwEnvLocked?'block':'none';
    // Show auth buttons only when auth is active
    try{
      const authStatus=await api('/api/auth/status');
      _setSettingsAuthButtonsVisible(!!authStatus.auth_enabled);
      _syncPasswordlessButton(authStatus);
    }catch(e){}
    loadPasskeys();
    // #1560: env-var-locked password also disables the Disable Auth button —
    // clearing settings.password_hash is silent no-op when the env var is set,
    // and the backend now returns 409 anyway, so don't offer the action.
    // Sign Out remains available since it only clears the session cookie.
    if(pwEnvLocked){
      const disableBtn=$('btnDisableAuth');
      if(disableBtn) disableBtn.style.display='none';
    }
    _syncHermesPanelSessionActions();
    if(typeof loadDashboardSettings==='function') loadDashboardSettings();
    loadProvidersPanel(); // load provider cards in background
    loadPluginsPanel(); // load plugin/hook visibility in background
    switchSettingsSection(_settingsSection);
  }catch(e){
    showToast(t('settings_load_failed')+e.message);
  }
}


// ── Plugins panel (read-only plugin/hook visibility) ───────────────────────

async function handlePluginEnableToggle(pluginKey, checked){
  try{
    const body={dashboard_plugins:{}};
    body.dashboard_plugins[pluginKey]=!!checked;
    await api('/api/settings',{method:'POST',body:JSON.stringify(body)});
    loadPluginsPanel();
  }catch(e){
    showToast(t('settings_save_failed')+e.message);
  }
}

async function loadPluginsPanel(){
  const list=$('pluginsList');
  const empty=$('pluginsEmpty');
  if(!list) return;
  try{
    const data=await api('/api/plugins');
    const plugins=Array.isArray((data||{}).plugins)?data.plugins:[];
    // Hide the Plugins tab when no plugins are installed (#3457)
    const tabBtn=document.querySelector('[data-settings-section="plugins"]');
    if(tabBtn) tabBtn.style.display=(data&&data.empty)?'none':'';
    list.innerHTML='';
    if(plugins.length===0){
      list.style.display='none';
      if(empty) empty.style.display='';
      return;
    }
    if(empty) empty.style.display='none';
    list.style.display='';
    for(const plugin of plugins){
      list.appendChild(_buildPluginCard(plugin));
    }
  }catch(e){
    list.innerHTML='<div style="color:var(--error);padding:12px;font-size:13px">'+t('plugins_load_failed')+esc(e.message||String(e))+'</div>';
  }
}

// ── IM Adapters panel ───────────────────────────────────────────────────────

let _adapterConfig=null;
const _adapterQrSessions={}; // platform -> {token,timer,expiresAt}
let _wechatQrLoginSession=null; // {sessionKey,timer,expiresAt}

// 通用密码/密钥显示切换：在指定 modal 内绑定 toggle 按钮的点击事件
function _wirePasswordToggle(scope,inputSel,btnSel,iconShowSel,iconHideSel){
  const input=scope.querySelector(inputSel);
  const btn=scope.querySelector(btnSel);
  const iconShow=scope.querySelector(iconShowSel);
  const iconHide=scope.querySelector(iconHideSel);
  if(!input||!btn) return;
  btn.addEventListener('click',()=>{
    if(input.type==='password'){
      input.type='text';
      btn.title=t('providers_hide_api_key')||'Hide API key';
      if(iconShow) iconShow.style.display='none';
      if(iconHide) iconHide.style.display='';
    }else{
      input.type='password';
      btn.title=t('providers_show_api_key')||'Show API key';
      if(iconShow) iconShow.style.display='';
      if(iconHide) iconHide.style.display='none';
    }
  });
}

function _adapterPlatformName(platform){
  const names={telegram:'Telegram',feishu:'Feishu',wechat:'WeChat',dingtalk:'DingTalk',whatsapp:'WhatsApp',wecom:'WeCom',qq:'QQ'};
  return names[platform]||platform;
}

function _adapterFormatDate(ts){
  if(!ts) return '';
  const d=new Date(ts);
  if(isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function _adapterCommaSplit(s){
  if(!s||!s.trim()) return [];
  return s.split(',').map(x=>x.trim()).filter(Boolean);
}

function _adapterCommaJoin(arr){
  return Array.isArray(arr)?arr.join(', '):'';
}

function _adapterEnsureConfig(cfg){
  cfg=cfg||{};
  cfg.serverUrl=cfg.serverUrl||'';
  cfg.defaultProjectDir=cfg.defaultProjectDir||'';
  cfg.pairing=cfg.pairing||{};
  cfg.telegram=cfg.telegram||{};
  cfg.feishu=cfg.feishu||{};
  cfg.wechat=cfg.wechat||{};
  cfg.dingtalk=cfg.dingtalk||{};
  cfg.whatsapp=cfg.whatsapp||{};
  return cfg;
}

function _adapterCollectConfig(){
  return {
    serverUrl:($('adapterServerUrl')||{}).value||'',
    defaultProjectDir:($('adapterDefaultProjectDir')||{}).value||'',
    pairing:_adapterConfig?(_adapterConfig.pairing||{}):{},
    telegram:{
      botToken:($('adapterTelegramBotToken')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterTelegramAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.telegram)?(_adapterConfig.telegram.pairedUsers||[]):[],
      defaultWorkDir:($('adapterTelegramDefaultWorkDir')||{}).value||'',
      enabled:!!($('adapterTelegramEnabled')||{}).checked,
    },
    feishu:{
      appId:($('adapterFeishuAppId')||{}).value||'',
      appSecret:($('adapterFeishuAppSecret')||{}).value||'',
      encryptKey:($('adapterFeishuEncryptKey')||{}).value||'',
      verificationToken:($('adapterFeishuVerificationToken')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterFeishuAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.feishu)?(_adapterConfig.feishu.pairedUsers||[]):[],
      defaultWorkDir:($('adapterFeishuDefaultWorkDir')||{}).value||'',
      streamingCard:!!($('adapterFeishuStreamingCard')||{}).checked,
      enabled:!!($('adapterFeishuEnabled')||{}).checked,
    },
    wechat:{
      accountId:($('adapterWechatAccountId')||{}).value||'',
      botToken:($('adapterWechatBotToken')||{}).value||'',
      baseUrl:($('adapterWechatBaseUrl')||{}).value||'',
      userId:($('adapterWechatUserId')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterWechatAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.wechat)?(_adapterConfig.wechat.pairedUsers||[]):[],
      defaultWorkDir:($('adapterWechatDefaultWorkDir')||{}).value||'',
      enabled:!!($('adapterWechatEnabled')||{}).checked,
    },
    dingtalk:{
      clientId:($('adapterDingtalkClientId')||{}).value||'',
      clientSecret:($('adapterDingtalkClientSecret')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterDingtalkAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.dingtalk)?(_adapterConfig.dingtalk.pairedUsers||[]):[],
      defaultWorkDir:($('adapterDingtalkDefaultWorkDir')||{}).value||'',
      endpoint:($('adapterDingtalkEndpoint')||{}).value||'',
      enabled:!!($('adapterDingtalkEnabled')||{}).checked,
    },
    whatsapp:{
      accountJid:($('adapterWhatsappAccountJid')||{}).value||'',
      authDir:($('adapterWhatsappAuthDir')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterWhatsappAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.whatsapp)?(_adapterConfig.whatsapp.pairedUsers||[]):[],
      defaultWorkDir:($('adapterWhatsappDefaultWorkDir')||{}).value||'',
      enabled:!!($('adapterWhatsappEnabled')||{}).checked,
    },
    wecom:{
      botId:($('adapterWecomBotId')||{}).value||'',
      secret:($('adapterWecomSecret')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterWecomAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.wecom)?(_adapterConfig.wecom.pairedUsers||[]):[],
      defaultWorkDir:($('adapterWecomDefaultWorkDir')||{}).value||'',
      enabled:!!($('adapterWecomEnabled')||{}).checked,
    },
    qq:{
      appId:($('adapterQQAppId')||{}).value||'',
      appSecret:($('adapterQQAppSecret')||{}).value||'',
      allowedUsers:_adapterCommaSplit(($('adapterQQAllowedUsers')||{}).value),
      pairedUsers:(_adapterConfig&&_adapterConfig.qq)?(_adapterConfig.qq.pairedUsers||[]):[],
      defaultWorkDir:($('adapterQQDefaultWorkDir')||{}).value||'',
      enabled:!!($('adapterQQEnabled')||{}).checked,
    },
  };
}

function _adapterSetValue(id,value){
  const el=$(id);
  if(!el) return;
  if(el.type==='checkbox') el.checked=!!value;
  else el.value=value==null?'':value;
}

function _adapterRenderPairedUsers(listId,users,platform){
  const container=$(listId);
  if(!container) return;
  users=Array.isArray(users)?users:[];
  if(users.length===0){
    container.innerHTML='<div class="adapters-empty-list">'+esc(t('settings_adapters_no_paired_users')||'No paired users.')+'</div>';
    return;
  }
  container.innerHTML=users.map(u=>{
    const name=esc(u.displayName||u.userId||'Unknown');
    const id=esc(String(u.userId||''));
    const itemPlatform=platform==='all'?(u.platform||'all'):platform;
    const date=_adapterFormatDate(u.pairedAt);
    return `<div class="adapters-paired-user">
      <div class="adapters-paired-user-info">
        <span class="adapters-platform-badge">${esc(_adapterPlatformName(itemPlatform))}</span>
        <span class="adapters-paired-user-name" title="${id}">${name}</span>
        ${date?`<span class="adapters-paired-user-meta">${esc(date)}</span>`:''}
      </div>
      <button type="button" class="adapters-paired-user-unbind" data-platform="${esc(itemPlatform)}" data-userid="${id}">${esc(t('settings_adapters_unbind')||'Unbind')}</button>
    </div>`;
  }).join('');
  container.querySelectorAll('.adapters-paired-user-unbind').forEach(btn=>{
    btn.addEventListener('click',()=>unbindPairedUser(btn.dataset.platform,btn.dataset.userid));
  });
}

function _adapterUpdateBindButtons(){
  const platforms=['feishu','wechat','dingtalk','whatsapp'];
  platforms.forEach(platform=>{
    const cfg=(_adapterConfig&&_adapterConfig[platform])||{};
    const paired=Array.isArray(cfg.pairedUsers)?cfg.pairedUsers:[];
    const bindBtn=$('btnBind'+platform.charAt(0).toUpperCase()+platform.slice(1));
    const unbindBtn=$('btnUnbind'+platform.charAt(0).toUpperCase()+platform.slice(1));
    if(bindBtn) bindBtn.disabled=false;
    if(unbindBtn) unbindBtn.disabled=paired.length===0;
  });
}

async function loadAdaptersPanel(){
  // 更新 Running Platforms 列表（显示当前运行的 IM 适配器平台）
  try{
    const gs=await api('/api/gateway/status');
    const platformList=$('adaptersPlatformList');
    if(platformList){
      const platforms=(gs&&gs.platforms)||[];
      platformList.innerHTML=platforms.length
        ? platforms.map(p=>`<span class="adapters-platform-badge">${p}</span>`).join('')
        : '<span class="adapters-platform-none">none</span>';
    }
  }catch(e){}
  try{
    const cfg=_adapterEnsureConfig(await api('/api/adapters/config'));
    _adapterConfig=cfg;
    _adapterSetValue('adapterServerUrl',cfg.serverUrl);
    _adapterSetValue('adapterDefaultProjectDir',cfg.defaultProjectDir);

    const tg=cfg.telegram||{};
    _adapterSetValue('adapterTelegramEnabled',tg.enabled);
    _adapterSetValue('adapterTelegramBotToken',tg.botToken);
    _adapterSetValue('adapterTelegramAllowedUsers',_adapterCommaJoin(tg.allowedUsers));
    _adapterSetValue('adapterTelegramDefaultWorkDir',tg.defaultWorkDir);

    const fs=cfg.feishu||{};
    _adapterSetValue('adapterFeishuEnabled',fs.enabled);
    _adapterSetValue('adapterFeishuAppId',fs.appId);
    _adapterSetValue('adapterFeishuAppSecret',fs.appSecret);
    _adapterSetValue('adapterFeishuEncryptKey',fs.encryptKey);
    _adapterSetValue('adapterFeishuVerificationToken',fs.verificationToken);
    _adapterSetValue('adapterFeishuStreamingCard',fs.streamingCard);
    _adapterSetValue('adapterFeishuAllowedUsers',_adapterCommaJoin(fs.allowedUsers));
    _adapterSetValue('adapterFeishuDefaultWorkDir',fs.defaultWorkDir);

    const wc=cfg.wechat||{};
    _adapterSetValue('adapterWechatEnabled',wc.enabled);
    _adapterSetValue('adapterWechatAccountId',wc.accountId);
    _adapterSetValue('adapterWechatBotToken',wc.botToken);
    _adapterSetValue('adapterWechatBaseUrl',wc.baseUrl);
    _adapterSetValue('adapterWechatUserId',wc.userId);
    _adapterSetValue('adapterWechatAllowedUsers',_adapterCommaJoin(wc.allowedUsers));
    _adapterSetValue('adapterWechatDefaultWorkDir',wc.defaultWorkDir);

    const dt=cfg.dingtalk||{};
    _adapterSetValue('adapterDingtalkEnabled',dt.enabled);
    _adapterSetValue('adapterDingtalkClientId',dt.clientId);
    _adapterSetValue('adapterDingtalkClientSecret',dt.clientSecret);
    _adapterSetValue('adapterDingtalkEndpoint',dt.endpoint);
    _adapterSetValue('adapterDingtalkAllowedUsers',_adapterCommaJoin(dt.allowedUsers));
    _adapterSetValue('adapterDingtalkDefaultWorkDir',dt.defaultWorkDir);

    const wa=cfg.whatsapp||{};
    _adapterSetValue('adapterWhatsappEnabled',wa.enabled);
    _adapterSetValue('adapterWhatsappAccountJid',wa.accountJid);
    _adapterSetValue('adapterWhatsappAuthDir',wa.authDir);
    _adapterSetValue('adapterWhatsappAllowedUsers',_adapterCommaJoin(wa.allowedUsers));
    _adapterSetValue('adapterWhatsappDefaultWorkDir',wa.defaultWorkDir);

    const we=cfg.wecom||{};
    _adapterSetValue('adapterWecomEnabled',we.enabled);
    _adapterSetValue('adapterWecomBotId',we.botId);
    _adapterSetValue('adapterWecomSecret',we.secret);
    _adapterSetValue('adapterWecomAllowedUsers',_adapterCommaJoin(we.allowedUsers));
    _adapterSetValue('adapterWecomDefaultWorkDir',we.defaultWorkDir);

    const qq=cfg.qq||{};
    _adapterSetValue('adapterQQEnabled',qq.enabled);
    _adapterSetValue('adapterQQAppId',qq.appId);
    _adapterSetValue('adapterQQAppSecret',qq.appSecret);
    _adapterSetValue('adapterQQAllowedUsers',_adapterCommaJoin(qq.allowedUsers));
    _adapterSetValue('adapterQQDefaultWorkDir',qq.defaultWorkDir);

    const code=(cfg.pairing&&cfg.pairing.code)||'';
    const codeDisplay=$('pairingCodeDisplay');
    const codeValue=$('pairingCodeValue');
    const codeExpiry=$('pairingCodeExpiry');
    if(codeDisplay){
      if(code && cfg.pairing.expiresAt && Date.now()<cfg.pairing.expiresAt){
        codeDisplay.style.display='';
        if(codeValue) codeValue.textContent=code;
        if(codeExpiry) codeExpiry.textContent=t('settings_adapters_expires_at',_adapterFormatDate(cfg.pairing.expiresAt))||'Expires '+_adapterFormatDate(cfg.pairing.expiresAt);
      }else{
        codeDisplay.style.display='none';
      }
    }

    const allUsers=[];
    ['telegram','feishu','wechat','dingtalk','whatsapp','wecom','qq'].forEach(platform=>{
      const p=cfg[platform]||{};
      (p.pairedUsers||[]).forEach(u=>{allUsers.push({...u,platform});});
    });
    _adapterRenderPairedUsers('adaptersPairedUsersList',allUsers,'all');
    _adapterRenderPairedUsers('feishuPairedList',fs.pairedUsers,'feishu');
    _adapterRenderPairedUsers('wechatPairedList',wc.pairedUsers,'wechat');
    _adapterRenderPairedUsers('dingtalkPairedList',dt.pairedUsers,'dingtalk');
    _adapterRenderPairedUsers('whatsappPairedList',wa.pairedUsers,'whatsapp');
    _adapterUpdateBindButtons();

    // wire platform tabs
    const tabsContainer=$('adaptersPlatformTabs');
    if(tabsContainer && !tabsContainer.dataset.wired){
      tabsContainer.dataset.wired='1';
      tabsContainer.querySelectorAll('.adapters-platform-tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
          const platform=tab.dataset.platform;
          tabsContainer.querySelectorAll('.adapters-platform-tab').forEach(t=>t.classList.toggle('active',t===tab));
          document.querySelectorAll('.adapters-platform-pane').forEach(pane=>{
            pane.classList.toggle('active',pane.dataset.platformPane===platform);
          });
        });
      });
    }

    const status=$('adaptersSaveStatus');
    if(status) status.textContent='';
  }catch(e){
    showToast(t('settings_adapters_load_failed')+e.message);
  }
}

async function saveAdaptersConfig(){
  const status=$('adaptersSaveStatus');
  if(status) status.textContent=t('settings_adapters_saving')||'Saving...';
  try{
    const cfg=_adapterCollectConfig();
    const res=await api('/api/adapters/config',{method:'PUT',body:JSON.stringify(cfg)});
    _adapterConfig=cfg;
    showToast(t('settings_adapters_saved')||'IM adapters saved.');
    if(status) status.textContent=t('settings_adapters_saved')||'Saved';
    await loadAdaptersPanel();
  }catch(e){
    console.error('[adapters] save failed:', e);
    showToast(t('settings_adapters_save_failed')+e.message);
    if(status) status.textContent=t('settings_adapters_save_failed')+e.message;
  }
}

async function generatePairingCode(){
  const btn=$('btnGeneratePairingCode');
  if(btn) btn.disabled=true;
  try{
    const data=await api('/api/adapters/pairing/code',{method:'POST',body:'{}'});
    showToast(t('settings_adapters_code_generated')||'Pairing code generated.');
    // 优先使用后端返回的实际配对码显示（loadAdaptersPanel 获取的是脱敏后的配置）
    if(data&&data.code){
      const codeDisplay=$('pairingCodeDisplay');
      const codeValue=$('pairingCodeValue');
      const codeExpiry=$('pairingCodeExpiry');
      if(codeDisplay) codeDisplay.style.display='';
      if(codeValue) codeValue.textContent=data.code;
      if(codeExpiry&&data.expires_at){
        codeExpiry.textContent=t('settings_adapters_expires_at',_adapterFormatDate(data.expires_at))||'Expires '+_adapterFormatDate(data.expires_at);
      }
    }
    // 刷新其他配置（已配对用户列表等），但不覆盖配对码显示
    await loadAdaptersPanel();
    // loadAdaptersPanel 会用脱敏的 ****** 覆盖配对码，需要重新设置回实际配对码
    if(data&&data.code){
      const codeDisplay=$('pairingCodeDisplay');
      const codeValue=$('pairingCodeValue');
      const codeExpiry=$('pairingCodeExpiry');
      if(codeDisplay) codeDisplay.style.display='';
      if(codeValue) codeValue.textContent=data.code;
      if(codeExpiry&&data.expires_at){
        codeExpiry.textContent=t('settings_adapters_expires_at',_adapterFormatDate(data.expires_at))||'Expires '+_adapterFormatDate(data.expires_at);
      }
    }
  }catch(e){
    showToast(t('settings_adapters_code_failed')+e.message);
  }finally{
    if(btn) btn.disabled=false;
  }
}

async function unbindPairedUser(platform,userId){
  if(!userId) return;
  try{
    await api('/api/adapters/pairing/unbind',{method:'POST',body:JSON.stringify({platform,userId})});
    showToast(t('settings_adapters_unbind_success')||'User unbound.');
    await loadAdaptersPanel();
  }catch(e){
    showToast(t('settings_adapters_unbind_failed')+e.message);
  }
}

function _adapterQrPlaceholder(platform){
  return $({feishu:'feishuQrPlaceholder',wechat:'wechatQrPlaceholder',dingtalk:'dingtalkQrPlaceholder',whatsapp:'whatsappQrPlaceholder'}[platform]);
}
function _adapterQrImage(platform){
  return $({feishu:'feishuQrImage',wechat:'wechatQrImage',dingtalk:'dingtalkQrImage',whatsapp:'whatsappQrImage'}[platform]);
}
function _adapterQrStatus(platform){
  return $({feishu:'feishuQrStatus',wechat:'wechatQrStatus',dingtalk:'dingtalkQrStatus',whatsapp:'whatsappQrStatus'}[platform]);
}
function _adapterQrToken(platform){
  return $({feishu:'feishuQrToken',wechat:'wechatQrToken',dingtalk:'dingtalkQrToken',whatsapp:'whatsappQrToken'}[platform]);
}

function _adapterSetQrStatus(platform,key,fallback,type){
  const el=_adapterQrStatus(platform);
  if(!el) return;
  el.textContent=(key?t(key):'')||fallback||'';
  el.className='adapters-qr-status'+(type?(' '+type):'');
}

function _adapterSetQrToken(platform,token){
  const el=_adapterQrToken(platform);
  if(!el) return;
  el.textContent=token||'';
  el.style.display=token?'':'none';
}

function _adapterStopQrPolling(platform){
  const s=_adapterQrSessions[platform];
  if(!s) return;
  if(s.timer){ clearInterval(s.timer); s.timer=null; }
  delete _adapterQrSessions[platform];
}

async function _adapterPollQrStatus(platform){
  const s=_adapterQrSessions[platform];
  if(!s||!s.token) return;
  try{
    const data=await api('/api/adapters/'+platform+'/qr/status?token='+encodeURIComponent(s.token));
    if(data.status==='bound'){
      _adapterStopQrPolling(platform);
      _adapterSetQrStatus(platform,'settings_adapters_bind_success','Account bound.','success');
      const img=_adapterQrImage(platform);
      if(img) img.style.display='none';
      _adapterSetQrToken(platform,'');
      showToast(t('settings_adapters_bind_success')||'Account bound.');
      await loadAdaptersPanel();
    }else if(data.status==='expired'){
      _adapterStopQrPolling(platform);
      _adapterSetQrStatus(platform,'settings_adapters_qr_expired','QR code expired.','error');
    }else{
      _adapterSetQrStatus(platform,'settings_adapters_qr_waiting','Waiting for scan...','waiting');
    }
  }catch(e){
    _adapterSetQrStatus(platform,'settings_adapters_qr_failed','QR status check failed: '+e.message,'error');
  }
}

async function bindPlatformAccount(platform){
  // 钉钉使用官方注册流程（Registration API），扫码后自动获取 clientId/clientSecret
  if(platform==='dingtalk'){
    return _dingtalkRegistrationBind();
  }
  _adapterStopQrPolling(platform);
  const placeholder=_adapterQrPlaceholder(platform);
  const image=_adapterQrImage(platform);
  if(placeholder) placeholder.style.display='';
  if(image){ image.style.display=''; image.src=''; }
  _adapterSetQrToken(platform,'');
  _adapterSetQrStatus(platform,'settings_adapters_qr_loading','Creating QR bind session...','loading');
  try{
    // 使用项目已有的"扫码即绑定"流程（/api/adapters/:platform/qr）
    // 用户扫码后打开 /bind 页面，点击确认绑定即可完成，不需要适配器运行
    const data=await api('/api/adapters/'+platform+'/qr',{method:'POST',body:'{}'});
    const token=data.token||'';
    if(!token){
      _adapterSetQrStatus(platform,'settings_adapters_qr_failed','Failed to create QR bind session.','error');
      return;
    }
    const platformNames={feishu:'飞书',wechat:'微信',dingtalk:'钉钉',whatsapp:'WhatsApp',telegram:'Telegram'};
    const name=platformNames[platform]||platform;
    // 构建扫码绑定 URL（用户扫码后打开此页面完成绑定）
    const buildBindUrl=function(base){
      return base+'/bind?platform='+encodeURIComponent(platform)+'&token='+encodeURIComponent(token);
    };
    // 先用当前地址生成二维码和显示绑定地址
    const bindUrl=buildBindUrl(window.location.origin);
    if(image){
      image.src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data='+encodeURIComponent(bindUrl);
      image.onerror=function(){
        try{
          if(typeof QRCode!=='undefined'&&QRCode.toDataURL){
            image.src=QRCode.toDataURL(bindUrl,200);
          }
        }catch(qrErr){
          console.warn('QR generation failed:',qrErr);
        }
      };
    }
    // 显示二维码解析的绑定地址
    _adapterSetQrToken(platform,'绑定地址: '+bindUrl);
    // 异步获取局域网地址并更新二维码和地址（方便手机访问）
    _getLocalIPViaWebRTC().then(function(lanIP){
      if(!lanIP) return;
      const port=window.location.port;
      const protocol=window.location.protocol;
      const lanBase=protocol+'//'+lanIP+(port?(':'+port):'');
      const lanBindUrl=buildBindUrl(lanBase);
      if(image){
        image.src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data='+encodeURIComponent(lanBindUrl);
      }
      _adapterSetQrToken(platform,'绑定地址: '+lanBindUrl);
    }).catch(function(){});
    _adapterSetQrStatus(platform,'settings_adapters_qr_waiting','扫码后点击"确认绑定"完成'+name+'账号绑定','waiting');
    // 启动轮询，检查绑定状态（用户在 /bind 页面点击确认后，状态变为 bound）
    _adapterQrSessions[platform]={token:token,timer:null,expiresAt:data.expires_at||0};
    const s=_adapterQrSessions[platform];
    s.timer=setInterval(function(){ _adapterPollQrStatus(platform); },2000);
    // 设置过期定时器
    if(data.expires_at){
      const ttl=data.expires_at-Date.now();
      if(ttl>0){
        setTimeout(function(){
          if(_adapterQrSessions[platform]&&_adapterQrSessions[platform].token===token){
            _adapterStopQrPolling(platform);
            _adapterSetQrStatus(platform,'settings_adapters_qr_expired','QR code expired.','error');
          }
        },ttl);
      }
    }
  }catch(e){
    _adapterSetQrStatus(platform,'settings_adapters_qr_failed','Failed to create QR bind session: '+e.message,'error');
  }
}

// ── 钉钉扫码注册流程──
// 与通用"扫码绑定"不同：此流程调用钉钉官方 Registration API，
// 用户用钉钉扫码确认后，后端自动获取 clientId/clientSecret 并保存到适配器配置、重启适配器。
var _dingtalkRegistrationSession=null;

function _dingtalkRegistrationStopPolling(){
  if(_dingtalkRegistrationSession&&_dingtalkRegistrationSession.timer){
    clearInterval(_dingtalkRegistrationSession.timer);
    _dingtalkRegistrationSession.timer=null;
  }
  _dingtalkRegistrationSession=null;
}

async function _dingtalkRegistrationBind(){
  _dingtalkRegistrationStopPolling();
  const platform='dingtalk';
  const placeholder=_adapterQrPlaceholder(platform);
  const image=_adapterQrImage(platform);
  if(placeholder) placeholder.style.display='';
  if(image){ image.style.display=''; image.src=''; }
  _adapterSetQrToken(platform,'');
  _adapterSetQrStatus(platform,'settings_adapters_qr_loading','正在创建钉钉扫码注册会话...','loading');
  try{
    const data=await api('/api/adapters/dingtalk/registration/begin',{method:'POST',body:'{}'});
    const deviceCode=data.deviceCode||'';
    const verificationUriComplete=data.verificationUriComplete||'';
    if(!deviceCode||!verificationUriComplete){
      _adapterSetQrStatus(platform,'settings_adapters_qr_failed','钉钉注册会话创建失败：缺少 deviceCode 或 verificationUriComplete','error');
      return;
    }
    // 显示钉钉官方扫码链接的二维码
    if(image){
      image.src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data='+encodeURIComponent(verificationUriComplete);
      image.onerror=function(){
        try{
          if(typeof QRCode!=='undefined'&&QRCode.toDataURL){
            image.src=QRCode.toDataURL(verificationUriComplete,200);
          }
        }catch(qrErr){
          console.warn('QR generation failed:',qrErr);
        }
      };
    }
    _adapterSetQrToken(platform,'钉钉扫码链接: '+verificationUriComplete);
    _adapterSetQrStatus(platform,'settings_adapters_qr_waiting','请使用钉钉扫描二维码完成授权','waiting');
    // 启动轮询
    const intervalSeconds=data.intervalSeconds||3;
    const intervalMs=Math.max(2000,intervalSeconds*1000);
    _dingtalkRegistrationSession={deviceCode:deviceCode,timer:null,expiresAt:Date.now()+(data.expiresInSeconds||7200)*1000};
    const s=_dingtalkRegistrationSession;
    s.timer=setInterval(function(){ _dingtalkRegistrationPoll(); },intervalMs);
    // 设置过期定时器
    const ttl=s.expiresAt-Date.now();
    if(ttl>0){
      setTimeout(function(){
        if(_dingtalkRegistrationSession&&_dingtalkRegistrationSession.deviceCode===deviceCode){
          _dingtalkRegistrationStopPolling();
          _adapterSetQrStatus(platform,'settings_adapters_qr_expired','钉钉扫码已过期，请重新绑定。','error');
        }
      },ttl);
    }
  }catch(e){
    _adapterSetQrStatus(platform,'settings_adapters_qr_failed','钉钉注册会话创建失败: '+e.message,'error');
  }
}

async function _dingtalkRegistrationPoll(){
  const s=_dingtalkRegistrationSession;
  if(!s||!s.deviceCode) return;
  const platform='dingtalk';
  try{
    const data=await api('/api/adapters/dingtalk/registration/poll',{method:'POST',body:JSON.stringify({deviceCode:s.deviceCode})});
    const status=(data.status||'').toUpperCase();
    if(status==='SUCCESS'){
      _dingtalkRegistrationStopPolling();
      _adapterSetQrStatus(platform,'settings_adapters_bind_success','钉钉账号绑定成功！','success');
      const img=_adapterQrImage(platform);
      if(img) img.style.display='none';
      _adapterSetQrToken(platform,'');
      showToast(t('settings_adapters_bind_success')||'钉钉账号绑定成功。');
      await loadAdaptersPanel();
    }else if(status==='FAIL'||status==='FAILED'){
      _dingtalkRegistrationStopPolling();
      _adapterSetQrStatus(platform,'settings_adapters_qr_failed','钉钉授权失败: '+(data.failReason||'未知原因'),'error');
    }else{
      _adapterSetQrStatus(platform,'settings_adapters_qr_waiting','请使用钉钉扫描二维码完成授权','waiting');
    }
  }catch(e){
    _adapterSetQrStatus(platform,'settings_adapters_qr_failed','钉钉注册状态查询失败: '+e.message,'error');
  }
}

// ── 微信 iLink QR 扫码登录──────────────
// 与通用"扫码绑定"不同：此流程直接调用微信 iLink 接口获取官方二维码，
// 用户用微信扫码确认后，后端自动获取 botToken/accountId/baseUrl/userId
// 并保存到适配器配置、重启适配器，无需手动填写凭证。
function _wechatQrLoginStopPolling(){
  if(_wechatQrLoginSession&&_wechatQrLoginSession.timer){
    clearInterval(_wechatQrLoginSession.timer);
    _wechatQrLoginSession.timer=null;
  }
  _wechatQrLoginSession=null;
}

function _wechatQrLoginSetStatus(text,type){
  const el=$('wechatQrStatus');
  if(!el) return;
  el.textContent=text||'';
  el.className='adapters-qr-status'+(type?(' '+type):'');
}

function _wechatQrLoginSetToken(text){
  const el=$('wechatQrToken');
  if(!el) return;
  el.textContent=text||'';
  el.style.display=text?'':'none';
}

async function _wechatQrLoginPoll(){
  if(!_wechatQrLoginSession||!_wechatQrLoginSession.sessionKey) return;
  // 保存当前 sessionKey，用于在异步请求返回后验证会话是否仍然有效
  const sessionKey=_wechatQrLoginSession.sessionKey;
  try{
    const data=await api('/api/adapters/wechat/qr-login/status?sessionKey='+encodeURIComponent(sessionKey));
    // 请求返回后再次检查会话是否仍然有效（可能在等待响应期间被停止或已完成）
    if(!_wechatQrLoginSession||_wechatQrLoginSession.sessionKey!==sessionKey) return;
    const status=data.status||'wait';
    if(status==='confirmed'){
      _wechatQrLoginStopPolling();
      // 检查后端是否返回了完整凭证
      if(data.message&&!data.botToken){
        _wechatQrLoginSetStatus(data.message,'error');
        return;
      }
      _wechatQrLoginSetStatus('微信绑定成功，已自动保存凭证并启用适配器。','success');
      _wechatQrLoginSetToken('');
      const img=$('wechatQrImage');
      if(img) img.style.display='none';
      showToast('微信绑定成功');
      // 刷新配置显示（后端已自动保存并重启适配器）
      await loadAdaptersPanel();
      // 刷新后再次确保状态文字显示为成功（loadAdaptersPanel 不会重置二维码状态，但为保险起见）
      _wechatQrLoginSetStatus('微信绑定成功，已自动保存凭证并启用适配器。','success');
    }else if(status==='expired'){
      _wechatQrLoginStopPolling();
      _wechatQrLoginSetStatus('二维码已过期，请重新扫码绑定。','error');
    }else if(status==='scaned'){
      _wechatQrLoginSetStatus('已扫码，请在微信中点击确认绑定。','waiting');
    }else if(status==='scaned_but_redirect'){
      _wechatQrLoginSetStatus('正在切换网关，请稍候...','waiting');
    }else{
      _wechatQrLoginSetStatus('请使用微信扫码并确认绑定','waiting');
    }
  }catch(e){
    if(_wechatQrLoginSession&&_wechatQrLoginSession.sessionKey===sessionKey){
      _wechatQrLoginSetStatus('扫码状态检查失败：'+e.message,'error');
    }
  }
}

async function wechatQrLogin(){
  // 停止可能存在的轮询
  _wechatQrLoginStopPolling();
  _adapterStopQrPolling('wechat');
  const placeholder=$('wechatQrPlaceholder');
  const image=$('wechatQrImage');
  if(placeholder) placeholder.style.display='';
  if(image){ image.style.display=''; image.src=''; }
  _wechatQrLoginSetToken('');
  _wechatQrLoginSetStatus('正在获取微信绑定二维码...','loading');
  try{
    const data=await api('/api/adapters/wechat/qr-login',{method:'POST',body:'{}'});
    const sessionKey=data.sessionKey||'';
    const qrcodeUrl=data.qrcodeUrl||'';
    if(!sessionKey||!qrcodeUrl){
      _wechatQrLoginSetStatus('获取微信绑定二维码失败。','error');
      return;
    }
    // 显示微信官方二维码（优先使用本地 QRCode 库生成，避免外部 API 网络问题）
    if(image){
      try{
        if(typeof QRCode!=='undefined'&&QRCode.toDataURL){
          image.src=QRCode.toDataURL(qrcodeUrl,400);
        }else{
          image.src='https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data='+encodeURIComponent(qrcodeUrl);
        }
      }catch(qrErr){
        image.src='https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data='+encodeURIComponent(qrcodeUrl);
      }
      image.onerror=function(){
        _wechatQrLoginSetStatus('二维码加载失败，请重试。','error');
      };
    }
    _wechatQrLoginSetStatus('请使用微信扫码并确认绑定','waiting');
    // 启动轮询（每 2 秒检查扫码状态）
    _wechatQrLoginSession={sessionKey:sessionKey,timer:null,expiresAt:Date.now()+5*60*1000};
    _wechatQrLoginSession.timer=setInterval(function(){ _wechatQrLoginPoll(); },2000);
    // 设置 5 分钟过期定时器
    setTimeout(function(){
      if(_wechatQrLoginSession&&_wechatQrLoginSession.sessionKey===sessionKey){
        _wechatQrLoginStopPolling();
        _wechatQrLoginSetStatus('二维码已过期，请重新扫码绑定。','error');
      }
    },5*60*1000);
  }catch(e){
    _wechatQrLoginSetStatus('获取微信绑定二维码失败：'+e.message,'error');
  }
}

function cancelWechatQrLogin(){
  _wechatQrLoginStopPolling();
  const placeholder=$('wechatQrPlaceholder');
  const image=$('wechatQrImage');
  if(placeholder) placeholder.style.display='none';
  if(image){ image.src=''; image.style.display=''; }
  _wechatQrLoginSetToken('');
  _wechatQrLoginSetStatus('','');
}

// ===== WhatsApp 扫码登录=====
let _whatsappQrLoginSession=null; // {timer,expiresAt}

function _whatsappQrLoginStopPolling(){
  if(_whatsappQrLoginSession&&_whatsappQrLoginSession.timer){
    clearInterval(_whatsappQrLoginSession.timer);
    _whatsappQrLoginSession.timer=null;
  }
  _whatsappQrLoginSession=null;
}

function _whatsappQrLoginSetStatus(text,type){
  const el=$('whatsappQrStatus');
  if(!el) return;
  el.textContent=text||'';
  el.className='adapters-qr-status'+(type?(' '+type):'');
}

async function _whatsappQrLoginPoll(){
  try{
    const data=await api('/api/adapters/whatsapp/qr-login/status');
    const status=data.status||'pending';
    if(status==='success'){
      _whatsappQrLoginStopPolling();
      _whatsappQrLoginSetStatus('WhatsApp 绑定成功，已自动保存凭证并启用适配器。','success');
      const img=$('whatsappQrImage');
      if(img) img.style.display='none';
      showToast('WhatsApp 绑定成功');
      await loadAdaptersPanel();
      _whatsappQrLoginSetStatus('WhatsApp 绑定成功，已自动保存凭证并启用适配器。','success');
    }else if(status==='error'){
      _whatsappQrLoginStopPolling();
      _whatsappQrLoginSetStatus('WhatsApp 连接失败，请重试。','error');
    }else if(status==='pending'&&data.qrcode){
      // 显示 QR 码
      const image=$('whatsappQrImage');
      if(image&&image.dataset.qrcode!==data.qrcode){
        image.dataset.qrcode=data.qrcode;
        try{
          if(typeof QRCode!=='undefined'&&QRCode.toDataURL){
            image.src=QRCode.toDataURL(data.qrcode,400);
          }else{
            image.src='https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data='+encodeURIComponent(data.qrcode);
          }
        }catch(qrErr){
          image.src='https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data='+encodeURIComponent(data.qrcode);
        }
      }
      _whatsappQrLoginSetStatus('请使用 WhatsApp 扫码登录','waiting');
    }else{
      _whatsappQrLoginSetStatus('正在等待 WhatsApp 生成二维码...','loading');
    }
  }catch(e){
    _whatsappQrLoginSetStatus('扫码状态检查失败：'+e.message,'error');
  }
}

async function whatsappQrLogin(){
  _whatsappQrLoginStopPolling();
  _adapterStopQrPolling('whatsapp');
  const placeholder=$('whatsappQrPlaceholder');
  const image=$('whatsappQrImage');
  if(placeholder) placeholder.style.display='';
  if(image){ image.style.display=''; image.src=''; image.dataset.qrcode=''; }
  _whatsappQrLoginSetStatus('正在启动 WhatsApp 客户端...','loading');
  try{
    await api('/api/adapters/whatsapp/qr-login',{method:'POST',body:'{}'});
    _whatsappQrLoginSetStatus('正在等待 WhatsApp 生成二维码...','loading');
    // 启动轮询（每 2 秒检查扫码状态）
    _whatsappQrLoginSession={timer:null,expiresAt:Date.now()+5*60*1000};
    _whatsappQrLoginSession.timer=setInterval(function(){ _whatsappQrLoginPoll(); },2000);
    // 设置 5 分钟过期定时器
    setTimeout(function(){
      if(_whatsappQrLoginSession){
        _whatsappQrLoginStopPolling();
        _whatsappQrLoginSetStatus('二维码已过期，请重新扫码登录。','error');
      }
    },5*60*1000);
  }catch(e){
    _whatsappQrLoginSetStatus('启动 WhatsApp 登录失败：'+e.message,'error');
  }
}

function cancelWhatsappQrLogin(){
  _whatsappQrLoginStopPolling();
  const placeholder=$('whatsappQrPlaceholder');
  const image=$('whatsappQrImage');
  if(placeholder) placeholder.style.display='none';
  if(image){ image.src=''; image.style.display=''; image.dataset.qrcode=''; }
  _whatsappQrLoginSetStatus('','');
}

// 同时取消微信扫码登录和通用扫码绑定两种流程
function cancelWechatQrBind(){
  _wechatQrLoginStopPolling();
  cancelPlatformBind('wechat');
}

// 通过WebRTC获取局域网IP（用于生成手机可访问的二维码URL）
function _getLocalIPViaWebRTC(){
  return new Promise((resolve,reject)=>{
    try{
      const pc=new RTCPeerConnection({iceServers:[]});
      pc.createDataChannel('');
      let resolved=false;
      const collectedIPs=[];
      pc.onicecandidate=function(e){
        if(!e.candidate){
          if(!resolved){
            resolved=true;
            // 从收集的IP中选择最合适的
            const bestIP=_selectBestLanIP(collectedIPs);
            resolve(bestIP);
          }
          return;
        }
        const ipMatch=/([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if(ipMatch&&ipMatch[1]!=='0.0.0.0'&&ipMatch[1].indexOf('127.')!==0){
          collectedIPs.push(ipMatch[1]);
        }
      };
      pc.createOffer().then(function(offer){
        return pc.setLocalDescription(offer);
      }).catch(function(err){
        if(!resolved){ resolved=true; reject(err); }
      });
      // 超时处理
      setTimeout(function(){
        if(!resolved){
          resolved=true;
          const bestIP=_selectBestLanIP(collectedIPs);
          resolve(bestIP);
        }
      },2000);
    }catch(err){
      reject(err);
    }
  });
}

// 从收集的IP列表中选择最合适的局域网IP
// 优先级: 192.168.x.x > 10.x.x.x > 172.16-31.x.x > 其他
function _selectBestLanIP(ips){
  if(!ips||ips.length===0) return null;
  // 去重
  const uniqueIPs=[...new Set(ips)];
  // 优先选择192.168.x.x
  for(const ip of uniqueIPs){
    if(ip.indexOf('192.168.')===0) return ip;
  }
  // 其次选择10.x.x.x
  for(const ip of uniqueIPs){
    if(ip.indexOf('10.')===0) return ip;
  }
  // 最后选择172.16-31.x.x（排除172.20.x.x等WSL/Docker虚拟网卡）
  for(const ip of uniqueIPs){
    const parts=ip.split('.');
    if(parts[0]==='172'){
      const second=parseInt(parts[1],10);
      if(second>=16&&second<=31){
        return ip;
      }
    }
  }
  // 如果都没有，返回第一个非127.x.x.x的IP
  return uniqueIPs[0]||null;
}

function cancelPlatformBind(platform){
  _adapterStopQrPolling(platform);
  const placeholder=_adapterQrPlaceholder(platform);
  const image=_adapterQrImage(platform);
  if(placeholder) placeholder.style.display='none';
  if(image){ image.src=''; image.style.display=''; }
  _adapterSetQrToken(platform,'');
  _adapterSetQrStatus(platform,'','','');
}

async function simulatePlatformScan(platform){
  // 配对码机制下，模拟扫码改为显示配对码和使用说明
  const s=_adapterQrSessions[platform];
  if(!s||!s.token){
    showToast(t('settings_adapters_qr_failed')||'No active pairing code.');
    return;
  }
  const platformNames={feishu:'飞书',wechat:'微信',dingtalk:'钉钉',whatsapp:'WhatsApp',telegram:'Telegram'};
  const name=platformNames[platform]||platform;
  const msg='配对码: '+s.token+'\n\n使用方法:\n1. 在'+name+'中找到机器人\n2. 向机器人发送此配对码\n3. 配对成功后即可与 AI 对话';
  alert(msg);
}

async function unbindPlatformAccount(platform){
  const platformNames={feishu:'飞书',wechat:'微信',dingtalk:'钉钉',whatsapp:'WhatsApp'};
  const name=platformNames[platform]||platform;
  const msg=t('settings_adapters_unbind_confirm')||'确定要解绑'+name+'账号吗？解绑后需要重新绑定才能使用。';
  if(!confirm(msg)) return;
  try{
    await api('/api/adapters/'+platform+'/unbind',{method:'POST',body:'{}'});
    showToast(t('settings_adapters_unbind_success')||'Account unbound.');
    await loadAdaptersPanel();
  }catch(e){
    showToast(t('settings_adapters_unbind_failed')+e.message);
  }
}

async function browseAdapterProjectDir(){
  const input=$('adapterDefaultProjectDir');
  if(!input) return;
  if(window.showDirectoryPicker){
    try{
      const dirHandle=await window.showDirectoryPicker();
      input.value=dirHandle.name;
    }catch(e){
      if(e.name!=='AbortError'){
        showToast(t('settings_adapters_browse_failed')+e.message);
      }
    }
  }else{
    const path=prompt(t('settings_adapters_browse_prompt')||'Enter the default project directory path:');
    if(path!=null) input.value=path;
  }
}

function _buildPluginCard(plugin){
  const card=document.createElement('div');
  card.className='provider-card plugin-card';
  card.dataset.plugin=(plugin&&plugin.key)||'';
  // `activation` is the canonical state from /api/plugins (added in #2659).
  // Fall back to the older `enabled` boolean when the field is missing so
  // the panel still works against older backends.
  const activation=(plugin&&typeof plugin.activation==='string')
    ? plugin.activation
    : (plugin&&plugin.enabled===false ? 'disabled' : 'enabled');
  const isProvider=activation==='exclusive'||activation==='provider';
  const hooks=Array.isArray(plugin&&plugin.hooks)?plugin.hooks:[];
  // Provider plugins (memory/web/browser/etc.) register hooks on their
  // category's dispatcher, not the four agent-wide visibility hooks the
  // payload filters to. Show an explanatory line instead of the generic
  // "No registered lifecycle hooks" when the visibility-hook list is empty.
  const hookHtml=hooks.length
    ? hooks.map(h=>`<span class="plugin-hook-badge">${esc(h)}</span>`).join('')
    : '<span class="plugin-hook-empty">'+t(isProvider?'plugins_provider_no_hooks':'plugins_no_hooks')+'</span>';
  const version=(plugin&&plugin.version)?' · v'+esc(plugin.version):'';
  const desc=(plugin&&plugin.description)?esc(plugin.description):t('plugins_no_description');
const enabled=plugin&&plugin.enabled!==false;
  const tab=plugin&&plugin.tab;
  const isDashboardPlugin=!!(tab&&tab.path);
  // No inline onclick/onchange: an inline handler interpolates tab.path/key into
  // a JS-string-in-attribute context where HTML-escaping is insufficient (a
  // crafted value could break out). Render inert markup + bind listeners below
  // with the raw closure values.
  const openBtn=enabled&&tab&&tab.path
    ? `<a href="${esc(tab.path)}" class="plugin-open-btn">${esc(tab.label||plugin.name||'Open')} \u2197</a>`
    : '';
  const toggleHtml=enabled&&isDashboardPlugin
    ? `<div class="plugin-card-footer-row">
         <span class="plugin-toggle-label">${t('plugins_enable_toggle')||'Enabled'}</span>
         <label class="plugin-toggle-switch">
           <input type="checkbox" class="plugin-enable-toggle" checked>
           <span class="plugin-toggle-slider"></span>
         </label>
       </div>`
    : (isDashboardPlugin
    ? `<div class="plugin-card-footer-row">
         <span class="plugin-toggle-label">${t('plugins_enable_toggle')||'Enable'}</span>
         <label class="plugin-toggle-switch">
           <input type="checkbox" class="plugin-enable-toggle">
           <span class="plugin-toggle-slider"></span>
         </label>
       </div>`
    : '');
  let badgeText;
  let badgeClass;
  if(isProvider){
    badgeText=t('plugins_active_provider');
    badgeClass='plugin-card-badge-provider';
  }else if(activation==='enabled'){
    badgeText=t('plugins_enabled');
    badgeClass='';
  }else{
    badgeText=t('plugins_disabled');
    badgeClass='plugin-card-badge-disabled';
  }
  card.innerHTML=`
    <div class="provider-card-header plugin-card-header">
      <div class="provider-card-info">
        <div class="provider-card-name">${esc((plugin&&plugin.name)||t('plugins_unnamed'))}</div>
        <div class="provider-card-meta">${esc((plugin&&plugin.key)||'plugin')}${version}</div>
      </div>
      <span class="provider-card-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="provider-card-body plugin-card-body">
      <div class="provider-card-hint">${desc}</div>
      <div class="provider-card-label">${t('plugins_registered_hooks')}</div>
      <div class="plugin-hook-list">${hookHtml}</div>
      ${openBtn ? `<div class="plugin-card-footer">${openBtn}</div>` : ''}
      ${toggleHtml}
    </div>
  `;
  // Bind handlers with the RAW closure values (not interpolated into inline JS),
  // so a hostile tab.path/key can't break out of a JS-string attribute context.
  if(tab&&tab.path){
    const _openEl=card.querySelector('.plugin-open-btn');
    if(_openEl){
      const _p=tab.path, _l=tab.label||plugin.name;
      _openEl.addEventListener('click', function(ev){ switchPluginPage(ev, _p, _l); });
    }
  }
  if(isDashboardPlugin){
    const _tog=card.querySelector('.plugin-enable-toggle');
    if(_tog){
      const _k=plugin.key;
      _tog.addEventListener('change', function(){ handlePluginEnableToggle(_k, this.checked); });
    }
  }
  return card;
}

// ── Plugin pages ─────────────────────────────────────────────────────────────

let _currentPluginPage = null;

async function switchPluginPage(event, path, label) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!_currentPluginPage || _currentPluginPage.path !== path) {
    await _loadPluginPage(path, label);
  }
  // Update _currentPanel so clicking sidebar items won't short-circuit,
  // but keep the sidebar panel views intact (no panelPlugin exists).
  _currentPanel = 'plugin';
  const mainEl = document.querySelector('main.main');
  if (mainEl) {
    ['settings','skills','memory','tasks','kanban','workspaces','profiles','insights','logs','plugin'].forEach(p => {
      mainEl.classList.toggle('showing-' + p, p === 'plugin');
    });
  }
}

async function _loadPluginPage(path, label) {
  const container = $('pluginPageContainer');
  const titleEl = $('pluginPageTitle');
  if (!container) return;
  if (titleEl) titleEl.textContent = label || path;
  container.innerHTML = '';

  // Use an iframe for full isolation (styles, scripts, modals stay sandboxed).
  // Security note: plugins are locally-installed (~/.hermes/plugins/), similar
  // trust model to VS Code extensions — only install plugins you trust.
  const iframe = document.createElement('iframe');
  iframe.src = path;
  iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
  iframe.setAttribute('title', label || 'Plugin');
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  container.appendChild(iframe);
  _currentPluginPage = { path, label };
}

// ── Providers panel ─────────────────────────────────────────────────────────

const _providerCardEls = new Map(); // providerId → {card, statusDot, input, saveBtn, removeBtn}

async function _fetchProviderQuotaStatus(force=false){
  const endpoint=force?`/api/providers/quota?refresh=1&ts=${Date.now()}`:'/api/providers/quota';
  const status=await api(endpoint,{cache:'no-store'});
  if(status&&typeof status==='object') status.client_fetched_at=new Date().toISOString();
  return status;
}

async function loadProvidersPanel(){
  const list=$('providersList');
  const empty=$('providersEmpty');
  if(!list) return;
  try{
    const data=await api('/api/providers');
    const quota=await _fetchProviderQuotaStatus(false).catch(e=>({ok:false,status:'unavailable',quota:null,message:e.message||t('provider_quota_unavailable'),client_fetched_at:new Date().toISOString()}));
    const providers=(data.providers||[]).filter(p=>p.configurable||p.is_oauth||p.is_custom||p.is_plugin_provider);
    list.innerHTML='';
    _providerCardEls.clear();
    const quotaCard=_buildProviderQuotaCard(quota);
    if(quotaCard){
      list.appendChild(quotaCard);
      renderProviderCostChart(quotaCard); // async, fire-and-forget
    }
    if(providers.length===0){
      list.style.display='none';
      if(empty) empty.style.display='';
      return;
    }
    if(empty) empty.style.display='none';
    list.style.display='';
    for(const p of providers){
      list.appendChild(_buildProviderCard(p));
    }
  }catch(e){
    list.innerHTML='<div style="color:var(--error);padding:12px;font-size:13px">'+esc(t('providers_load_failed'))+' '+esc(e.message||String(e))+'</div>';
  }
}

async function _refreshProviderQuota(card,button){
  if(!card) return;
  if(button){
    button.disabled=true;
    button.textContent=t('provider_quota_refreshing');
    button.setAttribute('aria-busy','true');
  }
  let failed=false;
  let next;
  try{
    next=await _fetchProviderQuotaStatus(true);
    failed=next&&next.ok===false;
  }catch(e){
    failed=true;
    next={ok:false,status:'unavailable',quota:null,message:e.message||t('provider_quota_unavailable'),client_fetched_at:new Date().toISOString()};
  }
  try{
    const fresh=_buildProviderQuotaCard(next);
    if(fresh){
      card.replaceWith(fresh);
      // Re-render the 7-day spend chart onto the rebuilt card — the quota
      // refresh replaces the whole card, which would otherwise drop the chart
      // until the next full panel reload (#3600).
      renderProviderCostChart(fresh); // async, fire-and-forget
      if(typeof showToast==='function') showToast(failed?t('provider_quota_refresh_failed'):t('provider_quota_refresh_succeeded'));
      return;
    }
  }catch(e){
    failed=true;
  }
  if(card.isConnected&&button){
    button.disabled=false;
    button.textContent=t('provider_quota_refresh_usage');
    button.removeAttribute('aria-busy');
  }
  if(typeof showToast==='function') showToast(t('provider_quota_refresh_failed'));
}

function _formatProviderQuotaMoney(value){
  if(value===null||value===undefined||value==='') return '—';
  const n=Number(value);
  if(!Number.isFinite(n)) return '—';
  return '$'+n.toFixed(2);
}

function _formatProviderQuotaPercent(value){
  if(value===null||value===undefined||value==='') return '—';
  const n=Number(value);
  if(!Number.isFinite(n)) return '—';
  return Math.max(0,Math.min(100,Math.round(n)))+'%';
}

function _formatProviderQuotaReset(value){
  if(!value) return '';
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return '';
  try{return d.toLocaleString();}catch(e){return value;}
}

function _formatProviderQuotaWindowLabel(accountLimits,w){
  const raw=((w&&w.label)||t('provider_quota_window_fallback')).trim();
  const provider=((accountLimits&&accountLimits.provider)||'').toLowerCase();
  if(provider==='openai-codex'){
    if(raw.toLowerCase()==='session') return t('provider_quota_session_limit');
    if(raw.toLowerCase()==='weekly') return t('provider_quota_weekly_limit');
  }
  return raw||t('provider_quota_window_fallback');
}

function _formatProviderQuotaLastChecked(status){
  const accountLimits=status&&status.account_limits;
  const value=(accountLimits&&accountLimits.fetched_at)||status&&status.client_fetched_at;
  if(!value) return t('provider_quota_last_checked_after_refresh');
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return t('provider_quota_last_checked_after_refresh');
  try{return t('provider_quota_last_checked',d.toLocaleString());}catch(e){return t('provider_quota_last_checked',value);}
}

function _providerQuotaStateClass(value){
  return String(value||'unavailable').replace(/[^a-z0-9_-]/gi,'').toLowerCase()||'unavailable';
}

function _providerQuotaStatusLabel(value){
  const state=_providerQuotaStateClass(value);
  const key={
    available:'provider_quota_status_available',
    exhausted:'provider_quota_status_exhausted',
    unavailable:'provider_quota_status_unavailable',
    failed:'provider_quota_status_failed',
    checked:'provider_quota_status_checked',
    no_key:'provider_quota_status_no_key',
    invalid_key:'provider_quota_status_invalid_key',
    unsupported:'provider_quota_status_unsupported',
    no_quota_details:'provider_quota_status_no_quota_details',
  }[state];
  return key?t(key):state.replace(/_/g,' ');
}

function _providerQuotaWindowMeta(used,reset){
  const meta=[];
  if(used!=='—') meta.push(t('provider_quota_used_meta',used));
  if(reset) meta.push(t('provider_quota_resets_meta',reset));
  return meta;
}

function _providerQuotaRetryAfterText(value){
  const retry=_formatProviderQuotaReset(value);
  return retry?t('provider_quota_retry_after',retry):'';
}

function _providerQuotaUnavailableReason(credential){
  const structured=_providerQuotaRetryAfterText(credential&&credential.retry_after);
  if(structured) return structured;
  const raw=String((credential&&credential.unavailable_reason)||'').trim();
  const match=raw.match(/\bretry after\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)/i);
  if(match){
    const parsed=_providerQuotaRetryAfterText(match[1]);
    if(parsed) return parsed;
  }
  return raw;
}

function _providerQuotaPoolShouldDefaultOpen(pool){
  try{
    const saved=localStorage.getItem('hermes-provider-quota-pool-open');
    if(saved==='1') return true;
    if(saved==='0') return false;
  }catch(e){}
  const count=Array.isArray(pool&&pool.credentials)?pool.credentials.length:0;
  return count>0&&count<=3;
}

function _buildProviderQuotaPoolBreakdown(accountLimits){
  const pool=accountLimits&&accountLimits.pool;
  if(!pool||!Array.isArray(pool.credentials)||pool.credentials.length===0) return '';
  const defaultOpen=_providerQuotaPoolShouldDefaultOpen(pool);
  const total=Number.isFinite(Number(pool.total_credentials))?Number(pool.total_credentials):pool.credentials.length;
  const available=Number.isFinite(Number(pool.available_credentials))?Number(pool.available_credentials):pool.credentials.filter(c=>c&&c.status==='available').length;
  const exhausted=Number.isFinite(Number(pool.exhausted_credentials))?Number(pool.exhausted_credentials):0;
  const failed=Number.isFinite(Number(pool.failed_credentials))?Number(pool.failed_credentials):0;
  const queried=Number.isFinite(Number(pool.queried_credentials))?Number(pool.queried_credentials):0;
  const summaryParts=[t('provider_quota_pool_summary_available',available,total)];
  if(exhausted>0) summaryParts.push(t('provider_quota_pool_summary_exhausted',exhausted));
  if(failed>0) summaryParts.push(t('provider_quota_pool_summary_failed',failed));
  if(queried>0) summaryParts.push(t('provider_quota_pool_summary_checked',queried));
  const planParts=Array.isArray(pool.plans)?pool.plans.filter(Boolean):[];
  const rows=pool.credentials.map((credential,idx)=>{
    const label=(credential&&credential.label)||t('provider_quota_credential_label',idx+1);
    const status=_providerQuotaStateClass(credential&&credential.status);
    const statusText=_providerQuotaStatusLabel(credential&&credential.status);
    const plan=credential&&credential.plan?` · ${credential.plan}`:'';
    const windows=Array.isArray(credential&&credential.windows)?credential.windows:[];
    const details=Array.isArray(credential&&credential.details)?credential.details.filter(Boolean):[];
    const unavailableReason=_providerQuotaUnavailableReason(credential);
    const windowHtml=windows.length?windows.map(w=>{
      const remaining=_formatProviderQuotaPercent(w&&w.remaining_percent);
      const used=_formatProviderQuotaPercent(w&&w.used_percent);
      const reset=_formatProviderQuotaReset(w&&w.reset_at);
      const meta=_providerQuotaWindowMeta(used,reset);
      const detail=(w&&w.detail)?String(w.detail).trim():'';
      return `<div class="provider-quota-pool-window"><span>${esc(_formatProviderQuotaWindowLabel(accountLimits,w))}</span><strong>${esc(remaining)}</strong>${meta.length?`<small>${esc(meta.join(' · '))}</small>`:''}${detail?`<small class="provider-quota-window-detail">${esc(detail)}</small>`:''}</div>`;
    }).join(''):`<div class="provider-quota-pool-note">${esc(unavailableReason||t('provider_quota_pool_no_windows'))}</div>`;
    const detailHtml=details.length?`<div class="provider-quota-pool-details">${details.map(d=>`<span>${esc(d)}</span>`).join('')}</div>`:'';
    return `
      <div class="provider-quota-pool-row provider-quota-pool-row-${status}">
        <div class="provider-quota-pool-row-head">
          <span>${esc(label)}${esc(plan)}</span>
          <strong>${esc(statusText)}</strong>
        </div>
        <div class="provider-quota-pool-windows">${windowHtml}</div>
        ${detailHtml}
      </div>
    `;
  }).join('');
  const planText=planParts.length?`<div class="provider-quota-pool-plans">${esc(t('provider_quota_pool_plans',planParts.join(', ')))}</div>`:'';
  return `
    <details class="provider-quota-pool"${defaultOpen?' open':''}>
      <summary><span class="provider-quota-pool-summary-label"><span class="provider-quota-pool-chevron" aria-hidden="true"></span><span>${esc(t('provider_quota_credential_pool'))}</span></span><strong>${esc(summaryParts.join(' · '))}</strong></summary>
      ${planText}
      <div class="provider-quota-pool-rows">${rows}</div>
    </details>
  `;
}

function _buildProviderQuotaCard(status){
  if(!status) return null;
  const card=document.createElement('div');
  const state=(status.status||'unavailable').replace(/[^a-z0-9_-]/gi,'').toLowerCase()||'unavailable';
  card.className='provider-quota-card provider-quota-card-'+state;
  const accountLimits=status.account_limits||null;
  const providerBase=status.display_name||status.provider||t('provider_quota_active_provider');
  const provider=(accountLimits&&accountLimits.plan)?`${providerBase} · ${accountLimits.plan}`:providerBase;
  const quota=status.quota||null;
  let body='';
  if(accountLimits&&(status.status==='available'||accountLimits.pool)){
    const windows=Array.isArray(accountLimits.windows)?accountLimits.windows:[];
    const details=Array.isArray(accountLimits.details)&&!accountLimits.pool?accountLimits.details:[];
    const windowHtml=windows.map(w=>{
      const used=_formatProviderQuotaPercent(w&&w.used_percent);
      const reset=_formatProviderQuotaReset(w&&w.reset_at);
      const meta=_providerQuotaWindowMeta(used,reset);
      const detail=(w&&w.detail)?String(w.detail).trim():'';
      return `
        <div class="provider-quota-metric provider-quota-window">
          <span>${esc(_formatProviderQuotaWindowLabel(accountLimits,w))}</span>
          <strong>${esc(_formatProviderQuotaPercent(w&&w.remaining_percent))}</strong>
          ${meta.length?`<small>${esc(meta.join(' · '))}</small>`:''}
          ${detail?`<small class="provider-quota-window-detail">${esc(detail)}</small>`:''}
        </div>
      `;
    }).join('');
    const detailHtml=details.length
      ? `<div class="provider-quota-details">${details.map(d=>`<span>${esc(d)}</span>`).join('')}</div>`
      : '';
    const poolHtml=_buildProviderQuotaPoolBreakdown(accountLimits);
    body=windowHtml+detailHtml+poolHtml;
    if(!body) body=`<div class="provider-quota-message">${esc(status.message||t('provider_quota_account_limits_loaded'))}</div>`;
  }else if(status.status==='available'&&quota){
    body=`
      <div class="provider-quota-metric"><span>${esc(t('provider_quota_metric_remaining'))}</span><strong>${esc(_formatProviderQuotaMoney(quota.limit_remaining))}</strong></div>
      <div class="provider-quota-metric"><span>${esc(t('provider_quota_metric_used'))}</span><strong>${esc(_formatProviderQuotaMoney(quota.usage))}</strong></div>
      <div class="provider-quota-metric"><span>${esc(t('provider_quota_metric_limit'))}</span><strong>${esc(_formatProviderQuotaMoney(quota.limit))}</strong></div>
    `;
  }else{
    let msg=status.message||t('provider_quota_unavailable');
    if(typeof msg==='string'&&msg.indexOf('provider_quota_')===0){msg=t(msg);}
    body=`<div class="provider-quota-message">${esc(msg)}</div>`;
  }
  card.innerHTML=`
    <div class="provider-quota-header">
      <div>
        <div class="provider-quota-title">${esc(t('provider_quota_title'))}</div>
        <div class="provider-quota-subtitle">${esc(provider)}</div>
        <div class="provider-quota-checked">${esc(_formatProviderQuotaLastChecked(status))}</div>
      </div>
      <div class="provider-quota-actions">
        <span class="provider-quota-badge">${esc(_providerQuotaStatusLabel(state))}</span>
        <button class="provider-quota-refresh" type="button" data-provider-quota-refresh title="${esc(t('provider_quota_refresh_title'))}">${esc(t('provider_quota_refresh_usage'))}</button>
      </div>
    </div>
    <div class="provider-quota-body">${body}</div>
  `;
  const refreshBtn=card.querySelector('[data-provider-quota-refresh]');
  if(refreshBtn) refreshBtn.addEventListener('click',()=>_refreshProviderQuota(card,refreshBtn));
  const poolDetails=card.querySelector('.provider-quota-pool');
  if(poolDetails){
    poolDetails.addEventListener('toggle',()=>{
      try{localStorage.setItem('hermes-provider-quota-pool-open',poolDetails.open?'1':'0');}catch(e){}
    });
  }
  return card;
}

async function renderProviderCostChart(card){
  let history;
  try{
    history=await api('/api/providers/cost-history?provider=openrouter');
  }catch(e){
    return; // silently skip if endpoint unavailable
  }
  const body=card.querySelector('.provider-quota-body');
  if(!body||body.querySelector('.provider-cost-chart-wrap')) return;
  if(!history||history.ok===false) return;
  const snaps=Array.isArray(history.snapshots)?history.snapshots:[];
  // need at least 2 snapshots to have one non-null delta
  const hasData=snaps.filter(s=>s.delta!=null).length>=1;
  if(!hasData){
    const empty=document.createElement('div');
    empty.className='provider-cost-chart-wrap';
    empty.innerHTML='<div class="provider-cost-chart-title">7-day spend</div><div class="provider-quota-message">Not enough data yet. Cost chart builds after 2 daily snapshots.</div>';
    body.appendChild(empty);
    return;
  }
  const maxDelta=Math.max(...snaps.map(s=>s.delta!=null?Number(s.delta):0),1e-9);
  const nonNull=snaps.filter(s=>s.delta!=null).map(s=>Number(s.delta));
  const avg=nonNull.length?nonNull.reduce((a,b)=>a+b,0)/nonNull.length:0;
  const pace='$'+(avg*30).toFixed(2);
  const bars=snaps.map(s=>{
    const delta=s.delta!=null?Number(s.delta):null;
    const pct=delta!=null?Math.max((delta/maxDelta)*100,delta>0?2:0).toFixed(1):'0';
    const label=String(s.date||'').slice(5);
    const tip=delta!=null?`${s.date} · $${delta.toFixed(4)}`:`${s.date} · no baseline`;
    return `<div class="insights-daily-bar" title="${esc(tip)}"><div class="insights-daily-stack" aria-label="${esc(tip)}"><div class="insights-daily-bar-input" style="height:${pct}%"></div></div><span>${esc(label)}</span></div>`;
  }).join('');
  const wrap=document.createElement('div');
  wrap.className='provider-cost-chart-wrap';
  wrap.innerHTML=`<div class="provider-cost-chart-title">7-day spend <span class="provider-cost-chart-pace">Monthly pace: ${esc(pace)}</span></div><div class="provider-cost-chart-bars insights-daily-token-chart">${bars}</div>`;
  body.appendChild(wrap);
}

function _buildProviderCard(p){
  const card=document.createElement('div');
  card.className='provider-card';
  card.dataset.provider=p.id;
  // Use the is_oauth flag from the backend — it reflects _OAUTH_PROVIDERS in providers.py.
  // key_source can be 'oauth' (hermes auth), 'config_yaml' (token in config.yaml), or 'none'.
  const isOauth=p.is_oauth===true;
  // models_total reflects the complete catalog (e.g. 396 for a large-tier
  // Nous Portal account). The "models" array may be trimmed to a featured
  // subset for UI scannability — fall back to its length only when the
  // server didn't supply models_total (older builds, custom providers).
  const modelCount=Number.isFinite(p.models_total)
    ? p.models_total
    : (Array.isArray(p.models) ? p.models.length : 0);
  const sourceLabel=p.key_source==='oauth'
    ? t('providers_status_oauth')
    : p.key_source==='config_yaml'
      ? t('providers_status_configured')
      : (p.has_key ? t('providers_status_api_key') : t('providers_status_not_configured_label'));
  const metaParts=[];
  if(modelCount>0) metaParts.push(t('providers_model_count', modelCount));
  metaParts.push(sourceLabel);
  if(p.api_format&&p.api_format!=='openai_chat') metaParts.push(p.api_format);
  if(p.base_url) metaParts.push(p.base_url.replace(/^https?:\/\//,'').replace(/\/$/,''));
  const metaText=metaParts.join(' · ');

  // Clickable header (toggles body)
  const header=document.createElement('button');
  header.type='button';
  header.className='provider-card-header';
  header.innerHTML=`
    <div class="provider-card-info">
      <div class="provider-card-name">${esc(p.display_name)}</div>
      <div class="provider-card-meta">${esc(metaText)}</div>
    </div>
    ${p.has_key?`<span class="provider-card-badge">${esc(t('providers_status_configured'))}</span>`:''}
    <svg class="provider-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><path d="M6 9l6 6 6-6"/></svg>
  `;
  card.appendChild(header);

  const body=document.createElement('div');
  body.className='provider-card-body';

  if(isOauth){
    const hint=document.createElement('div');
    hint.className='provider-card-hint';
    if(p.key_source==='config_yaml'){
      hint.textContent=t('providers_oauth_config_yaml_hint')||'Token configured via config.yaml. To update, edit the providers section in your config.yaml or run hermes auth.';
    } else if(p.auth_error){
      hint.textContent=p.auth_error;
      hint.style.color='var(--accent)';
    } else if(p.has_key){
      hint.textContent=t('providers_oauth_hint');
    } else {
      hint.textContent=t('providers_oauth_not_configured_hint')||'Not authenticated. Run hermes auth in the terminal to configure this provider.';
      hint.style.color='var(--muted)';
    }
    body.appendChild(hint);
    card.appendChild(body);
    header.addEventListener('click',()=>card.classList.toggle('open'));
    return card;
  }

  let input=null;
  let saveBtn=null;
  if(p.configurable){
    const field=document.createElement('div');
    field.className='provider-card-field';
    const label=document.createElement('label');
    label.className='provider-card-label';
    label.textContent=t('providers_status_api_key');
    field.appendChild(label);

    const row=document.createElement('div');
    row.className='provider-card-row';
    input=document.createElement('input');
    input.type='password';
    input.className='provider-card-input';
    input.placeholder=p.has_key?t('providers_key_placeholder_replace'):t('providers_key_placeholder_new');
    input.autocomplete='off';
    const toggleBtn=document.createElement('button');
    toggleBtn.type='button';
    toggleBtn.className='provider-card-btn provider-card-btn-ghost';
    toggleBtn.textContent=t('providers_show');
    toggleBtn.onclick=()=>{
      const revealed=input.type==='text';
      input.type=revealed?'password':'text';
      toggleBtn.textContent=revealed?t('providers_show'):t('providers_hide');
    };
    saveBtn=document.createElement('button');
    saveBtn.type='button';
    saveBtn.className='provider-card-btn provider-card-btn-primary';
    saveBtn.textContent=t('providers_save');
    saveBtn.onclick=()=>_saveProviderKey(p.id);
    saveBtn.disabled=true;
    row.appendChild(input);
    row.appendChild(toggleBtn);
    row.appendChild(saveBtn);
    if(p.has_key){
      const removeBtn=document.createElement('button');
      removeBtn.type='button';
      removeBtn.className='provider-card-btn provider-card-btn-danger';
      removeBtn.textContent=t('providers_remove');
      removeBtn.onclick=()=>_removeProviderKey(p.id);
      row.appendChild(removeBtn);
    }
    field.appendChild(row);
    body.appendChild(field);
  }else{
    const hint=document.createElement('div');
    hint.className='provider-card-hint';
    hint.textContent=p.is_custom
      ? t('providers_custom_hint')
      : t('providers_managed_hint');
    body.appendChild(hint);
  }

  // Model list — show when provider has known models
  if(modelCount>0){
    const modelSection=document.createElement('div');
    modelSection.className='provider-card-models';
    const modelLabel=document.createElement('div');
    modelLabel.className='provider-card-label';
    modelLabel.textContent=t('providers_models_label');
    modelSection.appendChild(modelLabel);
    const modelList=document.createElement('div');
    modelList.className='provider-card-model-tags';
    const renderedModels=Array.isArray(p.models)?p.models:[];
    for(const m of renderedModels){
      const tag=document.createElement('span');
      tag.className='provider-card-model-tag';
      tag.textContent=m.id||m.label||m;
      modelList.appendChild(tag);
    }
    // When the rendered list is a strict subset of the total catalog (Nous
    // Portal large-tier accounts hit this with ~400-model catalogs), show
    // a "+N more" trailing pill so the user knows the picker is intentionally
    // capped — and they can still reach the full catalog via the /model
    // slash command (its autocomplete consumes the un-trimmed list from
    // /api/models's extra_models field). #1567.
    const totalCount=Number.isFinite(p.models_total)?p.models_total:renderedModels.length;
    const hiddenCount=Math.max(0, totalCount - renderedModels.length);
    if(hiddenCount>0){
      const more=document.createElement('span');
      more.className='provider-card-model-tag provider-card-model-tag-more';
      more.textContent='+'+hiddenCount+' '+t('providers_models_more');
      more.title=t('providers_models_more_title');
      modelList.appendChild(more);
    }
    modelSection.appendChild(modelList);
    body.appendChild(modelSection);
  }

  // Refresh models for this provider
  const refreshRow=document.createElement('div');
  refreshRow.className='provider-card-row';
  refreshRow.style.marginTop='6px';
  const refreshBtn=document.createElement('button');
  refreshBtn.type='button';
  refreshBtn.className='provider-card-btn provider-card-btn-ghost';
  refreshBtn.style.display='flex';
  refreshBtn.style.alignItems='center';
  refreshBtn.style.gap='5px';
  refreshBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg> ${esc(t('providers_refresh_models'))}`;
  refreshBtn.onclick=()=>_refreshProviderModels(p.id, refreshBtn);
  refreshRow.appendChild(refreshBtn);
  body.appendChild(refreshRow);

  // Activate as default provider button
  const activateRow=document.createElement('div');
  activateRow.className='provider-card-row';
  activateRow.style.marginTop='6px';
  const activateBtn=document.createElement('button');
  activateBtn.type='button';
  activateBtn.className='provider-card-btn provider-card-btn-ghost';
  activateBtn.style.cssText='display:flex;align-items:center;gap:5px;';
  activateBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> ${esc(t('providers_activate'))}`;
  activateBtn.onclick=()=>_activateProvider(p.id, activateBtn);
  activateRow.appendChild(activateBtn);
  body.appendChild(activateRow);

  // Edit provider settings button
  const editRow=document.createElement('div');
  editRow.className='provider-card-row';
  editRow.style.marginTop='6px';
  const editBtn=document.createElement('button');
  editBtn.type='button';
  editBtn.className='provider-card-btn provider-card-btn-ghost';
  editBtn.style.cssText='display:flex;align-items:center;gap:5px;';
  editBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> ${esc(t('providers_edit'))}`;
  editBtn.onclick=()=>_showEditProviderModal(p);
  editRow.appendChild(editBtn);
  body.appendChild(editRow);

  // Delete provider button (custom / configurable providers only)
  if(p.is_custom || p.configurable){
    const deleteRow=document.createElement('div');
    deleteRow.className='provider-card-row';
    deleteRow.style.marginTop='6px';
    const deleteBtn=document.createElement('button');
    deleteBtn.type='button';
    deleteBtn.className='provider-card-btn provider-card-btn-danger';
    deleteBtn.style.cssText='display:flex;align-items:center;gap:5px;';
    deleteBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ${esc(t('providers_delete')||'Delete Provider')}`;
    deleteBtn.onclick=()=>_deleteProvider(p.id, p.display_name);
    deleteRow.appendChild(deleteBtn);
    body.appendChild(deleteRow);
  }

  card.appendChild(body);

  if(input&&saveBtn){
    _providerCardEls.set(p.id,{card,input,saveBtn,hasKey:p.has_key});
    input.addEventListener('input',()=>{saveBtn.disabled=!input.value.trim();});
  }
  header.addEventListener('click',e=>{
    // Don't toggle when clicking inside body (defensive; body isn't inside header)
    if(e.target.closest('.provider-card-body')) return;
    card.classList.toggle('open');
    if(card.classList.contains('open')) setTimeout(()=>input.focus(),0);
  });
  return card;
}

async function _saveProviderKey(providerId){
  const els=_providerCardEls.get(providerId);
  if(!els) return;
  const key=els.input.value.trim();
  if(!key){
    showToast(t('providers_enter_key'));
    return;
  }
  els.saveBtn.disabled=true;
  els.saveBtn.textContent=t('providers_saving');
  try{
    const res=await api('/api/providers',{method:'POST',body:JSON.stringify({provider:providerId,api_key:key})});
    if(res.ok){
      showToast(t('providers_key_saved_toast', res.provider, res.action));
      els.input.value='';
      // Invalidate every dropdown surface that caches /api/models so the
      // newly-configured provider's models show up without a server restart
      // or page reload (#1539). Server-side invalidate_models_cache() is
      // already called by api/providers.py:set_provider_key.
      _refreshModelDropdownsAfterProviderChange();
      await loadProvidersPanel(); // refresh list
    }else{
      showToast(res.error||t('providers_save_failed'));
      els.saveBtn.disabled=false;
      els.saveBtn.textContent=t('providers_save');
    }
  }catch(e){
    showToast(t('providers_error_prefix')+e.message);
    els.saveBtn.disabled=false;
    els.saveBtn.textContent=t('providers_save');
  }
}

async function _removeProviderKey(providerId){
  const els=_providerCardEls.get(providerId);
  if(!els) return;
  if(els.saveBtn){els.saveBtn.disabled=true;els.saveBtn.textContent=t('providers_removing');}
  try{
    const res=await api('/api/providers/delete',{method:'POST',body:JSON.stringify({provider:providerId})});
    if(res.ok){
      showToast(res.provider+' key '+t('providers_key_removed').toLowerCase());
      // Drop the removed provider from every cached dropdown surface so it
      // disappears immediately — composer picker, /model slash command,
      // Settings → Default Model, configured-model badges (#1539).
      // Without this, a stale list from before the delete keeps offering
      // the now-removed provider's models until the page is reloaded.
      _refreshModelDropdownsAfterProviderChange();
      await loadProvidersPanel(); // refresh list
    }else{
      showToast(res.error||'Failed to remove key');
      if(els.saveBtn){els.saveBtn.disabled=false;els.saveBtn.textContent=t('providers_save');}
    }
  }catch(e){
    // A 403 from /api/providers/delete fires when the CSRF cookie/header
    // pair has drifted. The server distinguishes three reasons in
    // api/routes.py:_csrf_rejection_error ("Session expired - reload the
    // page", "Cross-origin mismatch - check reverse proxy headers", and
    // the fallback "Cross-origin request rejected"); api()'s catch lifts
    // that string onto e.message. Pass it through verbatim so the
    // deployment-shape failure #2572 calls out keeps its actionable hint
    // instead of being flattened to a single generic toast.
    if(e&&e.status===403){
      showToast(e.message||'Session expired. Reload the page and try again.',6000,'error');
    }else{
      showToast('Error: '+e.message);
    }
    if(els.saveBtn){els.saveBtn.disabled=false;els.saveBtn.textContent=t('providers_save');}
  }
}

async function _deleteProvider(providerId, displayName){
  if(!confirm((t('providers_delete_confirm')||'Delete provider "{{name}}"?').replace('{{name}}', displayName||providerId))) return;
  try{
    const res=await api('/api/providers/delete',{method:'POST',body:JSON.stringify({provider:providerId})});
    if(res.ok){
      showToast((t('providers_deleted')||'Provider "{{name}}" deleted').replace('{{name}}', displayName||providerId));
      _refreshModelDropdownsAfterProviderChange();
      await loadProvidersPanel();
    }else{
      showToast(res.error||(t('providers_delete_failed')||'Failed to delete provider'));
    }
  }catch(e){
    if(e&&e.status===403){
      showToast(e.message||'Session expired. Reload the page and try again.',6000,'error');
    }else{
      showToast('Error: '+e.message);
    }
  }
}

// Shared dropdown-cache flush invoked after a provider add/remove. The
// server-side TTL cache is already invalidated by /api/providers and
// /api/providers/delete (via api/providers.py:set_provider_key); this
// flushes the JS-side caches so the next render rebuilds from a fresh
// /api/models response. Wrapped in a try/catch so a UI module that hasn't
// loaded yet (e.g. during early Settings open) cannot break the save flow.
function _refreshModelDropdownsAfterProviderChange(){
  try{
    if(typeof window._invalidateSlashModelCache==='function'){
      window._invalidateSlashModelCache();
    }
    // Clear live model cache so fresh models are fetched for the new provider
    if(typeof window._liveModelCache!=='undefined'){
      for(const k in window._liveModelCache){ delete window._liveModelCache[k]; }
    }
    // Fire-and-forget: don't block the providers panel refresh on a
    // dropdown rebuild. The composer/Settings dropdowns will catch up
    // on the very next paint frame.
    if(typeof window._ensureModelDropdownReady==='function'){
      window._modelDropdownReady=null;
      Promise.resolve(window._ensureModelDropdownReady()).catch(()=>{});
    }else if(typeof populateModelDropdown==='function'){
      Promise.resolve(populateModelDropdown()).catch(()=>{});
    }
  }catch(_e){}
}

async function _refreshProviderModels(providerId, btn){
  btn.disabled=true;
  const orig=btn.innerHTML;
  btn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg> ${t('providers_refreshing')||'Refreshing...'}`;
  try{
    const res=await api('/api/models/refresh',{method:'POST',body:JSON.stringify({provider:providerId})});
    if(res.ok){
      showToast(t('providers_models_refreshed')||('Models refreshed for '+res.provider));
      _refreshModelDropdownsAfterProviderChange();
    }else{
      showToast(res.error||'Failed to refresh models');
    }
  }catch(e){
    showToast(e.status===404?'Refresh not available for this provider.':(e.message||'Failed to refresh models'));
  }finally{
    btn.disabled=false;
    btn.innerHTML=orig;
  }
}

async function _activateProvider(providerId, btn){
  btn.disabled=true;
  const orig=btn.innerHTML;
  btn.textContent=t('providers_activating')||'Activating...';
  try{
    const res=await api('/api/providers/activate',{method:'POST',body:JSON.stringify({provider:providerId})});
    if(res.ok){
      showToast((t('providers_activated')||'Activated')+' '+res.provider);
      window._activeProvider=res.provider;
      // 激活后自动刷新该提供商的模型列表，确保下拉菜单能显示最新模型
      try{ await api('/api/models/refresh',{method:'POST',body:JSON.stringify({provider:providerId})}); }catch(_){}
      _refreshModelDropdownsAfterProviderChange();
      await loadProvidersPanel();
    }else{
      showToast(res.error||'Failed to activate provider');
    }
  }catch(e){
    showToast('Error: '+(e.message||'Failed to activate'));
  }finally{
    btn.disabled=false;
    btn.innerHTML=orig;
  }
}

function _showEditProviderModal(p){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
  const modal=document.createElement('div');
  modal.style.cssText='background:var(--bg-primary);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

  // Parse existing model_mapping JSON if available
  let modelMapping={};
  try{if(p.model_mapping) modelMapping=JSON.parse(p.model_mapping);}catch(e){}

  modal.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="margin:0;font-size:16px;">${t('providers_edit_title')}</h3>
      <button id="_editProvClose" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:4px 8px;">&times;</button>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_name')}</label>
      <input id="_editProvName" type="text" value="${esc(p.id||p.name||'')}" readonly style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;opacity:.6;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_display_name')}</label>
      <input id="_editProvDisplayName" type="text" value="${esc(p.display_name||'')}" placeholder="e.g. DeepSeek" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_base_url')}</label>
      <input id="_editProvBaseURL" type="text" value="${esc(p.base_url||'')}" placeholder="https://api.example.com/v1" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_api_key')} <span style="font-size:11px;color:var(--muted);">(${t('providers_hint_api_key_keep')})</span></label>
      <div style="position:relative;width:100%;">
        <!-- 【重要备注】此处 value 故意填入真实 API Key（p.api_key），方便用户在多设备间核对密钥。
             不要为了"安全"而把 value 置空或改为掩码——之前 value="" 导致点击眼睛切换 type=text 后看不到任何内容。
             用户明确要求：点击眼睛按钮必须能看到真实密钥。掩码仅用于 placeholder 提示。 -->
        <input id="_editProvAPIKey" type="password" value="${esc(p.api_key||'')}" placeholder="${p.has_key?(t('providers_hint_api_key_saved')+(p.api_key_masked?(' ('+esc(p.api_key_masked)+')'):'')):t('providers_key_placeholder_new')}" style="width:100%;padding:8px 40px 8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        <button id="_editProvAPIKeyToggle" type="button" title="${t('providers_show_api_key')||'Show API key'}" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--muted);padding:4px;display:flex;align-items:center;justify-content:center;border-radius:4px;">
          <svg id="_editProvAPIKeyIconShow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          <svg id="_editProvAPIKeyIconHide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
        </button>
      </div>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_api_format')}</label>
      <select id="_editProvAPIFormat" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;">
        <option value="openai_chat" ${p.api_format==='openai_chat'||!p.api_format?'selected':''}>${t('providers_option_openai_chat')}</option>
        <option value="anthropic" ${p.api_format==='anthropic'?'selected':''}>${t('providers_option_anthropic')}</option>
      </select>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_auth_strategy')}</label>
      <select id="_editProvAuthStrategy" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;">
        <option value="api_key" ${p.auth_strategy==='api_key'||!p.auth_strategy?'selected':''}>${t('providers_option_api_key')}</option>
        <option value="auth_token" ${p.auth_strategy==='auth_token'?'selected':''}>${t('providers_option_auth_token')}</option>
        <option value="auth_token_empty_api_key" ${p.auth_strategy==='auth_token_empty_api_key'?'selected':''}>${t('providers_option_auth_token_empty')}</option>
        <option value="dual_same_token" ${p.auth_strategy==='dual_same_token'?'selected':''}>${t('providers_option_dual_same')}</option>
        <option value="dual_dummy" ${p.auth_strategy==='dual_dummy'?'selected':''}>${t('providers_option_dual_dummy')}</option>
      </select>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_default_model')}</label>
      <input id="_editProvDefaultModel" type="text" value="${esc(p.default_model||'')}" placeholder="e.g. gpt-4o" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;">
        <input id="_editProvSupportsVision" type="checkbox" ${p.supports_vision?'checked':''} style="width:16px;height:16px;cursor:pointer;">
        <span>${t('providers_label_supports_vision')}</span>
      </label>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;">
        <input id="_editProvSupportsVoice" type="checkbox" ${p.supports_voice?'checked':''} style="width:16px;height:16px;cursor:pointer;">
        <span>${t('providers_label_supports_voice')}</span>
      </label>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_model_mapping')} <span style="font-size:11px;color:var(--muted);">${t('providers_hint_model_mapping')}</span></label>
      <textarea id="_editProvModelMapping" rows="4" placeholder='{"main":"model-name","sonnet":"model-name"}' style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:monospace;box-sizing:border-box;resize:vertical;">${esc(p.model_mapping||'')}</textarea>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_model_context')}</label>
      <div id="_editProvModelContextList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input id="_editProvModelContextNewModel" type="text" placeholder="${t('providers_placeholder_model_id')||'model-id'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        <input id="_editProvModelContextNewWindow" type="number" placeholder="${t('providers_placeholder_context_window')||'例如 200000'}" style="width:140px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        <button type="button" id="_editProvModelContextAddBtn" style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;white-space:nowrap;">${t('providers_button_add_model')||'+ 添加'}</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <label style="font-size:12px;color:var(--muted);min-width:120px;">${t('providers_label_fallback_window')||'未知模型兜底窗口'}</label>
        <input id="_editProvModelContextFallback" type="number" placeholder="${t('providers_placeholder_fallback_window')||'可选，例如 200000'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:4px;">${t('providers_hint_model_context_new')||'按每个模型的真实上下文填写，留空则走内置识别或默认 200K。'}</p>
      <input type="hidden" id="_editProvModelContextWindows" value="${esc(p.model_context_windows||'')}">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_notes')}</label>
      <input id="_editProvNotes" type="text" value="${esc(p.notes||'')}" placeholder="${t('providers_placeholder_notes')}" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
      <button id="_editProvCancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;">${t('cancel')}</button>
      <button id="_editProvTest" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;">${t('providers_button_test')}</button>
      <button id="_editProvSubmit" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;">${t('providers_save')}</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close=()=>overlay.remove();
  modal.querySelector('#_editProvClose').onclick=close;
  modal.querySelector('#_editProvCancel').onclick=close;
  overlay.addEventListener('click',e=>{if(e.target===overlay) close();});

  // ===== 模型上下文窗口动态列表 =====
  const ctxList=modal.querySelector('#_editProvModelContextList');
  const ctxNewModel=modal.querySelector('#_editProvModelContextNewModel');
  const ctxNewWindow=modal.querySelector('#_editProvModelContextNewWindow');
  const ctxAddBtn=modal.querySelector('#_editProvModelContextAddBtn');
  const ctxFallback=modal.querySelector('#_editProvModelContextFallback');
  const ctxHidden=modal.querySelector('#_editProvModelContextWindows');

  // 解析现有配置
  let ctxMap={};
  let ctxFallbackVal='';
  try{
    const raw=(p.model_context_windows||'').trim();
    if(raw){
      const parsed=JSON.parse(raw);
      if(typeof parsed==='object'){
        for(const k in parsed){
          if(k==='__fallback__'||k==='__default__'||k===''){
            ctxFallbackVal=String(parsed[k]);
          }else{
            ctxMap[k]=String(parsed[k]);
          }
        }
      }
    }
  }catch(_){}
  if(ctxFallbackVal) ctxFallback.value=ctxFallbackVal;

  // 从供应商模型列表中提取模型 ID
  const providerModels=[];
  if(Array.isArray(p.models)){
    for(const m of p.models){
      const id=typeof m==='string'?m:(m.id||m.label||'');
      if(id) providerModels.push(id);
    }
  }

  // 渲染单个模型行
  function _renderCtxRow(modelId, windowSize){
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;';
    const label=document.createElement('span');
    label.style.cssText='font-size:12px;color:var(--text-primary);min-width:180px;word-break:break-all;';
    label.textContent=modelId;
    const input=document.createElement('input');
    input.type='number';
    input.value=windowSize||'';
    input.placeholder=t('providers_placeholder_context_window')||'例如 200000';
    input.style.cssText='flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;';
    input.dataset.modelId=modelId;
    const delBtn=document.createElement('button');
    delBtn.type='button';
    delBtn.textContent='×';
    delBtn.title=t('providers_button_remove_model')||'移除';
    delBtn.style.cssText='padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    delBtn.onclick=()=>{row.remove();};
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(delBtn);
    return row;
  }

  // 初始化：先显示已配置的模型，再补充供应商模型列表中未配置的模型
  const configuredIds=Object.keys(ctxMap);
  for(const mid of configuredIds){
    ctxList.appendChild(_renderCtxRow(mid, ctxMap[mid]));
  }
  const shownSet=new Set(configuredIds);
  for(const mid of providerModels){
    if(!shownSet.has(mid)){
      shownSet.add(mid);
      ctxList.appendChild(_renderCtxRow(mid, ''));
    }
  }

  // 添加模型按钮
  if(ctxAddBtn){
    ctxAddBtn.onclick=()=>{
      const mid=ctxNewModel.value.trim();
      const win=ctxNewWindow.value.trim();
      if(!mid){ showToast(t('providers_error_model_id_required')||'请输入模型 ID'); return; }
      // 检查是否已存在
      const existing=ctxList.querySelectorAll('input[data-model-id]');
      for(const inp of existing){
        if(inp.dataset.modelId===mid){
          showToast(t('providers_error_model_exists')||'该模型已存在');
          return;
        }
      }
      ctxList.appendChild(_renderCtxRow(mid, win));
      ctxNewModel.value='';
      ctxNewWindow.value='';
      ctxNewModel.focus();
    };
    // 回车键添加
    ctxNewWindow.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();ctxAddBtn.click();}};
    ctxNewModel.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();ctxNewWindow.focus();}};
  }

  // 收集数据并同步到 hidden input
  function _syncCtxToHidden(){
    const result={};
    const inputs=ctxList.querySelectorAll('input[data-model-id]');
    for(const inp of inputs){
      const mid=inp.dataset.modelId;
      const val=inp.value.trim();
      if(mid && val){
        const num=parseInt(val,10);
        if(!isNaN(num) && num>0) result[mid]=num;
      }
    }
    const fb=ctxFallback.value.trim();
    if(fb){
      const num=parseInt(fb,10);
      if(!isNaN(num) && num>0) result['__fallback__']=num;
    }
    ctxHidden.value=Object.keys(result).length>0?JSON.stringify(result):'';
  }

  // Toggle API key visibility
  _wirePasswordToggle(modal,'#_editProvAPIKey','#_editProvAPIKeyToggle','#_editProvAPIKeyIconShow','#_editProvAPIKeyIconHide');

  // Test connection
  const testBtnEdit=modal.querySelector('#_editProvTest');
  if(testBtnEdit){
    testBtnEdit.addEventListener('click',async()=>{
      const btn=modal.querySelector('#_editProvTest');
      if(!btn) return;
      btn.textContent=t('providers_testing')||'Testing...';btn.disabled=true;
      try{
        const editApiKey=modal.querySelector('#_editProvAPIKey').value.trim();
        const res=await api('/api/providers/test',{method:'POST',body:JSON.stringify({
          provider: p.id||p.name,
          base_url: modal.querySelector('#_editProvBaseURL').value.trim()||p.base_url,
          api_key: editApiKey||undefined,
          api_format: modal.querySelector('#_editProvAPIFormat').value,
        })});
        if(res.ok||res.success){
          showToast(t('providers_test_passed')||'Connection test passed',null,'success');
        }else{
          showToast(res.error||t('providers_test_failed')||'Connection test failed',null,'error');
        }
      }catch(e){
        console.error('[provider-test] api error:', e);
        showToast((t('providers_test_error')||'Test error')+': '+(e.message||'failed'),null,'error');
      }finally{
        btn.textContent=t('providers_button_test')||'Test';btn.disabled=false;
      }
    });
  }

  // Save
  modal.querySelector('#_editProvSubmit').onclick=async()=>{
    const modelMappingVal=modal.querySelector('#_editProvModelMapping').value.trim();
    // Validate JSON if provided
    if(modelMappingVal){
      try{JSON.parse(modelMappingVal);}catch(e){showToast('Model Mapping must be valid JSON');return;}
    }
    // 同步动态模型上下文窗口到 hidden input
    _syncCtxToHidden();
    const modelContextWindowsVal=modal.querySelector('#_editProvModelContextWindows').value.trim();
    if(modelContextWindowsVal){
      try{JSON.parse(modelContextWindowsVal);}catch(e){showToast('Model Context Windows must be valid JSON');return;}
    }
    const body={
      provider: p.id||p.name,
      display_name: modal.querySelector('#_editProvDisplayName').value.trim()||(p.id||p.name),
      base_url: modal.querySelector('#_editProvBaseURL').value.trim(),
      api_format: modal.querySelector('#_editProvAPIFormat').value,
      auth_strategy: modal.querySelector('#_editProvAuthStrategy').value,
      default_model: modal.querySelector('#_editProvDefaultModel').value.trim(),
      supports_vision: modal.querySelector('#_editProvSupportsVision').checked,
      supports_voice: modal.querySelector('#_editProvSupportsVoice').checked,
      model_mapping: modelMappingVal,
      model_context_windows: modelContextWindowsVal,
      notes: modal.querySelector('#_editProvNotes').value.trim(),
    };
    const apiKeyVal=modal.querySelector('#_editProvAPIKey').value.trim();
    if(apiKeyVal) { body.api_key=apiKeyVal; body._api_key_provided='true'; }
    // When apiKeyVal is empty, don't send _api_key_provided so backend preserves existing key
    try{
      const res=await api('/api/providers',{method:'POST',body:JSON.stringify(body)});
      if(res.ok){
        showToast('Provider updated');
        close();
        _refreshModelDropdownsAfterProviderChange();
        await loadProvidersPanel();
      }else{
        showToast(res.error||'Failed to update provider');
      }
    }catch(e){
      showToast('Error: '+(e.message||'Failed to update provider'));
    }
  };
}

function _showAddProviderModal(){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
  const modal=document.createElement('div');
  modal.style.cssText='background:var(--bg-primary);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
  modal.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="margin:0;font-size:16px;">${t('providers_add_title')}</h3>
      <button id="_addProvClose" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:4px 8px;">&times;</button>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_preset')}</label>
      <div id="_addProvPresetChips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <button type="button" class="provider-preset-chip active" data-preset="" id="_addProvPresetCustom" style="padding:4px 12px;border-radius:999px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text);font-size:12px;cursor:pointer;transition:all .15s;">${t('providers_preset_custom')}</button>
      </div>
      <input type="hidden" id="_addProvPreset" value="">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_name')} <span style="color:var(--error)">*</span></label>
      <input id="_addProvName" type="text" placeholder="e.g. deepseek" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_display_name')}</label>
      <input id="_addProvDisplayName" type="text" placeholder="e.g. DeepSeek" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_base_url')}</label>
      <input id="_addProvBaseURL" type="text" placeholder="https://api.example.com/v1" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;position:relative;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_api_key')}</label>
      <input id="_addProvAPIKey" type="password" placeholder="${t('providers_key_placeholder_new')}" style="width:100%;padding:8px 40px 8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
      <button id="_addProvAPIKeyToggle" type="button" title="${t('providers_show_api_key')||'Show API key'}" style="position:absolute;right:8px;bottom:8px;background:none;border:none;cursor:pointer;color:var(--muted);padding:4px;display:flex;align-items:center;justify-content:center;border-radius:4px;">
        <svg id="_addProvAPIKeyIconShow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        <svg id="_addProvAPIKeyIconHide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
      </button>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_api_format')}</label>
      <select id="_addProvAPIFormat" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;">
        <option value="openai_chat">${t('providers_option_openai_chat')}</option>
        <option value="anthropic">${t('providers_option_anthropic')}</option>
      </select>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_auth_strategy')}</label>
      <select id="_addProvAuthStrategy" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;">
        <option value="api_key">${t('providers_option_api_key')}</option>
        <option value="auth_token">${t('providers_option_auth_token')}</option>
        <option value="auth_token_empty_api_key">${t('providers_option_auth_token_empty')}</option>
        <option value="dual_same_token">${t('providers_option_dual_same')}</option>
        <option value="dual_dummy">${t('providers_option_dual_dummy')}</option>
      </select>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_default_model')}</label>
      <input id="_addProvDefaultModel" type="text" placeholder="e.g. gpt-4o" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;">
        <input id="_addProvSupportsVision" type="checkbox" style="width:16px;height:16px;cursor:pointer;">
        <span>${t('providers_label_supports_vision')}</span>
      </label>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;">
        <input id="_addProvSupportsVoice" type="checkbox" style="width:16px;height:16px;cursor:pointer;">
        <span>${t('providers_label_supports_voice')}</span>
      </label>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_model_mapping')} <span style="font-size:11px;color:var(--muted);">${t('providers_hint_model_mapping')}</span></label>
      <textarea id="_addProvModelMapping" rows="3" placeholder='{"main":"model-name","sonnet":"model-name"}' style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:monospace;box-sizing:border-box;resize:vertical;"></textarea>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_model_context')}</label>
      <div id="_addProvModelContextList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input id="_addProvModelContextNewModel" type="text" placeholder="${t('providers_placeholder_model_id')||'model-id'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        <input id="_addProvModelContextNewWindow" type="number" placeholder="${t('providers_placeholder_context_window')||'例如 200000'}" style="width:140px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        <button type="button" id="_addProvModelContextAddBtn" style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;white-space:nowrap;">${t('providers_button_add_model')||'+ 添加'}</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <label style="font-size:12px;color:var(--muted);min-width:120px;">${t('providers_label_fallback_window')||'未知模型兜底窗口'}</label>
        <input id="_addProvModelContextFallback" type="number" placeholder="${t('providers_placeholder_fallback_window')||'可选，例如 200000'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:4px;">${t('providers_hint_model_context_new')||'按每个模型的真实上下文填写，留空则走内置识别或默认 200K。'}</p>
      <input type="hidden" id="_addProvModelContextWindows" value="">
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">${t('providers_label_notes')}</label>
      <input id="_addProvNotes" type="text" placeholder="${t('providers_placeholder_notes')}" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
      <button id="_addProvCancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;">${t('cancel')}</button>
      <button id="_addProvSubmit" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;">${t('providers_button_add')}</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close handlers
  const close=()=>overlay.remove();
  modal.querySelector('#_addProvClose').onclick=close;
  modal.querySelector('#_addProvCancel').onclick=close;
  overlay.addEventListener('click',e=>{if(e.target===overlay) close();});

  // Toggle API key visibility (Add Provider)
  _wirePasswordToggle(modal,'#_addProvAPIKey','#_addProvAPIKeyToggle','#_addProvAPIKeyIconShow','#_addProvAPIKeyIconHide');

  // ===== 模型上下文窗口动态列表（添加提供商） =====
  const addCtxList=modal.querySelector('#_addProvModelContextList');
  const addCtxNewModel=modal.querySelector('#_addProvModelContextNewModel');
  const addCtxNewWindow=modal.querySelector('#_addProvModelContextNewWindow');
  const addCtxAddBtn=modal.querySelector('#_addProvModelContextAddBtn');
  const addCtxFallback=modal.querySelector('#_addProvModelContextFallback');
  const addCtxHidden=modal.querySelector('#_addProvModelContextWindows');

  function _renderAddCtxRow(modelId, windowSize){
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;';
    const label=document.createElement('span');
    label.style.cssText='font-size:12px;color:var(--text-primary);min-width:180px;word-break:break-all;';
    label.textContent=modelId;
    const input=document.createElement('input');
    input.type='number';
    input.value=windowSize||'';
    input.placeholder=t('providers_placeholder_context_window')||'例如 200000';
    input.style.cssText='flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;';
    input.dataset.modelId=modelId;
    const delBtn=document.createElement('button');
    delBtn.type='button';
    delBtn.textContent='×';
    delBtn.title=t('providers_button_remove_model')||'移除';
    delBtn.style.cssText='padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    delBtn.onclick=()=>{row.remove();};
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(delBtn);
    return row;
  }

  if(addCtxAddBtn){
    addCtxAddBtn.onclick=()=>{
      const mid=addCtxNewModel.value.trim();
      const win=addCtxNewWindow.value.trim();
      if(!mid){ showToast(t('providers_error_model_id_required')||'请输入模型 ID'); return; }
      const existing=addCtxList.querySelectorAll('input[data-model-id]');
      for(const inp of existing){
        if(inp.dataset.modelId===mid){
          showToast(t('providers_error_model_exists')||'该模型已存在');
          return;
        }
      }
      addCtxList.appendChild(_renderAddCtxRow(mid, win));
      addCtxNewModel.value='';
      addCtxNewWindow.value='';
      addCtxNewModel.focus();
    };
    addCtxNewWindow.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();addCtxAddBtn.click();}};
    addCtxNewModel.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();addCtxNewWindow.focus();}};
  }

  function _syncAddCtxToHidden(){
    const result={};
    const inputs=addCtxList.querySelectorAll('input[data-model-id]');
    for(const inp of inputs){
      const mid=inp.dataset.modelId;
      const val=inp.value.trim();
      if(mid && val){
        const num=parseInt(val,10);
        if(!isNaN(num) && num>0) result[mid]=num;
      }
    }
    const fb=addCtxFallback.value.trim();
    if(fb){
      const num=parseInt(fb,10);
      if(!isNaN(num) && num>0) result['__fallback__']=num;
    }
    addCtxHidden.value=Object.keys(result).length>0?JSON.stringify(result):'';
  }

  // Load presets as chips
  const presetHidden=modal.querySelector('#_addProvPreset');
  const presetChipsContainer=modal.querySelector('#_addProvPresetChips');
  const nameInput=modal.querySelector('#_addProvName');
  const displayNameInput=modal.querySelector('#_addProvDisplayName');
  const baseURLInput=modal.querySelector('#_addProvBaseURL');
  const apiFormatSelect=modal.querySelector('#_addProvAPIFormat');
  const authStrategySelect=modal.querySelector('#_addProvAuthStrategy');
  const defaultModelInput=modal.querySelector('#_addProvDefaultModel');
  const modelMappingInput=modal.querySelector('#_addProvModelMapping');
  const modelContextWindowsInput=modal.querySelector('#_addProvModelContextWindows');
  let _presetData=[];

  function _selectPresetChip(id){
    presetChipsContainer.querySelectorAll('.provider-preset-chip').forEach(chip=>{
      const isActive=chip.dataset.preset===id;
      chip.classList.toggle('active',isActive);
      chip.style.borderColor=isActive?'var(--accent)':'var(--border)';
      chip.style.background=isActive?'var(--accent-bg)':'var(--bg-primary)';
      chip.style.color=isActive?'var(--accent)':'var(--text)';
    });
    presetHidden.value=id;
    const pr=_presetData.find(x=>x.id===id);
    if(pr&&id!==''){
      nameInput.value=pr.id||'';
      displayNameInput.value=pr.name||'';
      baseURLInput.value=pr.base_url||'';
      apiFormatSelect.value=pr.api_format||'openai_chat';
      if(authStrategySelect) authStrategySelect.value=pr.auth_strategy||'api_key';
      defaultModelInput.value=(pr.default_models&&pr.default_models.main)||'';
      if(modelMappingInput&&pr.default_models) modelMappingInput.value=JSON.stringify(pr.default_models);
      // 填充模型上下文窗口列表
      if(pr.model_context_windows){
        addCtxList.innerHTML='';
        const ctxMap=pr.model_context_windows;
        if(typeof ctxMap==='object'){
          for(const k in ctxMap){
            if(k==='__fallback__'||k==='__default__'||k===''){
              addCtxFallback.value=String(ctxMap[k]);
            }else{
              addCtxList.appendChild(_renderAddCtxRow(k, String(ctxMap[k])));
            }
          }
        }
      }
    }
  }

  (async()=>{
    try{
      const data=await api('/api/providers/presets');
      const presets=data.presets||[];
      _presetData=presets;
      for(const pr of presets){
        if(pr.id==='custom') continue; // 跳过 custom 预设，前端已硬编码"自定义"按钮（data-preset=""），避免出现两个"自定义"
        const chip=document.createElement('button');
        chip.type='button';
        chip.className='provider-preset-chip';
        chip.dataset.preset=pr.id;
        chip.textContent=pr.name;
        chip.style.cssText='padding:4px 12px;border-radius:999px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text);font-size:12px;cursor:pointer;transition:all .15s;';
        chip.onclick=()=>_selectPresetChip(pr.id);
        presetChipsContainer.appendChild(chip);
      }
    }catch(e){/* ignore, presets are optional */}
  })();

  modal.querySelector('#_addProvPresetCustom').onclick=()=>_selectPresetChip('');

  // Test connection button for add modal
  const testBtn=document.createElement('button');
  testBtn.type='button';
  testBtn.id='_addProvTest';
  testBtn.textContent='Test';
  testBtn.style.cssText='padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
  const btnRow=modal.querySelector('#_addProvSubmit').parentNode;
  btnRow.insertBefore(testBtn,modal.querySelector('#_addProvSubmit'));

  testBtn.addEventListener('click',async()=>{
    const name=nameInput.value.trim();
    const baseURL=baseURLInput.value.trim();
    const apiKey=modal.querySelector('#_addProvAPIKey').value.trim();
    const apiFormat=apiFormatSelect.value;
    if(!baseURL){showToast(t('providers_test_base_url_required')||'Base URL is required for testing');return;}
    testBtn.disabled=true;
    testBtn.textContent=t('providers_testing')||'Testing...';
    try{
      const res=await api('/api/providers/test',{method:'POST',body:JSON.stringify({provider:name||'custom',base_url:baseURL,api_key:apiKey,api_format:apiFormat})});
      if(res.ok&&res.reachable){
        showToast((t('providers_test_ok')||'Connection OK — ')+((res.models||[]).length+' '+(t('providers_test_models_found')||'models found')),null,'success');
      }else{
        showToast((t('providers_test_failed')||'Connection failed')+': '+(res.error||(t('providers_test_unknown')||'Unknown error')),null,'error');
      }
    }catch(e){showToast((t('providers_test_error')||'Test error')+': '+(e.message||String(e)),null,'error');}
    finally{testBtn.disabled=false;testBtn.textContent=t('providers_button_test')||'Test';}
  });

  // Submit
  modal.querySelector('#_addProvSubmit').onclick=async()=>{
    const name=nameInput.value.trim();
    if(!name){showToast('Provider name is required');return;}
    const modelMappingVal=modelMappingInput?modelMappingInput.value.trim():'';
    if(modelMappingVal){try{JSON.parse(modelMappingVal);}catch(e){showToast('Model Mapping must be valid JSON');return;}}
    // 同步动态模型上下文窗口到 hidden input
    _syncAddCtxToHidden();
    const modelContextWindowsVal=modelContextWindowsInput?modelContextWindowsInput.value.trim():'';
    if(modelContextWindowsVal){try{JSON.parse(modelContextWindowsVal);}catch(e){showToast('Model Context Windows must be valid JSON');return;}}
    const body={
      provider: name,
      display_name: displayNameInput.value.trim()||name,
      base_url: baseURLInput.value.trim(),
      api_key: modal.querySelector('#_addProvAPIKey').value.trim(),
      api_format: apiFormatSelect.value,
      auth_strategy: authStrategySelect?authStrategySelect.value:'api_key',
      default_model: defaultModelInput.value.trim(),
      supports_vision: modal.querySelector('#_addProvSupportsVision').checked,
      supports_voice: modal.querySelector('#_addProvSupportsVoice').checked,
      model_mapping: modelMappingVal,
      model_context_windows: modelContextWindowsVal,
      preset_id: presetHidden.value||'',
      notes: modal.querySelector('#_addProvNotes').value.trim(),
    };
    try{
      const res=await api('/api/providers',{method:'POST',body:JSON.stringify(body)});
      if(res.ok){
        showToast('Provider '+name+' added');
        close();
        // 自动刷新该供应商的模型列表
        try{
          await api('/api/models/refresh',{method:'POST',body:JSON.stringify({provider:name})});
          showToast('Models refreshed for '+name);
        }catch(_){}
        _refreshModelDropdownsAfterProviderChange();
        await loadProvidersPanel();
      }else{
        showToast(res.error||'Failed to add provider');
      }
    }catch(e){
      showToast('Error: '+(e.message||'Failed to add provider'));
    }
  };
}

let _settingsPasswordEnvLocked=false;
function _setSettingsAuthButtonsVisible(active){
  const signOutBtn=$('btnSignOut');
  if(signOutBtn) signOutBtn.style.display=active?'':'none';
  const disableBtn=$('btnDisableAuth');
  if(disableBtn) disableBtn.style.display=active?'':'none';
  const passkeyBtn=$('btnRegisterPasskey');
  if(passkeyBtn) passkeyBtn.disabled=!active||!window.PublicKeyCredential||!navigator.credentials;
}
function _syncPasswordlessButton(authStatus){
  const btn=$('btnGoPasswordless');
  if(!btn) return;
  const can=!!(authStatus&&authStatus.auth_enabled&&authStatus.password_auth_enabled&&authStatus.passkeys_count>0&&!_settingsPasswordEnvLocked);
  btn.style.display=can?'':'none';
  btn.disabled=!can;
}

function _b64uToBytes(s){
  s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4) s+='=';
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function _bytesToB64u(buf){
  const bytes=new Uint8Array(buf);let bin='';
  for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}

async function loadPasskeys(){
  const list=$('passkeyList');
  const block=$('passkeysSettingsBlock');
  if(!list) return;
  // Stage-batch14: respect the HERMES_WEBUI_PASSKEY feature flag — hide the
  // whole block when passkey support is disabled at the server level so users
  // don't see a non-functional "Add passkey" button (clicking it would 404).
  try{
    const status=await api('/api/auth/status');
    if(status && status.passkey_feature_flag === false){
      if(block) block.style.display='none';
      return;
    }
    if(block) block.style.display='';
  }catch(_e){
    // If /api/auth/status fails, keep the block hidden to avoid showing a
    // broken affordance.
    if(block) block.style.display='none';
    return;
  }
  if(!window.PublicKeyCredential||!navigator.credentials){
    list.textContent='Passkeys are not supported by this browser/context.';
    const btn=$('btnRegisterPasskey'); if(btn) btn.disabled=true;
    return;
  }
  try{
    const data=await api('/api/auth/passkeys');
    if(data && data.disabled){
      if(block) block.style.display='none';
      return;
    }
    const creds=(data&&data.credentials)||[];
    if(!creds.length){list.textContent='No passkeys registered.';return;}
    list.innerHTML=creds.map(c=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--border);border-radius:8px;padding:8px;margin-top:6px"><span>${esc(c.label||'Passkey')}</span><button class="btn-tiny" onclick="deletePasskey('${esc(c.id)}')">Remove</button></div>`).join('');
  }catch(e){list.textContent='Failed to load passkeys: '+e.message;}
}

async function registerPasskey(){
  if(!window.PublicKeyCredential||!navigator.credentials){showToast('Passkeys require a supported browser and secure context.');return;}
  const label='This device';
  try{
    const optData=await api('/api/auth/passkey/register/options',{method:'POST',body:'{}'});
    const pk=optData.publicKey;
    pk.challenge=_b64uToBytes(pk.challenge);
    pk.user=Object.assign({},pk.user,{id:_b64uToBytes(pk.user.id)});
    if(Array.isArray(pk.excludeCredentials)) pk.excludeCredentials=pk.excludeCredentials.map(c=>Object.assign({},c,{id:_b64uToBytes(c.id)}));
    const cred=await navigator.credentials.create({publicKey:pk});
    if(!cred) throw new Error('Passkey registration cancelled');
    await api('/api/auth/passkey/register',{method:'POST',body:JSON.stringify({
      id:cred.id,rawId:_bytesToB64u(cred.rawId),type:cred.type,label,
      response:{clientDataJSON:_bytesToB64u(cred.response.clientDataJSON),attestationObject:_bytesToB64u(cred.response.attestationObject)}
    })});
    showToast('Passkey registered');
    loadPasskeys();
    try{_syncPasswordlessButton(await api('/api/auth/status'));}catch(_e){}
  }catch(e){showToast('Passkey registration failed: '+e.message);}
}

async function deletePasskey(id){
  const ok=await showConfirmDialog({title:'Remove passkey?',message:'This browser/device will no longer be able to sign in with that passkey.',confirmLabel:'Remove',danger:true,focusCancel:true});
  if(!ok) return;
  try{await api('/api/auth/passkey/delete',{method:'POST',body:JSON.stringify({id})});showToast('Passkey removed');loadPasskeys();try{_syncPasswordlessButton(await api('/api/auth/status'));}catch(_e){}}
  catch(e){showToast('Failed to remove passkey: '+e.message);}
}

function _applySavedSettingsUi(saved, body, opts){
  const {sendKey,showTokenUsage,showQuotaChip,showConversationOutline,showTps,fadeTextEffect,showCliSessions,theme,skin,language,sidebarDensity,fontSize}=opts;
  window._sendKey=sendKey||'enter';
  window._showTokenUsage=showTokenUsage;
  window._showQuotaChip=showQuotaChip===true;
  window._showConversationOutline=showConversationOutline===true;
  document.documentElement.dataset.conversationOutline=window._showConversationOutline?'enabled':'disabled';
  if(typeof applyConversationOutlinePreference==='function') applyConversationOutlinePreference();
  window._showTps=showTps;
  window._fadeTextEffect=!!fadeTextEffect;
  window._showCliSessions=showCliSessions;
  window._soundEnabled=body.sound_enabled;
  window._notificationsEnabled=body.notifications_enabled;
  window._whatsNewSummaryEnabled=!!body.whats_new_summary_enabled;
  window._showThinking=body.show_thinking!==false;
  window._simplifiedToolCalling=true;
  _syncChatActivityDisplayModeControl(body.chat_activity_display_mode);
  window._terminalAutoExpandOnOutput=!!body.terminal_auto_expand_on_output;
  window._sessionJumpButtonsEnabled=!!body.session_jump_buttons;
  if(typeof _applySessionNavigationPrefs==='function') _applySessionNavigationPrefs();
  window._sidebarDensity=sidebarDensity==='detailed'?'detailed':'compact';
  window._busyInputMode=body.busy_input_mode||'queue';
  window._sessionEndlessScrollEnabled=!!body.session_endless_scroll;
  window._autoScrollFollow=body.auto_scroll_follow!==false;
  window._botName=body.bot_name||'Hermes';
  if(typeof applyBotName==='function') applyBotName();
  if(typeof setLocale==='function') setLocale(language);
  if(typeof applyLocaleToDOM==='function') applyLocaleToDOM();
  if(typeof startGatewaySSE==='function'){
    if(showCliSessions) startGatewaySSE();
    else if(typeof stopGatewaySSE==='function') stopGatewaySSE();
  }
  _setSettingsAuthButtonsVisible(!!saved.auth_enabled);
  _settingsDirty=false;
  _settingsThemeOnOpen=theme;
  _settingsSkinOnOpen=skin||'default';
  _settingsFontSizeOnOpen=fontSize||localStorage.getItem('hermes-font-size')||'default';
  const bar=$('settingsUnsavedBar');
  if(bar) bar.style.display='none';
  _settingsHermesDefaultModelOnOpen=body.default_model||_settingsHermesDefaultModelOnOpen||'';
  // Sync window._defaultModel so newSession() uses the just-saved default without a reload (#908).
  if(body.default_model) window._defaultModel=body.default_model;
  if(typeof clearMessageRenderCache==='function') clearMessageRenderCache();
  renderMessages();
  if(typeof syncTopbar==='function') syncTopbar();
  if(typeof renderSessionList==='function') renderSessionList();
}

async function checkUpdatesNow(){
  const btn=$('btnCheckUpdatesNow');
  const label=$('checkUpdatesLabel');
  const spinner=$('checkUpdatesSpinner');
  const status=$('checkUpdatesStatus');
  if(!btn||!label) return;
  btn.disabled=true;
  if(spinner) spinner.style.display='';
  if(label) label.textContent=t('settings_checking');
  if(status) status.textContent='';
  // 自动更新功能已移除
  if(status){status.textContent='自动更新功能已禁用';status.style.color='var(--muted)';}
  btn.disabled=false;
  if(spinner) spinner.style.display='none';
  if(label) label.textContent=t('settings_check_now');
}

// ── Auxiliary Models ──────────────────────────────────────────────────────────

// Canonical auxiliary task slots with display names.
// Keep in sync with hermes_cli/main.py _AUX_TASKS and hermes_cli/web_server.py _AUX_TASK_SLOTS.
const _AUX_TASK_SLOTS=[
 {key:'vision',name:'Vision',desc:'image/screenshot analysis'},
 {key:'compression',name:'Compression',desc:'context summarization'},
 {key:'web_extract',name:'Web extract',desc:'web page summarization'},
 {key:'session_search',name:'Session search',desc:'past-conversation recall'},
 {key:'approval',name:'Approval',desc:'smart command approval'},
 {key:'mcp',name:'MCP',desc:'MCP tool reasoning'},
 {key:'title_generation',name:'Title generation',desc:'session titles'},
 {key:'skills_hub',name:'Skills hub',desc:'skills search/install'},
 {key:'curator',name:'Curator',desc:'skill-usage review pass'},
];

let _auxProviders=[];       // cached provider list from /api/model/options
let _auxOriginalConfig=null; // snapshot of initial config for dirty detection

function _auxSelectStyle(){
 return 'width:100%;padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-size:12px;box-sizing:border-box';
}

function _buildAuxProviderOptions(sel,providers,currentProvider){
 sel.innerHTML='';
 // "auto" = use main model
 const autoOpt=document.createElement('option');
 autoOpt.value='auto';autoOpt.textContent='auto ('+t('settings_aux_provider_auto')+')';
 if(currentProvider==='auto'||!currentProvider) autoOpt.selected=true;
 sel.appendChild(autoOpt);
 for(const p of providers){
  const opt=document.createElement('option');
  opt.value=p.slug;opt.textContent=p.name;
  if(p.slug===currentProvider) opt.selected=true;
  sel.appendChild(opt);
 }
}

function _buildAuxModelOptions(sel,provider,providers,currentModel){
 sel.innerHTML='';
 const emptyOpt=document.createElement('option');
 emptyOpt.value='';emptyOpt.textContent=t('settings_aux_model_auto')||'auto (use provider default)';
 sel.appendChild(emptyOpt);
 if(!provider||provider==='auto'){
  sel.value=currentModel||'';
  return;
 }
 // Find matching provider in cached list
 const pData=providers.find(p=>p.slug===provider);
 if(pData&&pData.models){
  for(const mId of pData.models){
   const opt=document.createElement('option');
   opt.value=mId;opt.textContent=mId;
   if(mId===currentModel) opt.selected=true;
   sel.appendChild(opt);
  }
 }
 // Always allow custom model — add a text input option hint
 const customOpt=document.createElement('option');
 customOpt.value='__custom__';customOpt.textContent=t('settings_aux_model_custom')||'Custom model…';
 sel.appendChild(customOpt);
 // If currentModel not in list and not empty, add it as a custom option
 if(currentModel&&!pData?.models?.includes(currentModel)){
  const existingOpt=document.createElement('option');
  existingOpt.value=currentModel;existingOpt.textContent=currentModel+' (configured)';
  existingOpt.selected=true;
  sel.insertBefore(existingOpt,customOpt);
 }
}

function _onAuxProviderChange(taskKey,providers){
 const provSel=$('aux-prov-'+taskKey);
 const modelSel=$('aux-model-'+taskKey);
 if(!provSel||!modelSel) return;
 const provider=provSel.value;
 _buildAuxModelOptions(modelSel,provider,providers,'');
 _markAuxDirty();
}

async function _onAuxModelChange(taskKey){
 const modelSel=$('aux-model-'+taskKey);
 if(!modelSel) return;
 if(modelSel.value==='__custom__'){
  const customModel=await showPromptDialog({title:t('settings_aux_model_custom')||'Custom model',message:t('settings_aux_model_custom_prompt')||'Enter model ID:',placeholder:'model/provider:model-id',confirmLabel:t('settings_btn_apply_aux_models')||'Apply'});
  if(customModel&&customModel.trim()){
   // Insert custom model option before the __custom__ option
   const opt=document.createElement('option');
   opt.value=customModel.trim();opt.textContent=customModel.trim();
   // Remove __custom__ selection
   const customIdx=[...modelSel.options].findIndex(o=>o.value==='__custom__');
   if(customIdx>=0) modelSel.insertBefore(opt,modelSel.options[customIdx]);
   modelSel.value=customModel.trim();
  }else{
   modelSel.value='';
  }
 }
 _markAuxDirty();
}

function _markAuxDirty(){
 const applyBtn=$('btnApplyAuxModels');
 if(applyBtn) applyBtn.style.display='';
 _markSettingsDirty();
}

async function _loadAuxiliaryModels(){
 const container=$('auxModelsContainer');
 if(!container) return;
 container.innerHTML='<div style="color:var(--muted);font-size:12px">'+(t('settings_aux_loading')||'Loading…')+'</div>';

 try{
 // Fetch auxiliary config AND the WebUI's own /api/models for provider/model lists
 const [auxData,modelsData]=await Promise.all([
 api('/api/model/auxiliary').catch(()=>null),
 api('/api/models').catch(()=>null),
 ]);
 // Build provider list from /api/models groups
 // /api/models returns: { groups: [{ provider: str, provider_id: str, models: [{id,label}] }] }
 const groups=(modelsData&&modelsData.groups)||[];
 _auxProviders=groups.filter(g=>g.provider&&g.models&&g.models.length>0).map(g=>({
 slug:g.provider_id||g.provider,
 name:g.provider,
 models:g.models.map(m=>m.id),
 }));
 const tasks=(auxData&&auxData.tasks)||[];
  // Build a quick lookup: taskKey → {provider, model}
  const taskMap={};
  for(const t of tasks) taskMap[t.task]=t;
  _auxOriginalConfig=JSON.parse(JSON.stringify(taskMap));

  container.innerHTML='';
  for(const slot of _AUX_TASK_SLOTS){
   const cfg=taskMap[slot.key]||{provider:'auto',model:''};
   const row=document.createElement('div');
   row.style.cssText='display:grid;grid-template-columns:120px 1fr 1fr;gap:8px;align-items:center;margin-bottom:8px';

   // Task name + description
   const label=document.createElement('div');
   label.style.cssText='font-size:12px;font-weight:500;color:var(--text);line-height:1.3';
   const nameText=t('settings_aux_'+slot.key+'_name')||slot.name;
   const descText=t('settings_aux_'+slot.key+'_desc')||slot.desc;
   label.innerHTML=esc(nameText)+'<div style="font-size:10px;color:var(--muted);font-weight:400">'+esc(descText)+'</div>';
   row.appendChild(label);

   // Provider select
   const provSel=document.createElement('select');
   provSel.id='aux-prov-'+slot.key;
   provSel.style.cssText=_auxSelectStyle();
   _buildAuxProviderOptions(provSel,_auxProviders,cfg.provider);
   provSel.addEventListener('change',()=>_onAuxProviderChange(slot.key,_auxProviders));
   row.appendChild(provSel);

   // Model select
   const modelSel=document.createElement('select');
   modelSel.id='aux-model-'+slot.key;
   modelSel.style.cssText=_auxSelectStyle();
   _buildAuxModelOptions(modelSel,cfg.provider,_auxProviders,cfg.model);
   modelSel.addEventListener('change',()=>_onAuxModelChange(slot.key));
   row.appendChild(modelSel);

   container.appendChild(row);
  }
  // Hide apply button (no changes yet)
  const applyBtn=$('btnApplyAuxModels');
  if(applyBtn) applyBtn.style.display='none';

  // Reset button
  const resetBtn=$('btnResetAuxModels');
  if(resetBtn&&!resetBtn._bound){
   resetBtn._bound=true;
   resetBtn.addEventListener('click',async()=>{
    if(!(await showConfirmDialog({title:t('settings_aux_reset_confirm_title')||'Reset auxiliary models?',message:t('settings_aux_reset_confirm_msg')||'This will set all auxiliary tasks to auto (use main model).',confirmLabel:t('settings_btn_reset_aux_models')||'Reset',danger:true}))) return;
    try{
     await api('/api/model/set',{method:'POST',body:JSON.stringify({scope:'auxiliary',task:'__reset__',provider:'auto',model:''})});
     if(typeof showToast==='function') showToast(t('settings_aux_reset_done')||'Auxiliary models reset to auto');
     _loadAuxiliaryModels();
    }catch(e){
     if(typeof showToast==='function') showToast(t('settings_aux_save_failed')||'Failed to reset auxiliary models');
    }
   });
  }

  // Apply button
  if(applyBtn&&!applyBtn._bound){
   applyBtn._bound=true;
   applyBtn.addEventListener('click',_applyAuxModels);
  }
 }catch(e){
  console.warn('[settings] auxiliary models load failed',e);
  container.innerHTML='<div style="color:var(--muted);font-size:12px">'+(t('settings_aux_load_failed')||'Could not load auxiliary model settings. Make sure the agent API is available.')+'</div>';
 }
}

// Re-render dynamically generated labels when the locale changes so they
// update alongside static [data-i18n] elements.
window.addEventListener('localechange',()=>{
 if($('auxModelsContainer')) _loadAuxiliaryModels();
 if($('memoryPanel')) loadMemory();
});

async function _applyAuxModels(){
 let saved=0;
 for(const slot of _AUX_TASK_SLOTS){
  const provSel=$('aux-prov-'+slot.key);
  const modelSel=$('aux-model-'+slot.key);
  if(!provSel) continue;
  const provider=provSel.value;
  const model=(modelSel&&modelSel.value!=='__custom__')?(modelSel.value||''):'';
  const orig=_auxOriginalConfig?.[slot.key]||{provider:'auto',model:''};
  // Only save if changed
  if(provider!==orig.provider||model!==orig.model){
   try{
    await api('/api/model/set',{method:'POST',body:JSON.stringify({scope:'auxiliary',task:slot.key,provider,model})});
    saved++;
   }catch(e){
    console.warn('[settings] failed to save aux task',slot.key,e);
    if(typeof showToast==='function') showToast(t('settings_aux_save_failed')||'Failed to save auxiliary model for '+slot.name);
    return;
   }
  }
 }
 if(typeof showToast==='function') showToast(saved?(t('settings_aux_saved')||'Auxiliary models updated'):(t('settings_aux_no_changes')||'No changes to apply'));
 // Reload to refresh state
 _loadAuxiliaryModels();
}

async function saveSettings(andClose){
  const model=($('settingsModel')||{}).value;
  const modelChanged=(model||'')!==(_settingsHermesDefaultModelOnOpen||'');
  const sendKey=($('settingsSendKey')||{}).value;
  const showTokenUsage=!!($('settingsShowTokenUsage')||{}).checked;
  const showQuotaChip=!!($('settingsShowQuotaChip')||{}).checked;
  const showConversationOutline=!!($('settingsShowConversationOutline')||{}).checked;
  const showTps=!!($('settingsShowTps')||{}).checked;
  const fadeTextEffect=!!($('settingsFadeTextEffect')||{}).checked;
  const showCliSessions=!!($('settingsShowCliSessions')||{}).checked;
  const showCronSessions=!!($('settingsShowCronSessions')||{}).checked;
  const pw=($('settingsPassword')||{}).value;
  const theme=($('settingsTheme')||{}).value||'dark';
  const skin=($('settingsSkin')||{}).value||'default';
  const fontSize=($('settingsFontSize')||{}).value||localStorage.getItem('hermes-font-size')||'default';
  const language=($('settingsLanguage')||{}).value||'en';
  const sidebarDensity=($('settingsSidebarDensity')||{}).value==='detailed'?'detailed':'compact';
  const busyInputMode=($('settingsBusyInputMode')||{}).value||'queue';
  let aiRequestTimeout=parseInt(($('settingsAiRequestTimeout')||{}).value,10)||600;
  if(aiRequestTimeout<30) aiRequestTimeout=30;
  if(aiRequestTimeout>1800) aiRequestTimeout=1800;
  let maxIterations=parseInt(($('settingsMaxIterations')||{}).value,10)||0;
  if(maxIterations<0) maxIterations=0;
  if(maxIterations>200) maxIterations=200;
  const body={};

  if(sendKey) body.send_key=sendKey;
  body.theme=theme;
  body.skin=skin;
  body.font_size=fontSize;
  body.session_jump_buttons=!!($('settingsSessionJumpButtons')||{}).checked;
  body.session_endless_scroll=!!($('settingsSessionEndlessScroll')||{}).checked;
  body.chat_activity_display_mode=(($('settingsChatActivityDisplayMode')||{}).value==='transparent_stream')?'transparent_stream':'compact_worklog';
  body.auto_scroll_follow=!!($('settingsAutoScrollFollow')||{}).checked;
  body.language=language;
  body.show_token_usage=showTokenUsage;
  body.show_quota_chip=showQuotaChip===true;
  body.show_conversation_outline=showConversationOutline===true;
  body.show_tps=showTps;
  body.fade_text_effect=fadeTextEffect;
  body.terminal_auto_expand_on_output=!!($('settingsTerminalAutoExpand')||{}).checked;
  body.show_cli_sessions=showCliSessions;
  // Cron sessions are gated on CLI sessions (server short-circuits otherwise);
  // mirror the autosave path so the explicit Save Settings button persists it too. (#3514)
  body.show_cron_sessions=showCliSessions&&showCronSessions;
  body.sync_to_insights=!!($('settingsSyncInsights')||{}).checked;
  body.check_for_updates=!!($('settingsCheckUpdates')||{}).checked;
  body.whats_new_summary_enabled=!!($('settingsWhatsNewSummary')||{}).checked;
  body.sound_enabled=!!($('settingsSoundEnabled')||{}).checked;
  body.rtl=!!($('settingsRtl')||{}).checked;
  body.notifications_enabled=!!($('settingsNotificationsEnabled')||{}).checked;
  body.show_thinking=window._showThinking!==false;
  body.sidebar_density=sidebarDensity;
  body.busy_input_mode=busyInputMode;
  body.ai_request_timeout=aiRequestTimeout;
  body.max_iterations=maxIterations;
  body.auto_load_memory=!!($('settingsAutoLoadMemory')||{}).checked;
  body.auto_title_refresh_every=(($('settingsAutoTitleRefresh')||{}).value||'0');
  const botName=(($('settingsBotName')||{}).value||'').trim();
  body.bot_name=botName||'Hermes';
  // Password: only act if the field has content; blank = leave auth unchanged
  if(pw && pw.trim()){
    try{
      const saved=await api('/api/settings',{method:'POST',body:JSON.stringify({...body,_set_password:pw.trim()})});
      if(modelChanged && model){
        try{
          const _modelSel=$('settingsModel');
          const _opt=_modelSel.options[_modelSel.selectedIndex];
          const _provider=_opt?(_opt.parentNode&&_opt.parentNode.getAttribute('data-provider'))||'':'';
          await api('/api/default-model',{method:'POST',body:JSON.stringify({model,provider:_provider})});
          body.default_model=model;
        }catch(_modelErr){
          if(typeof showToast==='function') showToast('Failed to update default model — settings saved');
        }
      }
      _applySavedSettingsUi(saved, body, {sendKey,showTokenUsage,showQuotaChip,showConversationOutline,showTps,fadeTextEffect,showCliSessions,theme,skin,language,sidebarDensity,fontSize});
      showToast(t(saved.auth_just_enabled?'settings_saved_pw':'settings_saved_pw_updated'));
      _settingsDirty=false;
      _resetSettingsPanelState();
      if(!andClose) _pendingSettingsTargetPanel = null;
      if(andClose) _hideSettingsPanel();
      return;
    }catch(e){showToast(t('settings_save_failed')+e.message);return;}
  }
  try{
    const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(body)});
    if(modelChanged && model){
      try{
        const _modelSel=$('settingsModel');
        const _opt=_modelSel.options[_modelSel.selectedIndex];
        const _provider=_opt?(_opt.parentNode&&_opt.parentNode.getAttribute('data-provider'))||'':'';
        await api('/api/default-model',{method:'POST',body:JSON.stringify({model,provider:_provider})});
        body.default_model=model;
      }catch(_modelErr){
        if(typeof showToast==='function') showToast('Failed to update default model — settings saved');
      }
    }
    _applySavedSettingsUi(saved, body, {sendKey,showTokenUsage,showQuotaChip,showConversationOutline,showTps,fadeTextEffect,showCliSessions,theme,skin,language,sidebarDensity,fontSize});
    showToast(t('settings_saved'));
    _settingsDirty=false;
    _resetSettingsPanelState();
    if(!andClose) _pendingSettingsTargetPanel = null;
    if(andClose) _hideSettingsPanel();
  }catch(e){
    showToast(t('settings_save_failed')+e.message);
  }
}

async function signOut(){
  try{
    await api('/api/auth/logout',{method:'POST',body:'{}'});
    window.location.href='login';
  }catch(e){
    showToast(t('sign_out_failed')+e.message);
  }
}

async function goPasswordless(){
  const ok=await showConfirmDialog({title:'Go passwordless?',message:'This removes the password and keeps passkey sign-in enabled. Keep at least one passkey registered or you could lose access.',confirmLabel:'Go passwordless',danger:false,focusCancel:true});
  if(!ok) return;
  try{
    const saved=await api('/api/settings',{method:'POST',body:JSON.stringify({_passwordless:true})});
    showToast('Password removed. Passkey sign-in remains enabled.');
    _setSettingsAuthButtonsVisible(!!saved.auth_enabled);
    _syncPasswordlessButton({auth_enabled:saved.auth_enabled,password_auth_enabled:false,passkeys_count:1});
    const pwField=$('settingsPassword'); if(pwField) pwField.value='';
  }catch(e){showToast('Failed to go passwordless: '+e.message);}
}

async function disableAuth(){
  const _disAuth=await showConfirmDialog({title:t('disable_auth_confirm_title'),message:t('disable_auth_confirm_message'),confirmLabel:t('disable'),danger:true,focusCancel:true});
  if(!_disAuth) return;
  try{
    await api('/api/settings',{method:'POST',body:JSON.stringify({_clear_password:true})});
    showToast(t('auth_disabled'));
    // Hide auth controls since auth is now off
    const disableBtn=$('btnDisableAuth');
    if(disableBtn) disableBtn.style.display='none';
    const signOutBtn=$('btnSignOut');
    if(signOutBtn) signOutBtn.style.display='none';
    _syncPasswordlessButton({auth_enabled:false,password_auth_enabled:false,passkeys_count:0});
    loadPasskeys();
  }catch(e){
    showToast(t('disable_auth_failed')+e.message);
  }
}


// ── Cron completion alerts ────────────────────────────────────────────────────

let _cronPollSince=Date.now()/1000;  // track from page load
let _cronPollTimer=null;
let _cronUnreadCount=0;
const _cronNewJobIds=new Set();  // track which job IDs had new completions (unread)

// Auto-refresh the cron list when a job is created from chat or any external source.
// The chat path dispatches this event when the agent response mentions cron creation.
window.addEventListener('hermes:cron_created', () => {
  if ($('cronList')) loadCrons();
});

function startCronPolling(){
  if(_cronPollTimer) return;
  _cronPollTimer=setInterval(async()=>{
    if(document.hidden) return;  // don't poll when tab is in background
    try{
      const data=await api(`/api/crons/recent?since=${_cronPollSince}`);
      if(data.completions&&data.completions.length>0){
        for(const c of data.completions){
          if(c.toast_notifications !== false){
            showToast(t('cron_completion_status', c.name, c.status==='error' ? t('status_failed') : t('status_completed')),4000);
          }
          _cronPollSince=Math.max(_cronPollSince,c.completed_at);
          if(c.job_id) _cronNewJobIds.add(String(c.job_id));
        }
        // _cronUnreadCount is derived from _cronNewJobIds.size in updateCronBadge.
        updateCronBadge();
      }
    }catch(e){}
  },30000);
}

function updateCronBadge(){
  const tab=document.querySelector('.nav-tab[data-panel="tasks"]');
  if(!tab) return;
  let badge=tab.querySelector('.cron-badge');
  _cronUnreadCount=_cronNewJobIds.size;  // sync counter to set (source of truth)
  if(_cronUnreadCount>0){
    if(!badge){
      badge=document.createElement('span');
      badge.className='cron-badge';
      tab.style.position='relative';
      tab.appendChild(badge);
    }
    badge.textContent=_cronUnreadCount>9?'9+':_cronUnreadCount;
    badge.style.display='';
  }else if(badge){
    badge.style.display='none';
  }
}

// Clear cron badge only when all unread jobs have been viewed (not on panel open)
function _clearCronUnreadForJob(jobId){
  const id=String(jobId);
  if(_cronNewJobIds.has(id)){
    _cronNewJobIds.delete(id);
    updateCronBadge();  // re-derives _cronUnreadCount from set size
  }
}

const _origSwitchPanel=switchPanel;
switchPanel=async function(name,opts){ return _origSwitchPanel(name,opts); };

// Start polling on page load
startCronPolling();

// ── Background agent error tracking ──────────────────────────────────────────

const _backgroundErrors=[];  // {session_id, title, message, ts}

function trackBackgroundError(sessionId, title, message){
  // Only track if user is NOT currently viewing this session
  if(S.session&&S.session.session_id===sessionId) return;
  _backgroundErrors.push({session_id:sessionId, title:title||t('untitled'), message, ts:Date.now()});
  showErrorBanner();
}

function showErrorBanner(){
  let banner=$('bgErrorBanner');
  if(!banner){
    banner=document.createElement('div');
    banner.id='bgErrorBanner';
    banner.className='bg-error-banner';
    const msgs=document.querySelector('.messages');
    if(msgs) msgs.parentNode.insertBefore(banner,msgs);
    else document.body.appendChild(banner);
  }
  const latest=_backgroundErrors[0];  // FIFO: show oldest (first) error
  if(!latest){banner.style.display='none';return;}
  const count=_backgroundErrors.length;
  const msg=count>1?t('bg_error_multi',count):t('bg_error_single',latest.title);
  banner.innerHTML=`<span>\u26a0 ${esc(msg)}</span><div style="display:flex;gap:6px;flex-shrink:0"><button class="reconnect-btn" onclick="navigateToErrorSession()">${esc(t('view'))}</button><button class="reconnect-btn" onclick="dismissErrorBanner()">${esc(t('dismiss'))}</button></div>`;
  banner.style.display='';
}

function navigateToErrorSession(){
  const latest=_backgroundErrors.shift();  // FIFO: show oldest error first
  if(latest){
    loadSession(latest.session_id);renderSessionList();
  }
  if(_backgroundErrors.length===0) dismissErrorBanner();
  else showErrorBanner();
}

function dismissErrorBanner(){
  _backgroundErrors.length=0;
  const banner=$('bgErrorBanner');
  if(banner) banner.style.display='none';
}

// Event wiring


// ── MCP Server Management ──
function _mcpStatusLabel(status){
  const key={
    active:'mcp_status_active',
    configured:'mcp_status_configured',
    disabled:'mcp_status_disabled',
    invalid_config:'mcp_status_invalid_config',
    connected:'mcp_status_connected',
    failed:'mcp_status_failed',
    checking:'mcp_status_checking',
    'needs-auth':'mcp_status_needs_auth',
  }[status]||'mcp_status_unknown';
  return t(key);
}
function toggleMcpServer(name, enabled){
  api('/api/mcp/servers/'+encodeURIComponent(name)+'/toggle',{
    method:'POST',
    body:JSON.stringify({enabled:enabled}),
  }).then(r=>{
    if(r&&r.ok) showToast(t(enabled?'mcp_enabled_toast':'mcp_disabled_toast',name));
    else showToast(t('mcp_toggle_failed'),'error');
    loadMcpServers();
  }).catch(()=>{showToast(t('mcp_toggle_failed'),'error');loadMcpServers();});
}
let _mcpServersCache=[];
let _mcpStatusRefreshQueue=[];
let _mcpStatusRefreshActive=0;
const MCP_STATUS_REFRESH_CONCURRENCY=2;
function _mcpServerActionsHtml(s){
  const encodedName=encodeURIComponent(s.name).replace(/'/g,"\\'");
  const isEnabled=s.enabled!==false;
  const canEdit=s.can_edit!==false;
  const canDelete=s.can_delete!==false;
  const canReconnect=s.can_reconnect!==false;
  const canToggle=s.can_toggle!==false;
  const settingsBtn=canEdit?`<button type="button" class="mcp-action-btn mcp-settings-btn" onclick="event.stopPropagation();openMcpServerModal('${encodedName}')" title="${esc(t('mcp_edit'))}" aria-label="${esc(t('mcp_edit'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
    </button>`:'';
  const reconnectBtn=canReconnect?`<button type="button" class="mcp-action-btn mcp-reconnect-btn" onclick="event.stopPropagation();reconnectMcpServer('${encodedName}')" title="${esc(t('mcp_reconnect'))}" aria-label="${esc(t('mcp_reconnect'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
    </button>`:'';
  const deleteBtn=canDelete?`<button type="button" class="mcp-action-btn mcp-action-danger" onclick="event.stopPropagation();deleteMcpServer('${encodedName}')" title="${esc(t('mcp_delete'))}" aria-label="${esc(t('mcp_delete'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
    </button>`:'';
  const toggleBtn=canToggle?`<button type="button" class="mcp-toggle-switch ${isEnabled?'mcp-toggle-on':'mcp-toggle-off'}" role="switch" aria-checked="${isEnabled}" title="${esc(t(isEnabled?'mcp_disable_server':'mcp_enable_server'))}" onclick="event.stopPropagation();toggleMcpServer('${encodedName}',${!isEnabled})">
      <span class="mcp-toggle-thumb"></span>
    </button>`:'';
  return `<div class="mcp-server-actions">${settingsBtn}${reconnectBtn}${deleteBtn}${toggleBtn}</div>`;
}
function _mcpScopeLabel(scope){
  return t('mcp_scope_' + ((scope||'project')));
}
function _mcpScopeGroupKey(scope){
  const s=(scope||'').toLowerCase();
  if(s==='plugin') return 'plugin';
  if(s==='managed') return 'managed';
  if(s==='enterprise') return 'enterprise';
  if(s==='claudeai') return 'claudeai';
  if(s==='project'||s==='local'||s==='user') return s;
  return 'dynamic';
}
const MCP_SCOPE_ORDER=['plugin','user','project','local','managed','enterprise','claudeai','dynamic'];
function _mcpServerRowHtml(s){
  const transportLabel=s.transport==='sse'?'SSE':s.transport==='http'?'HTTP':s.transport==='stdio'?'STDIO':(''+(s.transport||'unknown'));
  const transportClass=s.transport==='http'||s.transport==='sse'?'mcp-http':s.transport==='stdio'?'mcp-stdio':'mcp-unknown';
  const scope=(s.scope||'project').toLowerCase();
  const scopeClass='mcp-scope-'+ (['project','local','user','dynamic'].includes(scope)?scope:'dynamic');
  const status=s.status||'configured';
  const encodedName=encodeURIComponent(s.name).replace(/'/g,"\\'");
  const summary=s.description
    ? s.description
    : (s.transport==='http'||s.transport==='sse'
        ? (s.url||'')
        : (s.transport==='stdio'?`${s.command||''} ${Array.isArray(s.args)?s.args.join(' '):''}`:t('mcp_status_invalid_config')));
  const statusDetail=s.status_detail?`<div class="mcp-server-status-detail" title="${esc(s.status_detail)}">${esc(s.status_detail)}</div>`:'';
  const projectPath=(scope==='local'||scope==='project')&&s.project_path?`<span class="mcp-project-path" title="${esc(s.project_path)}">${esc(s.project_path)}</span>`:'';
  const toolCount=s.tool_count===null||typeof s.tool_count==='undefined'?'—':String(s.tool_count);
  const featureBadges=[];
  if(s.has_oauth) featureBadges.push(`<span class="mcp-feature-badge mcp-feature-oauth" title="${esc(t('mcp_has_oauth'))}">OAuth</span>`);
  if(s.has_headers_helper) featureBadges.push(`<span class="mcp-feature-badge mcp-feature-helper" title="${esc(t('mcp_has_headers_helper'))}">Helper</span>`);
  const featureHtml=featureBadges.length?`<div class="mcp-server-features">${featureBadges.join('')}</div>`:'';
  return `<div class="mcp-server-row" data-mcp-name="${esc(s.name)}">
    <div class="mcp-server-main" onclick="openMcpServerDetail('${encodedName}')">
      <div class="mcp-server-row-head">
        <span class="mcp-server-name">${esc(s.name)}</span>
        <span class="mcp-status-badge mcp-status-${esc(status)}" data-mcp-status="${esc(s.name)}">${esc(_mcpStatusLabel(status))}</span>
      </div>
      <div class="mcp-server-meta">
        <span class="mcp-transport-badge ${transportClass}">${esc(transportLabel)}</span>
        <span class="mcp-scope-badge ${scopeClass}">${esc(_mcpScopeLabel(scope))}</span>
        ${projectPath}
        <span class="mcp-server-summary" title="${esc(summary)}">${esc(summary)}</span>
      </div>
      ${statusDetail}
      <div class="mcp-server-features-bar"><span class="mcp-tool-count">${esc(t('mcp_tool_count',toolCount))}</span>${featureHtml}</div>
    </div>
    ${_mcpServerActionsHtml(s)}
  </div>`;
}
function _updateMcpServerStatusBadge(name, status, detail){
  // 同步更新缓存中该 server 的 status，确保统计数字与实际状态一致
  if(Array.isArray(_mcpServersCache)){
    for(let i=0;i<_mcpServersCache.length;i++){
      if(_mcpServersCache[i]&&_mcpServersCache[i].name===name){
        _mcpServersCache[i].status=status||'configured';
        if(detail) _mcpServersCache[i].status_detail=detail;
        break;
      }
    }
  }
  const row=document.querySelector(`.mcp-server-row[data-mcp-name="${CSS.escape(name)}"]`);
  if(!row) return;
  const badge=row.querySelector('[data-mcp-status]');
  if(!badge) return;
  const safeStatus=status||'configured';
  badge.className=`mcp-status-badge mcp-status-${esc(safeStatus)}`;
  badge.textContent=_mcpStatusLabel(safeStatus);
  if(detail) badge.title=detail;
}
function _refreshMcpStatsCard(){
  // 根据最新缓存重新计算统计并更新顶部卡片
  const stats=_mcpServerStats(_mcpServersCache);
  const oldStats=document.querySelector('.mcp-stats');
  if(!oldStats) return;
  const temp=document.createElement('div');
  temp.innerHTML=_mcpStatsHtml(stats);
  const newStats=temp.firstElementChild;
  if(newStats) oldStats.replaceWith(newStats);
}
function _refreshMcpServerStatus(name){
  _mcpStatusRefreshQueue.push(name);
  _runMcpStatusRefreshQueue();
}
function _runMcpStatusRefreshQueue(){
  while(_mcpStatusRefreshActive<MCP_STATUS_REFRESH_CONCURRENCY && _mcpStatusRefreshQueue.length){
    const next=_mcpStatusRefreshQueue.shift();
    _mcpStatusRefreshActive++;
    api('/api/mcp/servers/'+encodeURIComponent(next)+'/status').then(r=>{
      if(r) _updateMcpServerStatusBadge(next, r.status, r.status_detail);
    }).catch(()=>{}).finally(()=>{
      _mcpStatusRefreshActive--;
      // 所有状态刷新完成后，重新计算统计并更新顶部卡片
      if(_mcpStatusRefreshQueue.length===0 && _mcpStatusRefreshActive===0){
        _refreshMcpStatsCard();
      }
      _runMcpStatusRefreshQueue();
    });
  }
}
function _mcpServerStats(servers){
  const arr=Array.isArray(servers)?servers:[];
  return {total:arr.length, connected:arr.filter(s=>s.status==='connected').length, attention:arr.filter(s=>s.status==='failed'||s.status==='needs-auth').length};
}
function _mcpStatsHtml(stats){
  const icon=(d)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">${d}</svg>`;
  return `<div class="mcp-stats">
    <div class="mcp-stat-card"><div class="mcp-stat-label">${icon('<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>')}${esc(t('mcp_stats_total'))}</div><div class="mcp-stat-value">${stats.total}</div></div>
    <div class="mcp-stat-card mcp-stat-connected"><div class="mcp-stat-label">${icon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>')}${esc(t('mcp_stats_connected'))}</div><div class="mcp-stat-value">${stats.connected}</div></div>
    <div class="mcp-stat-card mcp-stat-attention"><div class="mcp-stat-label">${icon('<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>')}${esc(t('mcp_stats_attention'))}</div><div class="mcp-stat-value">${stats.attention}</div></div>
  </div>`;
}
function loadMcpServers(){
  const list=$('mcpServerList');
  if(!list) return;
  list.innerHTML=`<div class="mcp-loading-state"><span class="mcp-spinner"></span><span>${esc(t('loading'))}</span></div>`;
  api('/api/mcp/servers').then(r=>{
    if(!r||!Array.isArray(r.servers)) return;
    _mcpServersCache=r.servers;
    if(!r.servers.length){
      list.innerHTML=`<div class="mcp-empty-state"><div class="mcp-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></div><div class="mcp-empty-title">${esc(t('mcp_no_servers'))}</div></div>`;
      return;
    }
    const stats=_mcpServerStats(r.servers);
    const groups={};
    r.servers.forEach(s=>{ const k=_mcpScopeGroupKey(s.scope); groups[k]=groups[k]||[]; groups[k].push(s); });
    let html=_mcpStatsHtml(stats);
    MCP_SCOPE_ORDER.forEach(key=>{
      const arr=groups[key];
      if(!arr||!arr.length) return;
      html+=`<div class="mcp-group">
        <div class="mcp-group-header"><span class="mcp-group-title">${esc(t('mcp_scope_group_'+key))}</span><span class="mcp-group-count">${arr.length}</span></div>
        <div class="mcp-group-list">${arr.map(s=>_mcpServerRowHtml(s)).join('')}</div>
      </div>`;
    });
    list.innerHTML=html;
    r.servers.forEach(s=>{ if(s.enabled && s.status!=='disabled') _refreshMcpServerStatus(s.name); });
  }).catch(()=>{list.innerHTML=`<div class="mcp-error-state"><div>${esc(t('mcp_load_failed'))}</div><button type="button" class="mcp-retry-btn" onclick="loadMcpServers()">${esc(t('retry'))}</button></div>`});
}
let _mcpModalEditingName=null;
function _mcpModalTransport(){
  const active=document.querySelector('#mcpServerModal .mcp-modal-tab.active');
  return active?active.dataset.transport:'stdio';
}
function _setMcpModalTransport(transport){
  const tabs=document.querySelectorAll('#mcpServerModal .mcp-modal-tab');
  tabs.forEach(t=>t.classList.toggle('active', t.dataset.transport===transport));
  const stdioFields=$('mcpStdioFields');
  const httpFields=$('mcpHttpFields');
  if(stdioFields) stdioFields.hidden=(transport!=='stdio');
  if(httpFields) httpFields.hidden=(transport==='stdio');
  // 更新传输模式提示文本
  const hint=$('mcpTransportHint');
  if(hint){
    if(transport==='stdio'){
      hint.textContent=t('mcp_transport_hint_stdio')||'通过子进程标准输入/输出通信，适用于本地 MCP 服务器。';
    }else if(transport==='http'){
      hint.textContent=t('mcp_transport_hint_http')||'Streamable HTTP 传输（推荐）。单一端点，POST JSON-RPC 请求。';
    }else if(transport==='sse'){
      hint.textContent=t('mcp_transport_hint_sse')||'SSE 传输（旧版兼容）。后端将自动以 Streamable HTTP 方式连接。';
    }
  }
  // 根据传输模式更新 URL 占位符
  const urlInput=$('mcpModalUrl');
  if(urlInput){
    if(transport==='sse'){
      urlInput.placeholder='http://127.0.0.1:3000/sse';
    }else{
      urlInput.placeholder='http://127.0.0.1:3000/mcp';
    }
  }
}
function switchMcpTransport(transport){
  _setMcpModalTransport(transport);
}
function _mcpModalScope(){
  const active=document.querySelector('#mcpServerModal .mcp-scope-card.active');
  return active?active.dataset.scope:'project';
}
function _setMcpModalScope(scope){
  const wanted=scope||'project';
  document.querySelectorAll('#mcpServerModal .mcp-scope-card').forEach(card=>{
    card.classList.toggle('active', card.dataset.scope===wanted);
  });
  const projectFields=$('mcpProjectPathFields');
  if(projectFields) projectFields.hidden=!(wanted==='local'||wanted==='project');
  const hint=$('mcpProjectPathHint');
  if(hint){
    if(wanted==='local') hint.textContent=t('mcp_project_path_hint_local');
    else if(wanted==='project') hint.textContent=t('mcp_project_path_hint_project');
    else hint.textContent=t('mcp_project_path_hint_global');
  }
}
function switchMcpScope(scope){
  _setMcpModalScope(scope);
}
function _clearMcpKvList(id){
  const list=$(id);
  if(list) list.innerHTML='';
}
function _addMcpKvRow(id, key, value){
  const list=$(id);
  if(!list) return;
  const row=document.createElement('div');
  row.className='mcp-kv-row';
  row.innerHTML=`<input type="text" placeholder="KEY" value="${esc(key||'')}"><input type="text" placeholder="VALUE" value="${esc(value||'')}"><button type="button" class="mcp-action-btn" onclick="this.parentElement.remove()" title="${esc(t('mcp_remove'))}">−</button>`;
  list.appendChild(row);
}
function addMcpEnvRow(key, value){ _addMcpKvRow('mcpModalEnvList', key, value); }
function addMcpHeaderRow(key, value){
  const list=$('mcpModalHeadersList');
  if(!list) return;
  const row=document.createElement('div');
  row.className='mcp-kv-row';
  row.innerHTML=`<input type="text" placeholder="Header 名称（如 Authorization）" value="${esc(key||'')}"><input type="text" placeholder="值（如 Bearer xxx）" value="${esc(value||'')}"><button type="button" class="mcp-action-btn" onclick="this.parentElement.remove()" title="${esc(t('mcp_remove'))}">−</button>`;
  list.appendChild(row);
}
function _addMcpArgRow(value){
  const list=$('mcpModalArgsList');
  if(!list) return;
  const row=document.createElement('div');
  row.className='mcp-arg-row';
  row.innerHTML=`<input type="text" placeholder="${esc(t('mcp_argument_placeholder'))}" value="${esc(value||'')}"><button type="button" class="mcp-action-btn" onclick="this.parentElement.remove()" title="${esc(t('mcp_remove'))}">−</button>`;
  list.appendChild(row);
}
function addMcpArgRow(value){ _addMcpArgRow(value); }
function _collectMcpArgRows(){
  const list=$('mcpModalArgsList');
  if(!list) return [];
  const out=[];
  list.querySelectorAll('.mcp-arg-row input').forEach(input=>{
    const v=(input.value||'').trim();
    if(v) out.push(v);
  });
  return out;
}
function pickMcpProjectPath(){
  if(window.showDirectoryPicker){
    window.showDirectoryPicker().then(handle=>{
      const input=$('mcpModalProjectPath');
      if(input) input.value=handle.name;
    }).catch(()=>{});
    return;
  }
  let input=document.getElementById('mcpHiddenDirPicker');
  if(!input){
    input=document.createElement('input');
    input.type='file';
    input.id='mcpHiddenDirPicker';
    input.setAttribute('webkitdirectory','');
    input.setAttribute('directory','');
    input.style.display='none';
    document.body.appendChild(input);
    input.addEventListener('change', ()=>{
      const files=input.files;
      const dest=$('mcpModalProjectPath');
      if(dest&&files&&files.length){
        const first=files[0];
        let path=first.webkitRelativePath||first.name;
        const slash=path.indexOf('/');
        if(slash>=0) path=path.slice(0, slash);
        dest.value=path;
      }
      input.value='';
    });
  }
  input.click();
}
function _collectMcpKvRows(id){
  const list=$(id);
  if(!list) return {};
  const out={};
  list.querySelectorAll('.mcp-kv-row').forEach(row=>{
    const inputs=row.querySelectorAll('input');
    const k=(inputs[0]&&inputs[0].value||'').trim();
    const v=(inputs[1]&&inputs[1].value||'');
    if(k) out[k]=v;
  });
  return out;
}
function _setMcpModalError(msg){
  const el=$('mcpModalError');
  if(el) el.textContent=msg||'';
}
function closeMcpServerModal(){
  const modal=$('mcpServerModal');
  if(modal) modal.hidden=true;
  _mcpModalEditingName=null;
}
function openMcpServerModal(name){
  const modal=$('mcpServerModal');
  const title=$('mcpServerModalTitle');
  const deleteBtn=$('mcpModalDelete');
  const nameInput=$('mcpModalName');
  if(!modal) return;
  _mcpModalEditingName=name||null;
  _setMcpModalError('');
  if(nameInput) nameInput.disabled=!!name;
  if(name){
    if(title) title.textContent=t('mcp_modal_edit_title');
    if(deleteBtn) deleteBtn.hidden=false;
    const s=_mcpServersCache.find(x=>x.name===name);
    if(s){
      nameInput.value=s.name;
      const transport=s.transport||'stdio';
      _setMcpModalTransport(transport);
      _setMcpModalScope(s.scope||'project');
      if($('mcpModalDescription')) $('mcpModalDescription').value=s.description||'';
      if($('mcpModalProjectPath')) $('mcpModalProjectPath').value=s.project_path||'';
      if($('mcpModalCommand')) $('mcpModalCommand').value=s.command||'';
      _clearMcpKvList('mcpModalArgsList');
      if(Array.isArray(s.args)&&s.args.length){ s.args.forEach(v=>_addMcpArgRow(String(v))); }
      else { _addMcpArgRow(''); }
      if($('mcpModalUrl')) $('mcpModalUrl').value=s.url||'';
      if($('mcpModalTimeout')) $('mcpModalTimeout').value=s.timeout||120;
      if($('mcpModalConnectTimeout')) $('mcpModalConnectTimeout').value=s.connect_timeout||60;
      if($('mcpModalEnabled')) $('mcpModalEnabled').checked=s.enabled!==false;
      _clearMcpKvList('mcpModalEnvList');
      _clearMcpKvList('mcpModalHeadersList');
      if(s.env){ Object.entries(s.env).forEach(([k,v])=>addMcpEnvRow(k, String(v))); }
      if(s.headers){ Object.entries(s.headers).forEach(([k,v])=>addMcpHeaderRow(k, String(v))); }
      const oauth=s.oauth||{};
      if($('mcpModalOAuthClientId')) $('mcpModalOAuthClientId').value=oauth.client_id||oauth.clientId||'';
      if($('mcpModalOAuthCallbackPort')) $('mcpModalOAuthCallbackPort').value=oauth.callback_port||oauth.callbackPort||'';
      if($('mcpModalHeadersHelper')) $('mcpModalHeadersHelper').value=s.headers_helper||'';
    }
  } else {
    if(title) title.textContent=t('mcp_modal_add_title');
    if(deleteBtn) deleteBtn.hidden=true;
    if(nameInput){ nameInput.value=''; nameInput.disabled=false; }
    _setMcpModalTransport('stdio');
    _setMcpModalScope('project');
    if($('mcpModalDescription')) $('mcpModalDescription').value='';
    if($('mcpModalProjectPath')) $('mcpModalProjectPath').value='';
    if($('mcpModalCommand')) $('mcpModalCommand').value='';
    _clearMcpKvList('mcpModalArgsList');
    _addMcpArgRow('');
    if($('mcpModalUrl')) $('mcpModalUrl').value='';
    if($('mcpModalTimeout')) $('mcpModalTimeout').value=120;
    if($('mcpModalConnectTimeout')) $('mcpModalConnectTimeout').value=60;
    if($('mcpModalEnabled')) $('mcpModalEnabled').checked=true;
    _clearMcpKvList('mcpModalEnvList');
    _clearMcpKvList('mcpModalHeadersList');
    if($('mcpModalOAuthClientId')) $('mcpModalOAuthClientId').value='';
    if($('mcpModalOAuthCallbackPort')) $('mcpModalOAuthCallbackPort').value='';
    if($('mcpModalHeadersHelper')) $('mcpModalHeadersHelper').value='';
  }
  modal.hidden=false;
}
function saveMcpServerFromModal(){
  _setMcpModalError('');
  const nameInput=$('mcpModalName');
  const name=(nameInput&&nameInput.value||'').trim();
  if(!name){ _setMcpModalError(t('mcp_name_required')); return; }
  if(!/^[a-zA-Z0-9_-]+$/.test(name)){ _setMcpModalError(t('mcp_name_invalid')); return; }
  const transport=_mcpModalTransport();
  const scope=_mcpModalScope();
  const body={
    name:name,
    transport:transport,
    scope:scope,
    enabled:$('mcpModalEnabled')?$('mcpModalEnabled').checked:true,
    timeout:Number($('mcpModalTimeout')?$('mcpModalTimeout').value:120)||120,
    connect_timeout:Number($('mcpModalConnectTimeout')?$('mcpModalConnectTimeout').value:60)||60,
  };
  const description=($('mcpModalDescription')&&$('mcpModalDescription').value||'').trim();
  if(description) body.description=description;
  if(scope==='local'||scope==='project'){
    const projectPath=($('mcpModalProjectPath')&&$('mcpModalProjectPath').value||'').trim();
    if(projectPath) body.project_path=projectPath;
  }
  if(transport==='http'||transport==='sse'){
    const url=($('mcpModalUrl')&&$('mcpModalUrl').value||'').trim();
    if(!url){ _setMcpModalError(t('mcp_url_required')); return; }
    body.url=url;
    const headers=_collectMcpKvRows('mcpModalHeadersList');
    if(Object.keys(headers).length) body.headers=headers;
    const headersHelper=($('mcpModalHeadersHelper')&&$('mcpModalHeadersHelper').value||'').trim();
    if(headersHelper) body.headers_helper=headersHelper;
    const oauthClientId=($('mcpModalOAuthClientId')&&$('mcpModalOAuthClientId').value||'').trim();
    const oauthCallbackPort=($('mcpModalOAuthCallbackPort')&&$('mcpModalOAuthCallbackPort').value||'').trim();
    if(oauthClientId||oauthCallbackPort){
      body.oauth={};
      if(oauthClientId) body.oauth.client_id=oauthClientId;
      if(oauthCallbackPort) body.oauth.callback_port=Number(oauthCallbackPort);
    }
  } else {
    const command=($('mcpModalCommand')&&$('mcpModalCommand').value||'').trim();
    if(!command){ _setMcpModalError(t('mcp_command_required')); return; }
    body.command=command;
    const args=_collectMcpArgRows();
    if(args.length) body.args=args;
    const env=_collectMcpKvRows('mcpModalEnvList');
    if(Object.keys(env).length) body.env=env;
  }
  const url=_mcpModalEditingName?('/api/mcp/servers/'+encodeURIComponent(_mcpModalEditingName)):'/api/mcp/servers';
  const method=_mcpModalEditingName?'PUT':'POST';
  api(url,{method:method, body:JSON.stringify(body)}).then(r=>{
    if(r && r.server){
      showToast(t('mcp_saved'));
      closeMcpServerModal();
      loadMcpServers();
    } else if(r && r.error){
      _setMcpModalError(r.error);
    } else {
      _setMcpModalError(t('mcp_save_failed'));
    }
  }).catch(()=>{ _setMcpModalError(t('mcp_save_failed')); });
}
function deleteMcpServer(name){
  if(!confirm(t('mcp_delete_confirm_message', name))) return;
  api('/api/mcp/servers/'+encodeURIComponent(name),{method:'DELETE'}).then(r=>{
    if(r&&r.ok){ showToast(t('mcp_deleted')); loadMcpServers(); }
    else showToast(t('mcp_delete_failed'),'error');
  }).catch(()=>showToast(t('mcp_delete_failed'),'error'));
}
function deleteMcpServerFromModal(){
  if(_mcpModalEditingName) deleteMcpServer(_mcpModalEditingName);
}
function reconnectMcpServer(name){
  showToast(t('mcp_reconnecting', name));
  api('/api/mcp/servers/'+encodeURIComponent(name)+'/reconnect',{method:'POST'}).then(r=>{
    if(r && r.reconnected){
      showToast(t('mcp_reconnected', name));
    } else {
      const detail=(r && r.status_detail) || '';
      showToast(t('mcp_reconnect_failed', name)+(detail?': '+detail:''),'error');
    }
    if(r) _updateMcpServerStatusBadge(name, r.status, r.status_detail);
  }).catch(()=>showToast(t('mcp_reconnect_failed', name),'error'));
}
let _mcpDetailServerName=null;
let _mcpDetailTab='info';
function closeMcpServerDetail(){
  const modal=$('mcpServerDetailModal');
  if(modal) modal.hidden=true;
  _mcpDetailServerName=null;
}
function openMcpServerDetail(name){
  const modal=$('mcpServerDetailModal');
  if(!modal) return;
  const s=_mcpServersCache.find(x=>x.name===name);
  if(!s) return;
  _mcpDetailServerName=name;
  _mcpDetailTab='info';
  _renderMcpServerDetail();
  modal.hidden=false;
}
function switchMcpDetailTab(tab){
  _mcpDetailTab=tab;
  _renderMcpServerDetail();
}
function _renderMcpServerDetail(){
  const modal=$('mcpServerDetailModal');
  const s=_mcpServersCache.find(x=>x.name===_mcpDetailServerName);
  if(!modal||!s){ closeMcpServerDetail(); return; }
  const title=$('mcpDetailTitle'); if(title) title.textContent=s.name;
  const status=s.status||'configured';
  const badge=$('mcpDetailStatus');
  if(badge){ badge.className='mcp-status-badge mcp-status-'+esc(status); badge.textContent=_mcpStatusLabel(status); if(s.status_detail) badge.title=s.status_detail; }
  document.querySelectorAll('#mcpServerDetailModal .mcp-detail-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===_mcpDetailTab));
  const body=$('mcpDetailBody'); if(!body) return;
  if(_mcpDetailTab==='info') body.innerHTML=_mcpDetailInfoHtml(s);
  else if(_mcpDetailTab==='tools') _loadMcpDetailTools(s, body);
  else if(_mcpDetailTab==='resources') _loadMcpDetailResources(s, body);
  else if(_mcpDetailTab==='prompts') _loadMcpDetailPrompts(s, body);
}
function _mcpDetailInfoHtml(s){
  const rows=[];
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_transport'))}</span><span class="mcp-detail-info-value">${esc(s.transport||'')}</span></div>`);
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_scope'))}</span><span class="mcp-detail-info-value">${esc(_mcpScopeLabel(s.scope))}</span></div>`);
  if((s.scope==='local'||s.scope==='project')&&s.project_path) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_project_path'))}</span><span class="mcp-detail-info-value">${esc(s.project_path)}</span></div>`);
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_enabled'))}</span><span class="mcp-detail-info-value">${esc(s.enabled!==false?t('mcp_enabled_yes'):t('mcp_enabled_no'))}</span></div>`);
  if(s.status_detail) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_status_detail'))}</span><span class="mcp-detail-info-value">${esc(s.status_detail)}</span></div>`);
  if(s.description) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_description'))}</span><span class="mcp-detail-info-value">${esc(s.description)}</span></div>`);
  if(s.url) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_url'))}</span><span class="mcp-detail-info-value">${esc(s.url)}</span></div>`);
  if(s.command) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_command'))}</span><span class="mcp-detail-info-value">${esc(s.command)}</span></div>`);
  if(Array.isArray(s.args)&&s.args.length) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_args'))}</span><span class="mcp-detail-info-value">${esc(s.args.join(' '))}</span></div>`);
  if(s.headers&&Object.keys(s.headers).length) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_headers'))}</span><span class="mcp-detail-info-value">${esc(Object.entries(s.headers).map(([k,v])=>`${k}=${v}`).join(', '))}</span></div>`);
  if(s.env&&Object.keys(s.env).length) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_env'))}</span><span class="mcp-detail-info-value">${esc(Object.entries(s.env).map(([k,v])=>`${k}=${v}`).join(', '))}</span></div>`);
  if(s.headers_helper) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_headers_helper'))}</span><span class="mcp-detail-info-value"><code>${esc(s.headers_helper)}</code></span></div>`);
  if(s.has_oauth) rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_oauth'))}</span><span class="mcp-detail-info-value">${esc(t('mcp_has_oauth'))}</span></div>`);
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_timeout'))}</span><span class="mcp-detail-info-value">${esc(String(s.timeout||120))}</span></div>`);
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_field_connect_timeout'))}</span><span class="mcp-detail-info-value">${esc(String(s.connect_timeout||60))}</span></div>`);
  const raw=s.config||s;
  rows.push(`<div class="mcp-detail-info-row"><span class="mcp-detail-info-label">${esc(t('mcp_raw_config'))}</span><pre class="mcp-detail-info-value mcp-raw-config">${esc(JSON.stringify(raw, null, 2))}</pre></div>`);
  return `<div class="mcp-detail-info">${rows.join('')}</div>`;
}
function _loadMcpDetailTools(s, body){
  body.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('loading'))}</div>`;
  const render=(tools)=>{
    const filtered=(Array.isArray(tools)?tools:[]).filter(t=>t.server===s.name);
    if(!filtered.length){ body.innerHTML=`<div class="mcp-detail-empty" style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('mcp_detail_no_tools'))}</div>`; return; }
    body.innerHTML=filtered.map(tool=>{
      const status=tool.status||'unknown';
      return `<div class="mcp-tool-row">
        <div class="mcp-server-row-head"><span class="mcp-tool-name">${esc(tool.name)}</span><span class="mcp-status-badge mcp-status-${esc(status)}">${esc(_mcpStatusLabel(status))}</span></div>
        <div class="mcp-server-detail">${esc(tool.description||'')}</div>
        <pre class="mcp-tool-schema">${esc(_mcpToolSchemaText(tool.schema_summary))}</pre>
      </div>`;
    }).join('');
  };
  if(_mcpToolsCache.length){ render(_mcpToolsCache); }
  else { api('/api/mcp/tools').then(r=>{ _mcpToolsCache=(r&&Array.isArray(r.tools))?r.tools:[]; _mcpToolsMeta=r||{}; render(_mcpToolsCache); }).catch(()=>{ body.innerHTML=`<div style="color:#ef4444;font-size:12px">${esc(t('mcp_tools_load_failed'))}</div>`; }); }
}
function _loadMcpDetailResources(s, body){
  body.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('loading'))}</div>`;
  api('/api/mcp/servers/'+encodeURIComponent(s.name)+'/resources').then(r=>{
    const items=(r&&Array.isArray(r.resources))?r.resources:[];
    if(!items.length){ body.innerHTML=`<div class="mcp-detail-empty" style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('mcp_detail_no_resources'))}</div>`; return; }
    body.innerHTML=items.map(item=>`<div class="mcp-tool-row">
      <div class="mcp-server-row-head"><span class="mcp-tool-name">${esc(item.name||'')}</span><span class="mcp-tool-server">${esc(item.uri||'')}</span></div>
      <div class="mcp-server-detail">${esc(item.description||'')}</div>
    </div>`).join('');
  }).catch(()=>{ body.innerHTML=`<div style="color:#ef4444;font-size:12px">${esc(t('mcp_detail_resources_failed'))}</div>`; });
}
function _loadMcpDetailPrompts(s, body){
  body.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('loading'))}</div>`;
  api('/api/mcp/servers/'+encodeURIComponent(s.name)+'/prompts').then(r=>{
    const items=(r&&Array.isArray(r.prompts))?r.prompts:[];
    if(!items.length){ body.innerHTML=`<div class="mcp-detail-empty" style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('mcp_detail_no_prompts'))}</div>`; return; }
    body.innerHTML=items.map(item=>`<div class="mcp-tool-row">
      <div class="mcp-server-row-head"><span class="mcp-tool-name">${esc(item.name||'')}</span></div>
      <div class="mcp-server-detail">${esc(item.description||'')}</div>
    </div>`).join('');
  }).catch(()=>{ body.innerHTML=`<div style="color:#ef4444;font-size:12px">${esc(t('mcp_detail_prompts_failed'))}</div>`; });
}
let _mcpToolsCache=[];
let _mcpToolsMeta={};
let _mcpToolsPage=1;
let _mcpToolsPageSize=5;
const MCP_TOOLS_PAGE_SIZE_OPTIONS=[5,10,20,40];
function _filterMcpToolsForSearch(tools, query){
  const q=(query||'').trim().toLowerCase();
  if(!q) return Array.isArray(tools)?tools:[];
  return (Array.isArray(tools)?tools:[]).filter(tool=>{
    const hay=[tool.name,tool.server,tool.description].map(v=>String(v||'').toLowerCase()).join(' ');
    return hay.includes(q);
  });
}
function _mcpToolSchemaText(schemaSummary){
  if(!Array.isArray(schemaSummary)||!schemaSummary.length) return t('mcp_tools_schema_empty');
  return schemaSummary.map(p=>{
    const req=p.required?'*':'';
    const desc=p.description?` — ${p.description}`:'';
    return `${p.name}${req}: ${p.type||'unknown'}${desc}`;
  }).join('\n');
}
function _mcpToolsSummary(total, filtered, page, pages, query){
  const trimmedQuery=(query||'').trim();
  if(!filtered){
    if(trimmedQuery) return t('mcp_tools_summary_no_matches',trimmedQuery,total);
    return total?t('mcp_tools_summary_none'):'';
  }
  const pageSize=_mcpToolsPageSize||5;
  const start=(page-1)*pageSize+1;
  const end=Math.min(filtered,page*pageSize);
  const searchNote=trimmedQuery?t('mcp_tools_summary_matching',trimmedQuery):'';
  const totalNote=filtered===total?'':t('mcp_tools_summary_total_note',total);
  return t('mcp_tools_summary_showing',start,end,filtered,searchNote,totalNote,page,pages);
}
function _mcpToolPageSizeControl(){
  const options=MCP_TOOLS_PAGE_SIZE_OPTIONS.map(size=>`<option value="${size}" ${size===_mcpToolsPageSize?'selected':''}>${size}</option>`).join('');
  return `<label class="mcp-tool-page-size">${esc(t('mcp_tools_page_size_prefix'))} <select aria-label="${esc(t('mcp_tools_per_page_aria'))}" onchange="setMcpToolsPageSize(this.value)">${options}</select> ${esc(t('mcp_tools_page_size_suffix'))}</label>`;
}
function _mcpToolsEmptyMessage(query){
  const base=esc(t(query?'mcp_tools_no_matches':'mcp_tools_no_tools'));
  const unavailable=Array.isArray(_mcpToolsMeta.unavailable_servers)?_mcpToolsMeta.unavailable_servers:[];
  if(query||!unavailable.length) return base;
  return `${base}<br><span class="mcp-tool-empty-detail">${esc(t('mcp_tools_inactive_configured_servers',unavailable.join(', ')))}</span>`;
}
function _renderMcpToolPager(filteredCount, page, pages){
  const pager=$('mcpToolPager');
  if(!pager) return;
  if(pages<=1){
    pager.innerHTML='';
    return;
  }
  pager.innerHTML=`<button type="button" class="mcp-tool-page-btn" onclick="setMcpToolsPage(${page-1})" ${page<=1?'disabled':''} aria-label="${esc(t('mcp_tools_previous_page_aria'))}">${esc(t('mcp_tools_previous_page'))}</button>
    <span class="mcp-tool-page-label">${page} / ${pages}</span>
    <button type="button" class="mcp-tool-page-btn" onclick="setMcpToolsPage(${page+1})" ${page>=pages?'disabled':''} aria-label="${esc(t('mcp_tools_next_page_aria'))}">${esc(t('mcp_tools_next_page'))}</button>`;
}
function _renderMcpTools(tools, query){
  const list=$('mcpToolList');
  const toolbar=$('mcpToolToolbar');
  if(!list) return;
  const filtered=_filterMcpToolsForSearch(tools, query);
  const total=Array.isArray(tools)?tools.length:0;
  const pages=Math.max(1,Math.ceil(filtered.length/_mcpToolsPageSize));
  _mcpToolsPage=Math.min(Math.max(1,_mcpToolsPage||1),pages);
  if(toolbar) toolbar.innerHTML=`<span class="mcp-tool-summary">${esc(_mcpToolsSummary(total,filtered.length,_mcpToolsPage,pages,query))}</span>${_mcpToolPageSizeControl()}`;
  _renderMcpToolPager(filtered.length,_mcpToolsPage,pages);
  if(!filtered.length){
    list.innerHTML=`<div class="mcp-tool-empty-state" style="color:var(--muted);font-size:12px;padding:6px 0">${_mcpToolsEmptyMessage(query)}</div>`;
    return;
  }
  const visible=filtered.slice((_mcpToolsPage-1)*_mcpToolsPageSize,_mcpToolsPage*_mcpToolsPageSize);
  list.innerHTML=visible.map(tool=>{
    const status=tool.status||'unknown';
    const statusBadge=`<span class="mcp-status-badge mcp-status-${esc(status)}">${esc(_mcpStatusLabel(status))}</span>`;
    const schemaText=_mcpToolSchemaText(tool.schema_summary);
    return `<div class="mcp-tool-row">
      <div class="mcp-server-row-head">
        <span class="mcp-tool-name">${esc(tool.name)}</span>
        <span class="mcp-tool-server">${esc(tool.server||'unknown')}</span>
        ${statusBadge}
      </div>
      <div class="mcp-server-detail">${esc(tool.description||'')}</div>
      <pre class="mcp-tool-schema">${esc(schemaText)}</pre>
    </div>`;
  }).join('');
}
function setMcpToolsPage(page){
  _mcpToolsPage=page;
  const input=$('mcpToolSearch');
  _renderMcpTools(_mcpToolsCache,input?input.value:'');
  const list=$('mcpToolList');
  if(list) list.scrollTop=0;
}
function setMcpToolsPageSize(size){
  const next=Number(size);
  if(!MCP_TOOLS_PAGE_SIZE_OPTIONS.includes(next)) return;
  _mcpToolsPageSize=next;
  _mcpToolsPage=1;
  const input=$('mcpToolSearch');
  _renderMcpTools(_mcpToolsCache,input?input.value:'');
  const list=$('mcpToolList');
  if(list) list.scrollTop=0;
}
function filterMcpTools(){
  _mcpToolsPage=1;
  const input=$('mcpToolSearch');
  _renderMcpTools(_mcpToolsCache,input?input.value:'');
  const list=$('mcpToolList');
  if(list) list.scrollTop=0;
}
function loadMcpTools(){
  const list=$('mcpToolList');
  const toolbar=$('mcpToolToolbar');
  const pager=$('mcpToolPager');
  if(!list) return;
  if(toolbar) toolbar.textContent='';
  if(pager) pager.innerHTML='';
  list.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:6px 0">${esc(t('loading'))}</div>`;
  api('/api/mcp/tools').then(r=>{
    _mcpToolsCache=(r&&Array.isArray(r.tools))?r.tools:[];
    _mcpToolsMeta=r||{};
    _mcpToolsPage=1;
    filterMcpTools();
  }).catch(()=>{list.innerHTML=`<div class="mcp-tool-error-state" style="color:#ef4444;font-size:12px;padding:6px 0">${esc(t('mcp_tools_load_failed'))}</div>`});
}
// Load MCP servers when system settings tab opens
const _origSwitchSettings=switchSettingsSection;
switchSettingsSection=function(name){
  _origSwitchSettings(name);
  if(name==='preferences') updateNotificationPermissionStatus();
  if(name==='system'){loadMcpServers();loadMcpTools();}
};

// ── Checkpoints / Rollback ──────────────────────────────────────────────────

async function _loadCheckpoints(workspace){
  const container=$('checkpointListContainer');
  if(!container) return;
  try{
    const data=await api(`/api/rollback/list?workspace=${encodeURIComponent(workspace)}`);
    const checkpoints=data.checkpoints||[];
    if(!checkpoints.length){
      container.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:8px 0">${esc(t('checkpoint_empty'))}</div>`;
      return;
    }
    let html='';
    for(const ck of checkpoints){
      const shortId=ck.id||ck.commit||'?';
      const msg=ck.message||'checkpoint';
      const date=ck.date_display||ck.date||'';
      const files=ck.files||0;
      html+=`
        <div class="detail-row" style="align-items:center;padding:6px 0;border-bottom:1px solid var(--border,rgba(255,255,255,0.08))">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(msg)}">${esc(msg)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              <code style="font-size:10px">${esc(shortId)}</code>
              ${date ? ` · ${esc(date)}` : ''}
              ${files ? ` · ${esc(t('checkpoint_files'))}: ${files}` : ''}
            </div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;margin-left:8px">
            <button class="panel-head-btn" title="${esc(t('checkpoint_view_diff'))}" onclick="event.stopPropagation();_viewCheckpointDiff('${esc(workspace)}','${esc(ck.id)}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="panel-head-btn" title="${esc(t('checkpoint_restore'))}" onclick="event.stopPropagation();_restoreCheckpoint('${esc(workspace)}','${esc(ck.id)}','${esc(msg.replace(/'/g,"\\'"))}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
          </div>
        </div>`;
    }
    container.innerHTML=html;
  }catch(e){
    container.innerHTML=`<div style="color:var(--error,#f87171);font-size:12px;padding:8px 0">${esc(t('checkpoint_error'))}: ${esc(e.message)}</div>`;
  }
}

async function _viewCheckpointDiff(workspace,checkpoint){
  const modal=document.getElementById('checkpointDiffModal');
  if(!modal){
    const m=document.createElement('div');
    m.id='checkpointDiffModal';
    m.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6)';
    m.innerHTML=`
      <div style="background:var(--bg,${getComputedStyle(document.documentElement).getPropertyValue('--bg')||'#1a1a2e'});border:1px solid var(--border,rgba(255,255,255,0.12));border-radius:12px;width:90vw;max-width:800px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08))">
          <div id="checkpointDiffModalTitle" style="font-weight:600;font-size:14px"></div>
          <button onclick="document.getElementById('checkpointDiffModal').style.display='none'" style="background:none;border:none;color:var(--fg);cursor:pointer;font-size:18px;padding:0 4px">&times;</button>
        </div>
        <div id="checkpointDiffModalBody" style="flex:1;overflow:auto;padding:12px 16px">
          <div style="color:var(--muted);font-size:12px">${esc(t('checkpoint_loading'))}</div>
        </div>
      </div>`;
    m.onclick=(e)=>{if(e.target===m) m.style.display='none';};
    document.body.appendChild(m);
  }
  modal.style.display='flex';
  $('checkpointDiffModalTitle').textContent=t('checkpoint_diff_title');
  $('checkpointDiffModalBody').innerHTML=`<div style="color:var(--muted);font-size:12px">${esc(t('checkpoint_loading'))}</div>`;
  try{
    const data=await api(`/api/rollback/diff?workspace=${encodeURIComponent(workspace)}&checkpoint=${encodeURIComponent(checkpoint)}`);
    const body=$('checkpointDiffModalBody');
    if(!data.total_changes){
      body.innerHTML=`<div style="color:var(--muted);font-size:12px">${esc(t('checkpoint_diff_no_changes'))}</div>`;
      return;
    }
    let html=`<div style="font-size:12px;margin-bottom:8px">${esc(t('checkpoint_diff_files_changed',data.total_changes))}</div>`;
    if(data.files_changed){
      html+='<div style="margin-bottom:8px">';
      for(const f of data.files_changed){
        const icon=f.status==='deleted'?'−':'~';
        const color=f.status==='deleted'?'var(--error,#f87171)':'var(--accent,#60a5fa)';
        html+=`<div style="font-size:12px;padding:2px 0"><span style="color:${color};font-weight:bold;margin-right:6px">${icon}</span><code style="font-size:11px">${esc(f.file)}</code></div>`;
      }
      html+='</div>';
    }
    if(data.diff){
      html+=`<pre style="background:var(--bg-secondary,rgba(0,0,0,0.3));border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px;font-size:11px;line-height:1.4;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow-y:auto;color:var(--fg)">${esc(data.diff)}</pre>`;
    }
    body.innerHTML=html;
  }catch(e){
    $('checkpointDiffModalBody').innerHTML=`<div style="color:var(--error,#f87171);font-size:12px">${esc(e.message)}</div>`;
  }
}

async function _restoreCheckpoint(workspace,checkpoint,message){
  const label=message||checkpoint;
  const ok=await showConfirmDialog({title:t('checkpoint_restore_confirm_title'),message:t('checkpoint_restore_confirm_message',label),confirmLabel:t('checkpoint_restore'),danger:true,focusCancel:true});
  if(!ok) return;
  try{
    const data=await api('/api/rollback/restore',{method:'POST',body:JSON.stringify({workspace,checkpoint})});
    if(data&&data.ok){
      showToast(t('checkpoint_restored')+(data.files_restored_count?` (${data.files_restored_count} ${t('checkpoint_files').toLowerCase()})`:''));
    }else{
      showToast((data&&data.error)||'Restore failed','error');
    }
  }catch(e){
    showToast(t('checkpoint_restore')+': '+e.message,'error');
  }
}


function updateNotificationPermissionStatus(){
  const el=$('notificationPermissionStatus');
  if(!el) return;
  if(!('Notification' in window)){el.textContent=t('notifications_unsupported');return;}
  const perm=Notification.permission||'default';
  el.textContent=t('notifications_permission_status', perm);
}
