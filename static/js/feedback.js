/**
 * feedback.js — "I disagree with this result" widget
 *
 * Self-contained module: injects its own modal + CSS, exposes
 * window.Feedback.showModal(options) for any page to call.
 *
 * POST /feedback/calibration  (no external dependencies)
 */
(function (global) {
    'use strict';

    // ── Emotion options per modality ──────────────────────────────────────────
    const EMOTION_OPTIONS = {
        image:  ['anger','contempt','disgust','fear','happiness','neutral','sadness','surprise'],
        video:  ['anger','contempt','disgust','fear','happiness','neutral','sadness','surprise'],
        audio:  ['anger','disgust','fear','happiness','neutral','sadness','surprise','no_speech'],
        animal: ['angry','happy','sad','other'],
    };

    const EMOJI = {
        anger:'😠', contempt:'😒', disgust:'🤢', fear:'😨',
        happiness:'😄', neutral:'😐', sadness:'😢', surprise:'😲',
        no_speech:'🔇', angry:'😠', happy:'😄', sad:'😢', other:'❓',
    };

    // ── Inject CSS once ───────────────────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('feedback-widget-css')) return;
        const style = document.createElement('style');
        style.id = 'feedback-widget-css';
        style.textContent = `
            /* Feedback overlay */
            #fb-overlay {
                position:fixed; inset:0; background:rgba(0,0,0,.65);
                display:flex; align-items:center; justify-content:center;
                z-index:9999; animation:fbFadeIn .18s ease;
            }
            @keyframes fbFadeIn { from{opacity:0} to{opacity:1} }

            /* Modal card */
            #fb-modal {
                background:#111827; border:1px solid rgba(255,255,255,.1);
                border-radius:14px; padding:28px 24px 20px;
                width:min(420px,92vw); box-shadow:0 20px 60px rgba(0,0,0,.6);
                animation:fbSlideUp .2s ease;
            }
            @keyframes fbSlideUp { from{transform:translateY(16px);opacity:0} to{transform:none;opacity:1} }

            #fb-modal h3 {
                margin:0 0 6px; font-size:1.05rem; font-weight:700; color:#e2e8f0;
            }
            #fb-modal .fb-sub {
                font-size:.85rem; color:#94a3b8; margin-bottom:18px;
            }
            #fb-modal .fb-predicted {
                display:flex; align-items:center; gap:10px;
                padding:10px 14px; border-radius:8px;
                background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.25);
                margin-bottom:16px; font-size:.88rem; color:#fca5a5;
            }
            #fb-modal .fb-predicted strong { color:#f87171; }

            #fb-modal label {
                display:block; font-size:.82rem; font-weight:600;
                color:#94a3b8; margin-bottom:8px; text-transform:uppercase; letter-spacing:.05em;
            }

            /* Emotion grid */
            #fb-options {
                display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;
            }
            .fb-opt {
                display:flex; align-items:center; gap:5px;
                padding:7px 12px; border-radius:8px; cursor:pointer;
                border:1px solid rgba(255,255,255,.1); background:#1e293b;
                color:#cbd5e1; font-size:.82rem; font-weight:500;
                transition:all .15s; user-select:none;
            }
            .fb-opt:hover { border-color:#3b82f6; background:rgba(59,130,246,.12); color:#93c5fd; }
            .fb-opt.selected { border-color:#3b82f6; background:rgba(59,130,246,.2); color:#fff; }

            /* Buttons */
            #fb-footer { display:flex; gap:10px; justify-content:flex-end; }
            .fb-btn {
                padding:9px 20px; border:none; border-radius:8px;
                font-size:.875rem; font-weight:600; cursor:pointer; transition:all .15s;
            }
            .fb-btn-cancel { background:#334155; color:#94a3b8; }
            .fb-btn-cancel:hover { background:#475569; color:#e2e8f0; }
            .fb-btn-submit {
                background:#3b82f6; color:#fff;
            }
            .fb-btn-submit:hover:not(:disabled) { background:#2563eb; }
            .fb-btn-submit:disabled { opacity:.45; cursor:not-allowed; }

            /* Toast */
            #fb-toast {
                position:fixed; bottom:24px; right:24px; z-index:10000;
                padding:12px 20px; border-radius:10px; font-size:.875rem; font-weight:600;
                color:#fff; box-shadow:0 4px 20px rgba(0,0,0,.4);
                animation:fbSlideUp .2s ease; pointer-events:none;
            }
            #fb-toast.success { background:#10b981; }
            #fb-toast.error   { background:#ef4444; }

            /* "I disagree" button — injected next to results */
            .fb-disagree-btn {
                display:inline-flex; align-items:center; gap:5px;
                padding:5px 11px; border-radius:6px; cursor:pointer;
                border:1px solid rgba(239,68,68,.35);
                background:rgba(239,68,68,.08);
                color:#fca5a5; font-size:.78rem; font-weight:600;
                transition:all .15s; margin-top:8px;
            }
            .fb-disagree-btn:hover { border-color:#ef4444; background:rgba(239,68,68,.16); color:#f87171; }
        `;
        document.head.appendChild(style);
    }

    // ── Build modal DOM ───────────────────────────────────────────────────────
    function buildModal(options, onClose) {
        const overlay = document.createElement('div');
        overlay.id = 'fb-overlay';

        const opts = EMOTION_OPTIONS[options.modality] || EMOTION_OPTIONS.image;
        let selected = null;

        overlay.innerHTML = `
            <div id="fb-modal">
                <h3>👎 Disagree with Result</h3>
                <p class="fb-sub">Tell us what the correct emotion should be (optional)</p>

                <div class="fb-predicted">
                    <span>Model said:</span>
                    <strong>${options.predicted_label}</strong>
                    ${options.predicted_confidence != null
                        ? `<span style="margin-left:auto;opacity:.7;">${(options.predicted_confidence * 100).toFixed(0)}% confidence</span>`
                        : ''}
                </div>

                <label>What should it be?</label>
                <div id="fb-options">
                    ${opts.map(e => `
                        <div class="fb-opt" data-val="${e}">
                            ${EMOJI[e] || '🔹'} ${e}
                        </div>`).join('')}
                </div>

                <div id="fb-footer">
                    <button class="fb-btn fb-btn-cancel" id="fb-cancel">Cancel</button>
                    <button class="fb-btn fb-btn-submit" id="fb-submit">Submit Feedback</button>
                </div>
            </div>`;

        // Chip selection
        overlay.querySelectorAll('.fb-opt').forEach(chip => {
            chip.addEventListener('click', () => {
                overlay.querySelectorAll('.fb-opt').forEach(c => c.classList.remove('selected'));
                chip.classList.add('selected');
                selected = chip.dataset.val;
            });
        });

        overlay.querySelector('#fb-cancel').addEventListener('click', () => {
            document.body.removeChild(overlay);
            onClose(false);
        });

        overlay.querySelector('#fb-submit').addEventListener('click', async () => {
            const btn = overlay.querySelector('#fb-submit');
            btn.disabled = true;
            btn.textContent = 'Sending…';

            const success = await postFeedback({
                modality:              options.modality,
                predicted_label:       options.predicted_label,
                correct_label:         selected,
                predicted_confidence:  options.predicted_confidence ?? null,
                session_id:            options.session_id ?? null,
                request_id:            options.request_id ?? null,
                extra:                 options.extra ?? null,
            });

            document.body.removeChild(overlay);
            onClose(success);
            showToast(
                success ? '✅ Feedback saved — thank you!' : '❌ Could not save feedback',
                success ? 'success' : 'error'
            );
        });

        // Click outside to close
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                onClose(false);
            }
        });

        return overlay;
    }

    // ── HTTP POST ─────────────────────────────────────────────────────────────
    async function postFeedback(payload) {
        try {
            const res = await fetch('/feedback/calibration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    // ── Toast notification ────────────────────────────────────────────────────
    function showToast(msg, type = 'success') {
        const old = document.getElementById('fb-toast');
        if (old) old.remove();
        const t = document.createElement('div');
        t.id = 'fb-toast';
        t.className = type;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    /**
     * Show the disagree modal.
     *
     * options = {
     *   modality:             "image"|"video"|"audio"|"animal",
     *   predicted_label:      string,
     *   predicted_confidence: number|null,
     *   session_id:           string|null,
     *   request_id:           string|null,
     *   extra:                object|null,
     * }
     */
    function showModal(options) {
        injectCSS();
        const overlay = buildModal(options, () => {});
        document.body.appendChild(overlay);
    }

    /**
     * Create a pre-wired "I disagree" button element.
     * Caller appends it wherever needed.
     */
    function createDisagreeButton(options) {
        injectCSS();
        const btn = document.createElement('button');
        btn.className = 'fb-disagree-btn';
        btn.innerHTML = '👎 I disagree with this result';
        btn.addEventListener('click', () => showModal(options));
        return btn;
    }

    // Export
    global.Feedback = { showModal, createDisagreeButton };

})(window);
