import { config } from '../config.js';
import { HttpError } from '../httpError.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY } from '../extensionCompatibility.js';
import { isProviderId } from '../providers/providerCatalog.js';
import { ProviderService } from '../providers/providerService.js';

/**
 * Local provider control center.
 *
 * This is the existing bridge setup page, extended. It keeps the extension
 * install/token workflow on the same URL and adds provider operations on top of
 * it: /setup stays the single local entry point.
 *
 * Security shape:
 * - localhost only (the same request check the setup page already uses);
 * - structured commands only (start/stop/restart/logs/settings), provider ids
 *   validated against the catalogue, no shell and no browser-supplied paths
 *   executed;
 * - state-changing requests are JSON POSTs from the same origin, which a
 *   cross-site form cannot produce;
 * - API_TOKEN is never rendered or returned; the BRIDGE_TOKEN stays a
 *   copy-only field, exactly as the setup page already exposed it.
 */

function requireLocal(bridge, req, what) {
  if (!bridge?.isLocalRequest?.(req)) {
    throw new HttpError(403, `${what} is only available from localhost`);
  }
}

function requireSameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return;
  let parsed = null;
  try { parsed = new URL(origin); } catch { parsed = null; }
  if (!parsed || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new HttpError(403, 'Provider commands only accept same-origin local requests');
  }
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (host && parsed.host.toLowerCase() !== host) {
    throw new HttpError(403, 'Provider commands only accept same-origin local requests');
  }
}

function requireJsonRequest(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'Provider commands require application/json');
  }
}

function requireProviderId(value) {
  const id = String(value || '').trim();
  if (!isProviderId(id)) throw new HttpError(404, `Unknown provider: ${id || '(none)'}`);
  return id;
}

function ok(res, payload) {
  res.json({ ok: true, ...payload });
}

const TONE_STYLES = `
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--primary:#2563eb;--primary2:#1d4ed8;--ok:#15803d;--okbg:#f0fdf4;--okline:#bbf7d0;--info:#1d4ed8;--infobg:#eff6ff;--infoline:#bfdbfe;--warn:#a16207;--warnbg:#fffbeb;--warnline:#fde68a;--bad:#be123c;--badbg:#fff1f2;--badline:#fecdd3;--idle:#52525b;--idlebg:#f4f4f5;--idleline:#e4e4e7;--ext:#6d28d9;--extbg:#f5f3ff;--extline:#ddd6fe}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,rgba(37,99,235,.08),transparent 28rem),var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{max-width:1040px;margin:0 auto;padding:40px 22px 72px}
.hero{display:grid;grid-template-columns:1fr auto;gap:22px;align-items:start;margin-bottom:22px}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:800;color:var(--primary)}
h1{margin:5px 0 8px;font-size:36px;line-height:1.08;letter-spacing:-.035em}
.lead{max-width:720px;margin:0;color:var(--muted);font-size:16px}
.version{padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:var(--card);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}
nav.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0 22px;padding:5px;border:1px solid var(--line);border-radius:14px;background:var(--card);width:fit-content}
nav.tabs button{border:0;background:transparent;color:var(--muted);font:700 13px/1 inherit;padding:9px 14px;border-radius:10px;cursor:pointer}
nav.tabs button[aria-selected=true]{background:var(--primary);color:#fff}
section.panel{display:none}section.panel[data-active=true]{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px 22px;box-shadow:0 14px 40px rgba(0,0,0,.05);margin-bottom:16px}
.card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px}
.card h2{margin:0;font-size:19px;letter-spacing:-.01em}
.card p.muted{margin:2px 0 0}
.muted{color:var(--muted)}
.rows{display:grid;gap:2px;margin:10px 0 4px}
.row{display:grid;grid-template-columns:190px 1fr;gap:12px;align-items:baseline;padding:7px 0;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}
.row .label{font-weight:700;font-size:13px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:7px;padding:3px 9px 3px 7px;border-radius:999px;font:700 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--idleline);background:var(--idlebg);color:var(--idle)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
.pill[data-tone=ok]{background:var(--okbg);border-color:var(--okline);color:var(--ok)}
.pill[data-tone=info]{background:var(--infobg);border-color:var(--infoline);color:var(--info)}
.pill[data-tone=ext]{background:var(--extbg);border-color:var(--extline);color:var(--ext)}
.pill[data-tone=warn]{background:var(--warnbg);border-color:var(--warnline);color:var(--warn)}
.pill[data-tone=bad]{background:var(--badbg);border-color:var(--badline);color:var(--bad)}
.detail{font-size:13px;color:var(--muted);min-width:0;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 13px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--text);font:700 13px/1 inherit;text-decoration:none;cursor:pointer}
.button:hover:not(:disabled){background:#f4f4f5}
.button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.button.primary:hover:not(:disabled){background:var(--primary2)}
.button.danger{color:var(--bad);border-color:var(--badline)}
.button:disabled{opacity:.5;cursor:not-allowed}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.notice{margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--warnbg);color:var(--warn);font-size:12px}
.notice.bad{background:var(--badbg);color:var(--bad)}
.notice.ok{background:var(--okbg);color:var(--ok)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{margin-top:12px}
.field label{display:flex;justify-content:space-between;gap:10px;margin-bottom:6px;color:var(--muted);font-size:12px;font-weight:700}
input[type=text],input[type=password],input[type=number],select{width:100%;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--text);font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.copyrow{display:flex;gap:7px}.copyrow input{min-width:0;flex:1}
details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
summary{cursor:pointer;color:var(--muted);font-weight:700;font-size:13px}
ol{padding-left:20px;margin:10px 0}li{margin:6px 0}
pre{max-height:420px;overflow:auto;padding:12px;border-radius:12px;background:#18181b;color:#e4e4e7;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--idlebg);padding:1px 5px;border-radius:6px}
.kv{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}
.placeholder{border:1px dashed var(--line);border-radius:16px;padding:26px;text-align:center;color:var(--muted)}
@media(max-width:760px){.shell{padding:26px 14px 52px}.grid2{grid-template-columns:1fr}.row{grid-template-columns:1fr;gap:4px}h1{font-size:30px}.hero{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f10;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--okbg:#10251a;--okline:#14532d;--infobg:#101c33;--infoline:#1e3a8a;--warnbg:#2b2411;--warnline:#4d3d0d;--badbg:#30151b;--badline:#4c1d24;--idlebg:#202024;--idleline:#3f3f46;--extbg:#1c1630;--extline:#3b2f63}.button:hover:not(:disabled){background:#27272a}}
`;

