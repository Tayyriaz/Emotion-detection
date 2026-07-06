/**
 * session_history.js — Session History Panel
 *
 * Self-contained module. Reads from:
 *   GET /sessions/list
 *   POST /sessions/{id}/name
 *   GET /sessions/{id}/details
 *
 * Exposes window.SessionHistory.resumeSession(sessionId) so app.js
 * can be called back on "▶ Resume".
 *
 * No dependencies on app.js internals — communicates via custom DOM events.
 */
(function (global) {
    'use strict';

    // ── Inject CSS ────────────────────────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('sh-css')) return;
        const s = document.createElement('style');
        s.id = 'sh-css';
        s.textContent = `
            /* Row + inner component styles (panel shell is in style.css) */
            .sh-row {
                display:flex; flex-direction:column; gap:6px;
                padding:12px 14px; margin-bottom:8px;
                background:#1e293b; border:1px solid rgba(255,255,255,.08);
                border-radius:10px; transition:border-color .15s;
            }
            .sh-row:hover { border-color:rgba(99,102,241,.4); }

            .sh-row-top {
                display:flex; align-items:center; gap:10px;
            }
            .sh-name-wrap { flex:1; min-width:0; }
            .sh-name {
                font-weight:700; font-size:.9rem; color:#e2e8f0;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            .sh-id {
                font-size:.72rem; color:#475569; font-family:monospace;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }

            .sh-badges { display:flex; gap:6px; flex-wrap:wrap; }
            .sh-badge {
                font-size:.72rem; padding:2px 8px; border-radius:20px;
                font-weight:600; white-space:nowrap;
            }
            .sh-badge-harmony   { background:rgba(16,185,129,.15); color:#6ee7b7; }
            .sh-badge-part      { background:rgba(59,130,246,.12); color:#93c5fd; }
            .sh-badge-dur       { background:rgba(100,116,139,.15); color:#94a3b8; }
            .sh-badge-ckpt      { background:rgba(245,158,11,.1);  color:#fcd34d; }

            .sh-meta {
                font-size:.75rem; color:#475569;
            }

            .sh-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }

            .sh-btn {
                padding:5px 12px; border-radius:7px; border:none;
                font-size:.78rem; font-weight:600; cursor:pointer; transition:all .15s;
            }
            .sh-btn-resume {
                background:rgba(99,102,241,.2); color:#a5b4fc;
                border:1px solid rgba(99,102,241,.35);
            }
            .sh-btn-resume:hover { background:rgba(99,102,241,.35); }

            .sh-btn-rename {
                background:transparent; color:#64748b;
                border:1px solid rgba(255,255,255,.08);
            }
            .sh-btn-rename:hover { color:#94a3b8; border-color:rgba(255,255,255,.2); }

            .sh-rename-input {
                flex:1; padding:4px 8px; border-radius:6px; font-size:.8rem;
                background:#0f172a; border:1px solid rgba(99,102,241,.4);
                color:#e2e8f0; outline:none; min-width:0;
            }
            .sh-rename-save {
                padding:4px 10px; border-radius:6px; font-size:.78rem;
                font-weight:600; cursor:pointer; transition:all .15s;
                background:rgba(99,102,241,.25); color:#a5b4fc;
                border:1px solid rgba(99,102,241,.4);
            }
            .sh-rename-save:hover { background:rgba(99,102,241,.4); }
        `;
        document.head.appendChild(s);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function fmtDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        } catch { return iso; }
    }

    function fmtDuration(secs) {
        if (secs == null) return null;
        if (secs < 60) return `${Math.round(secs)}s`;
        const m = Math.floor(secs / 60), s = Math.round(secs % 60);
        return `${m}m ${s}s`;
    }

    function harmonyColor(label) {
        const map = { Aligned:'#6ee7b7', Moderate:'#fcd34d', Divergent:'#f97316', Conflicted:'#f87171' };
        return map[label] || '#94a3b8';
    }

    // ── Fetch helpers ─────────────────────────────────────────────────────────

    async function fetchList() {
        const res = await fetch('/sessions/list');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }

    async function fetchDetails(sessionId) {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/details`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }

    async function postName(sessionId, name) {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        return res.ok;
    }

    // ── Render list ───────────────────────────────────────────────────────────

    function renderList(data) {
        const loading = document.getElementById('sessionListLoading');
        const empty   = document.getElementById('sessionListEmpty');
        const items   = document.getElementById('sessionListItems');
        if (!items) return;

        if (loading) loading.style.display = 'none';

        const sessions = data.sessions || [];
        if (sessions.length === 0) {
            if (empty) empty.style.display = 'block';
            items.innerHTML = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        items.innerHTML = sessions.map(s => buildRowHTML(s)).join('');

        // Wire buttons
        items.querySelectorAll('.sh-btn-resume').forEach(btn => {
            btn.addEventListener('click', () => handleResume(btn.dataset.id));
        });
        items.querySelectorAll('.sh-btn-rename').forEach(btn => {
            btn.addEventListener('click', () => toggleRenameInline(btn.dataset.id));
        });
    }

    function buildRowHTML(s) {
        const name     = s.name || s.session_id;
        const dur      = fmtDuration(s.duration_seconds);
        const harmony  = s.harmony_score != null
            ? `${(s.harmony_score * 100).toFixed(0)}%` : null;
        const hColor   = harmonyColor(s.harmony_label);

        const badges = [
            harmony
                ? `<span class="sh-badge sh-badge-harmony" style="color:${hColor};">🎯 ${harmony} ${s.harmony_label || ''}</span>`
                : '',
            s.participant_count != null
                ? `<span class="sh-badge sh-badge-part">👥 ${s.participant_count}</span>`
                : '',
            dur
                ? `<span class="sh-badge sh-badge-dur">⏱ ${dur}</span>`
                : '',
            s.checkpoint_count
                ? `<span class="sh-badge sh-badge-ckpt">💾 ${s.checkpoint_count} saves</span>`
                : '',
        ].filter(Boolean).join('');

        return `
        <div class="sh-row" id="sh-row-${CSS.escape(s.session_id)}">
            <div class="sh-row-top">
                <div class="sh-name-wrap">
                    <div class="sh-name" title="${s.session_id}">${escapeHtml(name)}</div>
                    <div class="sh-id">${s.session_id}</div>
                </div>
            </div>
            ${badges ? `<div class="sh-badges">${badges}</div>` : ''}
            <div class="sh-meta">Last active: ${fmtDate(s.last_active)}</div>
            <div class="sh-actions">
                <button class="sh-btn sh-btn-resume" data-id="${escapeAttr(s.session_id)}">▶ Resume</button>
                <button class="sh-btn sh-btn-rename" data-id="${escapeAttr(s.session_id)}">✏ Rename</button>
            </div>
            <div class="sh-rename-wrap" id="sh-rename-${CSS.escape(s.session_id)}" style="display:none;display:flex;gap:6px;align-items:center;">
                <input class="sh-rename-input" placeholder="New name…" maxlength="80"
                       id="sh-ri-${CSS.escape(s.session_id)}" value="${escapeAttr(s.name || '')}">
                <button class="sh-rename-save" data-id="${escapeAttr(s.session_id)}">Save</button>
            </div>
        </div>`;
    }

    function toggleRenameInline(sessionId) {
        const wrap = document.getElementById(`sh-rename-${CSS.escape(sessionId)}`);
        if (!wrap) return;
        const visible = wrap.style.display !== 'none';
        wrap.style.display = visible ? 'none' : 'flex';
        if (!visible) {
            const inp = document.getElementById(`sh-ri-${CSS.escape(sessionId)}`);
            if (inp) { inp.focus(); inp.select(); }
            // Wire save button
            const saveBtn = wrap.querySelector('.sh-rename-save');
            if (saveBtn) {
                saveBtn.onclick = async () => {
                    const inp2 = document.getElementById(`sh-ri-${CSS.escape(sessionId)}`);
                    const newName = inp2 ? inp2.value.trim() : '';
                    if (!newName) return;
                    saveBtn.textContent = '…';
                    const ok = await postName(sessionId, newName);
                    if (ok) {
                        wrap.style.display = 'none';
                        // Update displayed name
                        const nameEl = document.querySelector(`#sh-row-${CSS.escape(sessionId)} .sh-name`);
                        if (nameEl) nameEl.textContent = newName;
                        showToast('✅ Session renamed');
                    } else {
                        showToast('❌ Could not save name', 'error');
                    }
                    saveBtn.textContent = 'Save';
                };
            }
        }
    }

    // ── Resume ────────────────────────────────────────────────────────────────

    async function handleResume(sessionId) {
        try {
            const details = await fetchDetails(sessionId);
            // Dispatch custom event — app.js listens and handles the actual
            // WebSocket reconnect without any direct coupling.
            document.dispatchEvent(new CustomEvent('sh:resume', {
                detail: {
                    session_id: sessionId,
                    name: details.name,
                    checkpoint: details.latest_checkpoint,
                }
            }));
            showToast(`▶ Resuming "${details.name || sessionId}"…`);
            // Close the panel
            const content = document.getElementById('sessionHistoryContent');
            if (content) content.style.display = 'none';
        } catch (err) {
            showToast('❌ Could not load session details', 'error');
        }
    }

    // ── "Save name" for current session ──────────────────────────────────────

    function wireCurrentSessionName() {
        const saveBtn = document.getElementById('saveSessionNameBtn');
        const input   = document.getElementById('newSessionNameInput');
        if (!saveBtn || !input) return;

        saveBtn.addEventListener('click', async () => {
            const name = input.value.trim();
            if (!name) return;
            // Get active session ID from app.js via global
            const sid = global.videoState?.activeSessionId
                     || global.SessionHistory?.currentSessionId?.();
            if (!sid) {
                showToast('⚠️ No active session — start recording first', 'error');
                return;
            }
            saveBtn.textContent = '…';
            const ok = await postName(sid, name);
            saveBtn.textContent = '💾 Save Name';
            if (ok) {
                showToast(`✅ Named session: "${name}"`);
                loadList();   // refresh
            } else {
                showToast('❌ Could not save name', 'error');
            }
        });
    }

    // ── Load / refresh list ───────────────────────────────────────────────────

    async function loadList() {
        const loading = document.getElementById('sessionListLoading');
        const items   = document.getElementById('sessionListItems');
        if (loading) loading.style.display = 'block';
        if (items)   items.innerHTML = '';
        try {
            const data = await fetchList();
            renderList(data);
        } catch (err) {
            if (loading) loading.style.display = 'none';
            if (items)   items.innerHTML = `<p style="color:#f87171;font-size:.82rem;">Error loading sessions: ${err.message}</p>`;
        }
    }

    // ── Toast ─────────────────────────────────────────────────────────────────

    function showToast(msg, type = 'success') {
        let t = document.getElementById('sh-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'sh-toast';
            t.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:10001;'
                + 'padding:11px 18px;border-radius:10px;font-size:.875rem;font-weight:600;'
                + 'color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.4);pointer-events:none;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.background = type === 'error' ? '#ef4444' : '#6366f1';
        t.style.opacity = '1';
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
    }

    // ── HTML escape helpers ───────────────────────────────────────────────────

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // ── Wire toggle button ────────────────────────────────────────────────────

    function init() {
        injectCSS();

        const toggle  = document.getElementById('sessionHistoryToggle');
        const content = document.getElementById('sessionHistoryContent');
        const refresh = document.getElementById('sessionHistoryRefreshBtn');

        if (toggle && content) {
            toggle.addEventListener('click', () => {
                const open = content.style.display !== 'none';
                content.style.display = open ? 'none' : 'block';
                if (!open) loadList();
            });
        }

        if (refresh) {
            refresh.addEventListener('click', loadList);
        }

        wireCurrentSessionName();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    global.SessionHistory = {
        /** Reload the session list (called externally after recording stops). */
        refresh: loadList,
        showToast,
        /** Return the current session ID to be used when naming. */
        currentSessionId: () =>
            global.videoState?.activeSessionId || null,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(window);