function controlHtml() {
  const extensionZipUrl = `${config.publicBaseUrl}/extensions/chrome-bridge-extension.zip`;
  const extensionVersion = EXTENSION_COMPATIBILITY.recommendedExtensionVersion;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT Bridge · Provider Control Center</title>
<style>${TONE_STYLES}</style></head><body><main class="shell">
<header class="hero"><div><div class="eyebrow">Connect ChatGPT Bridge</div><h1>Provider control center</h1><p class="lead">Manage the local web-account providers this bridge can actually operate, from the page that already configures the extension. Statuses come from the providers themselves, never from the mere existence of a process.</p></div><div class="version">bridge ${BRIDGE_VERSION} · extension ${extensionVersion}</div></header>
<nav class="tabs" role="tablist">
<button role="tab" data-tab="providers" aria-selected="true">Providers</button>
<button role="tab" data-tab="logs" aria-selected="false">Logs</button>
<button role="tab" data-tab="settings" aria-selected="false">Settings</button>
<button role="tab" data-tab="kodevra" aria-selected="false">Kodevra</button>
</nav>

<section class="panel" data-panel="providers" data-active="true">
  <div id="provider-list"><div class="card"><p class="muted">Loading provider status…</p></div></div>
  <div class="card" id="extension-setup">
    <header><div><h2>ChatGPT extension setup</h2><p class="muted">Install the extension once, paste the local Bridge token, and verify the tab.</p></div></header>
    <div class="actions"><a class="button primary" href="${extensionZipUrl}">Download extension ${extensionVersion}</a><a class="button" href="https://chatgpt.com" target="_blank" rel="noreferrer">Open ChatGPT</a><a class="button" href="/diagnostics">Diagnostics</a></div>
    <ol><li>Open <code>chrome://extensions</code> and enable <b>Developer mode</b>.</li><li>First install: <b>Load unpacked</b> → <code>tools/chrome-bridge-extension</code>. Existing install: <b>Reload</b>, do not remove it.</li><li>Open a ChatGPT chat, open the floating Bridge panel, paste the Bridge token below, then reload the chat tab.</li></ol>
    <div class="grid2">
      <div class="field"><label><span>Local bridge URL</span><span>safe to share locally</span></label><div class="copyrow"><input id="bridge-url" readonly type="text" value="${config.publicBaseUrl}"><button class="button" data-copy="bridge-url">Copy</button></div></div>
      <div class="field"><label><span>Bridge token</span><span>never sent to the API</span></label><div class="copyrow"><input id="bridge-token" readonly type="password" value="${config.bridgeToken}"><button class="button" data-copy="bridge-token">Copy</button></div></div>
    </div>
    <div class="notice">Use the <b>Bridge token</b>, not the API token. The API token is never rendered on this page.</div>
    <div class="actions"><button class="button" id="verify-status">Verify connection</button></div>
    <div class="hint" id="verify-result">Extension state is shown in the ChatGPT Web provider above.</div>
    <details><summary>Advanced & diagnostics</summary><pre id="status-json">Loading…</pre></details>
  </div>
</section>

<section class="panel" data-panel="logs">
  <div class="card">
    <header><div><h2>Provider logs</h2><p class="muted">Bounded tail of the log file this manager writes for a provider. Tokens, cookies and auth headers are redacted.</p></div></header>
    <div class="grid2">
      <div class="field"><label><span>Provider</span></label><select id="log-provider"><option value="chatgpt-web">ChatGPT Web</option><option value="deepseek-web">DeepSeek Web</option></select></div>
      <div class="field"><label><span>Lines</span></label><input id="log-lines" type="number" min="50" max="2000" step="50" value="400"></div>
    </div>
    <div class="actions"><button class="button primary" id="log-refresh">Load log</button><span class="kv" id="log-meta"></span></div>
    <div class="field"><pre id="log-body">No log loaded.</pre></div>
  </div>
</section>

<section class="panel" data-panel="settings">
  <div class="card">
    <header><div><h2>Settings</h2><p class="muted">Stored in the bridge data directory (<span class="kv" id="settings-path"></span>). Paths are absolute; nothing here can choose an executable.</p></div></header>
    <div class="grid2">
      <div class="field"><label><span>Health check interval (ms)</span><span>1000–30000</span></label><input id="set-health" type="number" min="1000" max="30000" step="500" value="3000"></div>
      <div class="field"><label><span>Log retention (lines)</span><span>50–2000</span></label><input id="set-loglines" type="number" min="50" max="2000" step="50" value="400"></div>
    </div>
    <div id="settings-providers"></div>
    <div class="actions"><button class="button primary" id="settings-save">Save settings</button></div>
    <div class="hint" id="settings-result"></div>
  </div>
  <div class="card">
    <header><div><h2>Start at Windows login</h2><p class="muted">Per-user Startup folder launcher (hidden VBScript, no admin, no Windows Service). It checks each provider's real health first, so a login never starts duplicates.</p></div></header>
    <div id="autostart-state" class="rows"></div>
    <div class="actions"><button class="button primary" id="autostart-install">Enable auto-start</button><button class="button danger" id="autostart-remove">Disable auto-start</button></div>
    <div class="hint" id="autostart-result"></div>
  </div>
</section>

<section class="panel" data-panel="kodevra">
  <div class="card"><header><div><h2>Kodevra</h2><p class="muted">Reserved navigation entry.</p></div></header>
  <div class="placeholder">Task execution is not implemented here. This control center only manages provider processes and sessions; Kodevra runs against the providers above with its own harness.</div></div>
</section>
</main>
<script>
(function(){
  'use strict';
  var TONE = { READY: 'ok', CONNECTED: 'ok', RUNNING: 'info', EXTERNAL_PROCESS: 'ext', STARTING: 'warn', WAITING_FOR_BROWSER: 'warn', NOT_CONFIGURED: 'warn', ERROR: 'bad', STOPPED: 'idle' };
  function el(tag, props, children){
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function(key){
      if (key === 'class') node.className = props[key];
      else if (key === 'text') node.textContent = props[key];
      else if (key === 'dataset') Object.keys(props[key]).forEach(function(name){ node.dataset[name] = props[key][name]; });
      else if (key.slice(0,2) === 'on') node.addEventListener(key.slice(2), props[key]);
      else node.setAttribute(key, props[key]);
    });
    (children || []).forEach(function(child){ if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function pill(state){
    return el('span', { class: 'pill', dataset: { tone: TONE[state] || 'idle' } }, [el('span', { class: 'dot' }), document.createTextNode(state || 'UNKNOWN')]);
  }
  function row(label, state, detail){
    return el('div', { class: 'row' }, [el('div', { class: 'label', text: label }), el('div', {}, [pill(state), el('div', { class: 'detail', text: detail || '' })])]);
  }
  function btn(label, options, onClick){
    var node = el('button', { class: 'button' + (options.className ? ' ' + options.className : ''), text: label, title: options.reason || '' });
    node.disabled = options.enabled === false;
    node.addEventListener('click', onClick);
    return node;
  }
  function fetchJson(url, options){
    return fetch(url, Object.assign({ cache: 'no-store', headers: { 'accept': 'application/json' } }, options || {})).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(body){ return { ok: response.ok, status: response.status, body: body }; });
    });
  }
  function post(url, payload){
    return fetchJson(url, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
  }
  function renderProvider(provider){
    var card = el('div', { class: 'card' });
    var head = el('header', {}, [
      el('div', {}, [el('h2', { text: provider.label }), el('p', { class: 'muted', text: provider.summary || '' })]),
      pill(provider.state)
    ]);
    card.appendChild(head);
    var rows = el('div', { class: 'rows' });
    rows.appendChild(row(provider.kind === 'bridge' ? 'Bridge' : 'Provider', provider.process ? provider.process.state : 'STOPPED', provider.process ? provider.process.detail : ''));
    (provider.rows || []).forEach(function(item){ rows.appendChild(row(item.label, item.state, item.detail)); });
    card.appendChild(rows);
    if (provider.kind === 'bridge') {
      card.appendChild(el('p', { class: 'hint', text: 'Bridge process: ' + (provider.process && provider.process.detail ? provider.process.detail : '') + ' · ' + (provider.origin || '') }));
    } else {
      var probe = provider.probe;
      if (probe && probe.reachable) {
        var bits = [];
        if (probe.service) bits.push(probe.service + (probe.version ? ' ' + probe.version : ''));
        if (probe.counts) bits.push(probe.counts.usable + '/' + probe.counts.total + ' login(s) usable');
        if (probe.models && probe.models.length) bits.push(probe.models.join(', '));
        card.appendChild(el('p', { class: 'hint', text: bits.join(' · ') }));
      }
      if (provider.setup && provider.setup.dashboardUrl) {
        card.appendChild(el('p', { class: 'kv', text: 'Proxy: ' + provider.origin + ' · dashboard ' + provider.setup.dashboardUrl }));
      }
    }
    (provider.notes || []).forEach(function(note){ card.appendChild(el('div', { class: 'notice', text: note })); });
    if (provider.operation) {
      card.appendChild(el('div', { class: 'notice', text: provider.operation.action.toUpperCase() + ' in progress (' + Math.round(provider.operation.ageMs / 1000) + 's)' }));
    }
    var actions = el('div', { class: 'actions' });
    var controls = provider.controls || {};
    actions.appendChild(btn('Start', controls.start || {}, function(){ act(provider.id, 'start'); }));
    actions.appendChild(btn('Stop', Object.assign({ className: 'danger' }, controls.stop || {}), function(){ confirmAct(provider.id, 'stop', 'Stop ' + provider.label + '?'); }));
    actions.appendChild(btn('Restart', controls.restart || {}, function(){ confirmAct(provider.id, 'restart', 'Restart ' + provider.label + '?'); }));
    actions.appendChild(btn('Logs', controls.logs || {}, function(){ showLogs(provider.id); }));
    card.appendChild(actions);
    var reasons = [];
    ['start', 'stop', 'restart'].forEach(function(name){
      var control = controls[name];
      if (control && control.enabled === false && control.reason) reasons.push(name + ': ' + control.reason);
    });
    if (reasons.length) card.appendChild(el('p', { class: 'hint', text: reasons.join(' · ') }));
    if (provider.kind === 'bridge' && provider.clients && provider.clients.length) {
      var clients = el('details');
      clients.appendChild(el('summary', { text: 'Connected tabs (' + provider.clients.length + ')' }));
      provider.clients.forEach(function(client){
        clients.appendChild(el('p', { class: 'kv', text: client.id + ' · ' + (client.sessionTitle || client.sessionId || 'no session') + (client.compatible === false ? ' · incompatible' : '') }));
      });
      card.appendChild(clients);
    }
    return card;
  }
  var lastStatus = null;
  function settingsPanelBusy(){
    var panel = document.querySelector('section.panel[data-panel=settings]');
    if (!panel || panel.dataset.active !== 'true') return false;
    var active = document.activeElement;
    return Boolean(active && panel.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT'));
  }
  function renderProviders(status){
    lastStatus = status;
    var host = document.getElementById('provider-list');
    host.textContent = '';
    (status.providers || []).forEach(function(provider){ host.appendChild(renderProvider(provider)); });
    // Never rewrite form fields while someone is typing in them.
    if (!settingsPanelBusy()) renderSettings(status);
  }
  function refresh(){
    return fetchJson('/setup/providers/status').then(function(result){
      if (!result.ok) throw new Error((result.body && result.body.message) || ('status ' + result.status));
      renderProviders(result.body);
      return result.body;
    }).catch(function(error){
      var host = document.getElementById('provider-list');
      host.textContent = '';
      var card = el('div', { class: 'card' }, [el('div', { class: 'notice bad', text: 'Provider status unavailable: ' + error.message })]);
      host.appendChild(card);
    });
  }
  function actionNotice(message, tone){
    var host = document.getElementById('provider-list');
    var notice = el('div', { class: 'card' }, [el('div', { class: 'notice' + (tone ? ' ' + tone : ''), text: message })]);
    host.insertBefore(notice, host.firstChild);
    setTimeout(function(){ try { host.removeChild(notice); } catch (e) {} }, 8000);
  }
  function act(id, action){
    post('/setup/providers/' + encodeURIComponent(id) + '/' + action, {}).then(function(result){
      var body = result.body || {};
      if (result.ok && body.ok) actionNotice(action + ' accepted: ' + (body.message || (body.pid ? ('pid ' + body.pid) : (body.started ? 'started' : 'done'))), 'ok');
      else actionNotice(action + ' failed: ' + (body.message || body.error || ('status ' + result.status)), 'bad');
      refresh();
    }).catch(function(error){ actionNotice(action + ' failed: ' + error.message, 'bad'); });
  }
  function confirmAct(id, action, question){
    if (!window.confirm(question)) return;
    act(id, action);
  }
  function showLogs(providerId){
    var select = document.getElementById('log-provider');
    if (providerId) select.value = providerId;
    selectTab('logs');
    loadLogs();
  }
  function loadLogs(){
    var provider = document.getElementById('log-provider').value;
    var lines = Number(document.getElementById('log-lines').value) || 400;
    var body = document.getElementById('log-body');
    var meta = document.getElementById('log-meta');
    fetchJson('/setup/providers/' + encodeURIComponent(provider) + '/logs?lines=' + encodeURIComponent(lines)).then(function(result){
      var payload = result.body || {};
      if (!result.ok || !payload.ok) { body.textContent = 'Log unavailable: ' + (payload.message || payload.error || result.status); meta.textContent = ''; return; }
      body.textContent = (payload.lines || []).join('\\n') || (payload.exists === false ? 'No log file yet for this provider. Logs appear once the control center starts it.' : 'Log is empty.');
      meta.textContent = payload.logPath + (payload.bytes ? ' · ' + payload.bytes + ' bytes' : '');
    });
  }
  function providerField(label, id, value, hint){
    var input = el('input', { id: id, type: 'text', value: value || '', spellcheck: 'false' });
    var field = el('div', { class: 'field' }, [el('label', {}, [el('span', { text: label }), el('span', { text: hint || '' })]), input]);
    return field;
  }
  function renderSettings(status){
    var settings = status.settings || {};
    document.getElementById('set-health').value = settings.healthIntervalMs || 3000;
    document.getElementById('set-loglines').value = settings.logRetentionLines || 400;
    var pathNode = document.getElementById('settings-path');
    if (pathNode && status.providers && status.providers[0] && status.providers[0].setup) pathNode.textContent = status.providers[0].setup.settingsPath || '';
    var host = document.getElementById('settings-providers');
    host.textContent = '';
    (status.providers || []).forEach(function(provider){
      var container = el('div', { class: 'field' });
      container.appendChild(el('div', { class: 'field' }, [el('label', {}, [el('span', { text: provider.label + ' port' }), el('span', { text: provider.kind === 'bridge' ? 'bridge listens on ' + ((provider.setup && provider.setup.port) || '') : 'loopback only' })]), el('input', { id: 'port-' + provider.id, type: 'number', min: '1', max: '65535', value: (provider.setup && provider.setup.port) || '' })]));
      if (provider.kind === 'bridge') {
        container.appendChild(el('p', { class: 'kv', text: 'Bridge repository: ' + ((provider.setup && provider.setup.repoPath) || '') }));
      } else {
        container.appendChild(providerField(provider.label + ' folder (absolute path)', 'path-' + provider.id, (provider.setup && provider.setup.repoPath) || '', 'must contain ' + ((provider.setup && provider.setup.entry) || 'server.js')));
      }
      var autostartId = 'autostart-' + provider.id;
      var checked = Boolean(settings.providers && settings.providers[provider.id] && settings.providers[provider.id].autostart);
      var checkbox = el('input', { id: autostartId, type: 'checkbox' });
      checkbox.checked = checked;
      container.appendChild(el('div', { class: 'field' }, [el('label', {}, [el('span', { text: provider.label + ' starts at login' })]), checkbox]));
      if (provider.kind !== 'bridge' && provider.setup && provider.setup.signInCommand) {
        container.appendChild(el('p', { class: 'kv', text: 'Sign in once in that folder: ' + provider.setup.signInCommand + ' · doctor: ' + (provider.setup.doctorCommand || '') }));
      }
      host.appendChild(container);
    });
    var auto = status.autostart || {};
    var stateHost = document.getElementById('autostart-state');
    stateHost.textContent = '';
    stateHost.appendChild(row('Mechanism', auto.supported ? 'READY' : 'NOT_CONFIGURED', auto.supported ? (auto.method || 'startup-folder-vbs') + (auto.hidden ? ' · hidden' : '') + (auto.requiresAdmin ? ' · requires admin' : ' · no admin') : (auto.error || 'unsupported on this platform')));
    stateHost.appendChild(row('Installed', auto.supported ? (auto.installed ? 'READY' : 'STOPPED') : 'NOT_CONFIGURED', auto.path || ''));
  }
  function saveSettings(){
    var payload = { healthIntervalMs: Number(document.getElementById('set-health').value), logRetentionLines: Number(document.getElementById('set-loglines').value), providers: {} };
    ['chatgpt-web', 'deepseek-web'].forEach(function(id){
      var entry = {};
      var port = document.getElementById('port-' + id);
      if (port) entry.port = Number(port.value);
      var pathInput = document.getElementById('path-' + id);
      if (pathInput) entry.repoPath = pathInput.value;
      var auto = document.getElementById('autostart-' + id);
      if (auto) entry.autostart = auto.checked;
      payload.providers[id] = entry;
    });
    post('/setup/providers/settings', payload).then(function(result){
      var body = result.body || {};
      var target = document.getElementById('settings-result');
      if (!result.ok || !body.ok) { target.textContent = 'Save failed: ' + (body.message || body.error || result.status); return; }
      target.textContent = 'Saved.' + (body.warnings && body.warnings.length ? ' ' + body.warnings.join(' · ') : '');
      refresh();
    }).catch(function(error){ document.getElementById('settings-result').textContent = 'Save failed: ' + error.message; });
  }
  function setAutostart(installed){
    post('/setup/providers/autostart', { installed: installed === true }).then(function(result){
      var body = result.body || {};
      var target = document.getElementById('autostart-result');
      if (!result.ok || !body.ok) { target.textContent = 'Failed: ' + (body.message || body.error || result.status); return; }
      target.textContent = installed ? 'Auto-start installed: ' + (body.autostart && body.autostart.path || '') : 'Auto-start removed.';
      refresh();
    }).catch(function(error){ document.getElementById('autostart-result').textContent = 'Failed: ' + error.message; });
  }
  function selectTab(name){
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function(button){
      button.setAttribute('aria-selected', String(button.dataset.tab === name));
    });
    Array.prototype.forEach.call(document.querySelectorAll('section.panel'), function(panel){
      panel.dataset.active = String(panel.dataset.panel === name);
    });
    if (window.location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'logs') loadLogs();
    if (name === 'settings' && lastStatus) renderSettings(lastStatus);
  }
  function verifyStatus(){
    fetchJson('/setup/status').then(function(result){
      var data = result.body || {};
      var raw = document.getElementById('status-json');
      if (raw) raw.textContent = JSON.stringify(data, null, 2);
      var target = document.getElementById('verify-result');
      var clients = Array.isArray(data.clients) ? data.clients : [];
      var compatible = clients.filter(function(c){ return c.compatible !== false && (!c.compatibility || c.compatibility.compatible !== false); });
      if (data.activeClient) target.textContent = 'Connected and ready: ' + (data.activeClient.title || data.activeClient.id || 'ChatGPT tab');
      else if (compatible.length) target.textContent = compatible.length + ' compatible tab(s) connected; select one in the bridge.';
      else target.textContent = data.error || 'Waiting for a ChatGPT tab with the extension connected.';
    }).catch(function(error){ document.getElementById('verify-result').textContent = 'Status unavailable: ' + error.message; });
  }
  document.querySelectorAll('nav.tabs button').forEach(function(button){
    button.addEventListener('click', function(){ selectTab(button.dataset.tab); });
  });
  document.querySelectorAll('[data-copy]').forEach(function(button){
    button.addEventListener('click', function(){
      var input = document.getElementById(button.dataset.copy);
      if (!input) return;
      navigator.clipboard.writeText(input.value).then(function(){ var old = button.textContent; button.textContent = 'Copied'; setTimeout(function(){ button.textContent = old; }, 900); });
    });
  });
  document.getElementById('verify-status').addEventListener('click', verifyStatus);
  document.getElementById('log-refresh').addEventListener('click', loadLogs);
  document.getElementById('log-provider').addEventListener('change', loadLogs);
  document.getElementById('settings-save').addEventListener('click', saveSettings);
  document.getElementById('autostart-install').addEventListener('click', function(){ setAutostart(true); });
  document.getElementById('autostart-remove').addEventListener('click', function(){ setAutostart(false); });
  var initial = (window.location.hash || '#providers').replace('#', '');
  selectTab(['providers', 'logs', 'settings', 'kodevra'].indexOf(initial) >= 0 ? initial : 'providers');
  verifyStatus();
  refresh().then(function(status){
    if (status && status.refreshMs) setInterval(refresh, Math.max(1500, Math.min(30000, status.refreshMs)));
    else setInterval(refresh, 3000);
  });
})();
</script>
</body></html>`;
}

export function registerProviderRoutes(router, { bridge, providerService }) {
  const service = providerService || new ProviderService({ bridge });

  router.get('/setup', (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Setup page');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(controlHtml());
    } catch (err) { next(err); }
  });

  router.get('/setup/providers/status', async (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider status');
      ok(res, await service.status());
    } catch (err) { next(err); }
  });

  router.get('/setup/providers/settings', (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider settings');
      ok(res, { settings: service.settings(), autostart: service.autostart() });
    } catch (err) { next(err); }
  });

  router.post('/setup/providers/settings', (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider settings');
      requireSameOrigin(req);
      requireJsonRequest(req);
      const result = service.saveSettings(req.body || {});
      ok(res, { settings: result.state, warnings: result.warnings });
    } catch (err) { next(err); }
  });

  router.post('/setup/providers/autostart', (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider auto-start');
      requireSameOrigin(req);
      requireJsonRequest(req);
      const installed = req.body?.installed === true;
      let autostart;
      try {
        autostart = installed ? service.installAutostart() : service.removeAutostart();
      } catch (error) {
        if (String(error?.code || '').startsWith('AUTOSTART_')) {
          throw new HttpError(409, error.message);
        }
        throw error;
      }
      ok(res, { autostart });
    } catch (err) { next(err); }
  });

  router.get('/setup/providers/:id/logs', (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider logs');
      const id = requireProviderId(req.params.id);
      const lines = Math.max(50, Math.min(2_000, Number(req.query?.lines) || 400));
      ok(res, service.logs(id, lines));
    } catch (err) { next(err); }
  });

  router.post('/setup/providers/:id/:action', async (req, res, next) => {
    try {
      requireLocal(bridge, req, 'Provider command');
      requireSameOrigin(req);
      requireJsonRequest(req);
      const id = requireProviderId(req.params.id);
      const action = String(req.params.action || '');
      if (!['start', 'stop', 'restart'].includes(action)) {
        throw new HttpError(404, `Unknown provider action: ${action}`);
      }
      let result;
      if (action === 'start') result = await service.start(id);
      else if (action === 'stop') result = await service.stop(id);
      else result = await service.restart(id);
      // A refused operation is a client-visible conflict, never a fake success:
      // "the port belongs to someone else" must not look like a started provider.
      if (result?.ok === false) {
        throw new HttpError(409, result.message || result.error || `${action} was refused`);
      }
      ok(res, { provider: id, action, ...result });
    } catch (err) { next(err); }
  });
}
