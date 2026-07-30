// Char Companion — 前端扩展(独立弹窗面板版)
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';

// 调试用: 捕获这个插件自己脚本里的报错,直接弹窗显示,方便手机上没有开发者工具时定位问题。
// 只在报错文件路径包含这个插件的目录名时才弹,酒馆别的地方(其他扩展/核心代码)出错不会被误报成这个插件的问题。
const CC_SELF_PATH_HINT = 'char-companion';
window.addEventListener('error', (e) => {
  if (!e.filename || !e.filename.includes(CC_SELF_PATH_HINT)) return;
  alert('[随身推送 报错]\n' + e.message + '\n位置: ' + e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  const stack = e.reason?.stack || '';
  if (!stack.includes(CC_SELF_PATH_HINT)) return;
  alert('[随身推送 Promise报错]\n' + (e.reason?.message || e.reason));
});

const API_BASE = '/api/plugins/char-companion';

// ===== 与后端通信 =====
// 用 XMLHttpRequest 而不是 fetch — 因为酒馆里其他扩展会把全局 fetch 替换成有bug的包装版本。
// 另外加了自动重试 — 跨境线路(国内到境外VPS)偶尔会有连接被重置的情况,
// 内容较大的请求(比如保存配置,带着人设/世界书文本)更容易撞上,
// 重试2次基本能自动绕过这种偶发中断,不需要用户手动点第二次。
function xhrRequest(method, url, headers, body, retriesLeft = 2) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 40000; // 最多等40秒,超过就报错,不会无限卡住不动
    Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `请求失败: ${xhr.status}`));
    };
    xhr.ontimeout = () => reject(new Error('请求超时(等了40秒没反应,大概率是AI供应商响应太慢,可以换个模型或供应商试试)'));
    xhr.onerror = () => {
      if (retriesLeft > 0) {
        // 网络层面失败(常见于跨境连接偶发重置),稍等一下自动重试,不打扰用户
        setTimeout(() => {
          xhrRequest(method, url, headers, body, retriesLeft - 1).then(resolve).catch(reject);
        }, 800);
      } else {
        reject(new Error('网络连接失败(已自动重试2次仍未成功),请稍后再手动试一次'));
      }
    };
    xhr.send(body ? JSON.stringify(body) : null);
  });
}

async function apiGet(p) { return xhrRequest('GET', `${API_BASE}${p}`, getRequestHeaders()); }
async function apiPost(p, body) { return xhrRequest('POST', `${API_BASE}${p}`, getRequestHeaders(), body); }
async function apiDelete(p) { return xhrRequest('DELETE', `${API_BASE}${p}`, getRequestHeaders()); }

let ccProfilesCache = {};
async function refreshProfilesCache() {
  try { ccProfilesCache = await apiGet('/profiles'); } catch (e) {}
}
async function syncRecentChatIfNeeded() {
  try {
    const id = profileId();
    const profile = ccProfilesCache[id];
    if (!profile?.use_recent_chat) return;
    if (isCharLockMismatched()) return; // 锁定角色和当前聊天角色不一致时,不要把当前这个人的聊天记录同步进锁定角色的推送资料里
    const count = profile.recent_chat_count || 3;
    const ctx = getContext();
    const chat = ctx.chat || [];
    const recent = chat
      .filter(m => !m.is_user)
      .slice(-count)
      .map(m => ({
        name: m.name || '',
        text: (m.mes || '').replace(/<[^>]*>/g, '').slice(0, 300)
      }));
    await apiPost(`/profiles/${id}`, { recent_chat: recent });
  } catch (e) {}
}

// ===== 读取角色卡 =====
let lockedCharSnapshot = null; // 锁定的推送角色快照，null=未锁定(跟随当前聊天角色)

function getCharData() {
  if (lockedCharSnapshot) return lockedCharSnapshot;
  const ctx = getContext();
  const c = ctx.characters?.[ctx.characterId];
  if (!c) return null;
  return { name:c.name, description:c.description, personality:c.personality, scenario:c.scenario, mes_example:c.mes_example, world:c.data?.extensions?.world||c.world||'', avatar:c.avatar };
}

function isCharLockMismatched() {
  if (!lockedCharSnapshot) return false;
  const ctx = getContext();
  const cur = ctx.characters?.[ctx.characterId];
  return !cur || cur.name !== lockedCharSnapshot.name;
}

function toggleCharLock() {
  if (lockedCharSnapshot) {
    lockedCharSnapshot = null;
  } else {
    const ctx = getContext();
    const c = ctx.characters?.[ctx.characterId];
    if (!c) { alert('当前没有选中角色，无法锁定'); return; }
    lockedCharSnapshot = { name:c.name, description:c.description, personality:c.personality, scenario:c.scenario, mes_example:c.mes_example, world:c.data?.extensions?.world||c.world||'', avatar:c.avatar };
  }
  apiPost(`/profiles/${profileId()}`, { locked_character: lockedCharSnapshot }).catch(()=>{});
  loadProfile();
}

function ensureLockButton(nameEl) {
  if (document.getElementById('cc-lock-btn')) return;
  const btn = document.createElement('span');
  btn.id = 'cc-lock-btn';
  btn.style.cursor = 'pointer';
  btn.style.marginLeft = '8px';
  btn.title = '锁定/解锁推送角色';
  btn.addEventListener('click', toggleCharLock);
  nameEl.insertAdjacentElement('afterend', btn);
}

function updateLockButtonUI() {
  const btn = document.getElementById('cc-lock-btn');
  if (btn) {
    btn.textContent = '🔒';
    btn.style.opacity = lockedCharSnapshot ? '1' : '0.3';
    btn.style.filter = lockedCharSnapshot ? 'none' : 'grayscale(100%)';
  }
  const box = document.getElementById('cc-use-recent-chat');
  if (box) {
    const mismatched = isCharLockMismatched();
    box.disabled = mismatched;
    if (mismatched) box.checked = false;
  }
}

// ===== 读取世界书 =====
async function getWorldEntries() {
  const cd = getCharData(); if (!cd?.world) return [];
  try {
    const d = await xhrRequest('POST', '/api/worldinfo/get', getRequestHeaders(), { name: cd.world });
    return Object.values(d.entries||{}).map(e=>({ uid:String(e.uid), key:Array.isArray(e.key)?e.key.join(','):(e.key||''), comment:e.comment, content:e.content }));
  } catch(e) { return []; }
}

// 所有角色卡共用同一份设置(推送渠道/API/比例等),切换角色卡不会清空。
// 只有"角色人设"和"世界书"这两项是实时读取当前角色卡的,会跟着切换。
// 想让某个角色专属推送、聊别的角色时不受影响,用面板里的"锁定"功能。
function profileId() { return 'global'; }

// ===== 弹窗面板 HTML =====
function panelHtml() {
  return `
<dialog id="cc-dialog" class="cc-dialog">
  <div class="cc-panel">
    <div class="cc-header">
      <div class="cc-header-title">
        <h2>随身推送</h2>
        <div class="cc-header-sub">
          <span class="cc-pulse-dot" id="cc-header-pulse"></span>
          <span id="cc-header-charname">未选择角色</span>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <button id="cc-theme-toggle" class="cc-close-btn" type="button" title="切换外观风格">🎨</button>
        <button id="cc-close" class="cc-close-btn">✕</button>
      </div>
    </div>

    <div class="cc-tabs">
      <div class="cc-tab cc-tab-active" data-tab="general">总设置</div>
      <div class="cc-tab" data-tab="basic">基础推送</div>
      <div class="cc-tab" data-tab="content">进阶推送</div>
      <div class="cc-tab" data-tab="persona">角色设定</div>
      <div class="cc-tab" data-tab="api">API设定</div>
    </div>

    <div class="cc-body">

      <!-- ===== Tab 1: 总设置 ===== -->
      <div class="cc-tab-panel cc-tab-panel-active" data-panel="general">

        <div class="cc-section">
          <h3>总开关</h3>
          <label class="cc-toggle-row">启用当前角色的主动推送
            <input type="checkbox" id="cc-enabled">
          </label>
        </div>

        <div class="cc-section">
          <h3>推送渠道</h3>
          <input type="hidden" id="cc-bark-url" value="https://api.day.app">
          <div class="cc-radio-group" id="cc-channel-group">
            <div class="cc-radio-chip">
              <input type="radio" name="cc-channel" id="cc-ch-bark" value="bark" checked>
              <label for="cc-ch-bark">Bark (iOS)</label>
            </div>
            <div class="cc-radio-chip">
              <input type="radio" name="cc-channel" id="cc-ch-ntfy" value="ntfy">
              <label for="cc-ch-ntfy">ntfy (Android)</label>
            </div>
            <div class="cc-radio-chip">
              <input type="radio" name="cc-channel" id="cc-ch-webhook" value="webhook">
              <label for="cc-ch-webhook">Webhook（多渠道）</label>
            </div>
          </div>
          <div class="cc-channel-field cc-channel-field-active" data-field="bark">
            <label class="cc-label">设备 Key</label>
            <input type="text" id="cc-bark-key" class="cc-input" placeholder="打开 Bark App 复制">
          </div>
          <div class="cc-channel-field" data-field="ntfy">
            <label class="cc-label">ntfy Topic</label>
            <input type="text" id="cc-ntfy-topic" class="cc-input" placeholder="例如 my-companion-xxx">
          </div>
          <div class="cc-channel-field" data-field="webhook">
            <label class="cc-label">Webhook 地址</label>
            <input type="text" id="cc-webhook-url" class="cc-input" placeholder="https://your-server.com/webhook">
            <label class="cc-label">鉴权密钥（可选）</label>
            <input type="text" id="cc-webhook-secret" class="cc-input" placeholder="Bearer Token，不填则不发送">
          </div>
        </div>

        <div class="cc-section">
          <h3>名字与头像</h3>
          <label class="cc-label">通知显示名称</label>
          <input type="text" id="cc-display-name" class="cc-input" placeholder="留空则使用角色名">
          <label class="cc-label">头像图片链接</label>
          <input type="text" id="cc-avatar" class="cc-input" placeholder="https://.../avatar.png">
        </div>

        <div class="cc-section">
          <h3>推送历史记忆</h3>
          <p class="cc-hint">让角色记住最近的推送避免重复，拖到0则关闭，不记录任何历史。</p>
          <div class="cc-ratio-row">
            <div class="cc-ratio-head"><span>记住最近几天的推送</span><span class="cc-ratio-val" id="cc-push-history-days-val">3天</span></div>
            <input type="range" class="cc-slider" min="0" max="7" step="1" value="3" id="cc-push-history-days">
          </div>
        </div>

        <div class="cc-section">
          <h3>推送内容比例</h3>
          <p class="cc-hint">拖动滑块分配各类内容的权重，合计建议等于100。</p>
          <div class="cc-ratio-row">
            <div class="cc-ratio-head"><span>日常闲聊</span><span class="cc-ratio-val" id="cc-rv-daily">40%</span></div>
            <input type="range" class="cc-slider" min="0" max="100" step="10" value="40" id="cc-slider-daily">
          </div>
          <div class="cc-ratio-row">
            <div class="cc-ratio-head"><span>天气播报</span><span class="cc-ratio-val" id="cc-rv-weather">10%</span></div>
            <input type="range" class="cc-slider" min="0" max="100" step="10" value="10" id="cc-slider-weather">
          </div>
          <div class="cc-ratio-row">
            <div class="cc-ratio-head"><span>健康提醒</span><span class="cc-ratio-val" id="cc-rv-health">40%</span></div>
            <input type="range" class="cc-slider" min="0" max="100" step="10" value="40" id="cc-slider-health">
          </div>
          <div class="cc-ratio-row">
            <div class="cc-ratio-head"><span>其他/自由发挥</span><span class="cc-ratio-val" id="cc-rv-other">10%</span></div>
            <input type="range" class="cc-slider" min="0" max="100" step="10" value="10" id="cc-slider-other">
          </div>
          <div class="cc-ratio-sum">
            <span>合计</span>
            <span id="cc-ratio-total" class="cc-ratio-sum-ok">100%</span>
          </div>
          <!-- 隐藏 number input 供原有 collectData() / updateRatioHint() 读取 -->
          <input type="hidden" id="cc-ratio-daily" value="40">
          <input type="hidden" id="cc-ratio-weather" value="10">
          <input type="hidden" id="cc-ratio-health" value="40">
          <input type="hidden" id="cc-ratio-other" value="10">
          <div id="cc-ratio-hint" style="display:none"></div>
        </div>

      </div>

      <!-- ===== Tab 2: 基础推送 ===== -->
      <div class="cc-tab-panel" data-panel="basic">

        <div class="cc-section">
          <h3>发送频率</h3>
          <label class="cc-toggle-row">间隔模式
            <input type="checkbox" id="cc-interval-enabled">
          </label>
          <div id="cc-interval-block" style="margin-top:8px">
            <label class="cc-label">间隔（分钟）</label>
            <input type="number" id="cc-interval" class="cc-input" value="180" min="5">
          </div>
          <label class="cc-toggle-row" style="margin-top:12px">定时模式
            <input type="checkbox" id="cc-schedule-enabled">
          </label>
          <div id="cc-schedule-block" style="margin-top:8px">
            <div id="cc-schedule-list"></div>
            <button id="cc-add-time" class="cc-btn cc-btn-sm" type="button">+ 添加时间点</button>
            <p class="cc-hint">时间以服务器时区为准，每个时间点每天最多触发一次</p>
          </div>
        </div>

        <div class="cc-section">
          <h3>勿扰模式</h3>
          <label class="cc-toggle-row">勿扰时段
            <input type="checkbox" id="cc-dnd-enabled">
          </label>
          <div class="cc-row" style="margin-top:8px">
            <label class="cc-label" style="flex:1">开始<input type="time" id="cc-dnd-start" class="cc-input" value="23:00"></label>
            <label class="cc-label" style="flex:1">结束<input type="time" id="cc-dnd-end" class="cc-input" value="08:00"></label>
          </div>
          <p class="cc-hint">暂停间隔/定时常规推送；支持跨零点。不影响定时提醒和即时提醒。</p>
        </div>

        <div class="cc-section">
          <h3>定时提醒（最多同时3个）</h3>
          <p class="cc-hint">到点由当前角色主动提醒，触发一次后自动消失。</p>
          <label class="cc-label">目标时间</label>
          <input type="datetime-local" id="cc-reminder-time" class="cc-input">
          <label class="cc-label">提前几分钟触发</label>
          <input type="number" id="cc-reminder-lead" class="cc-input" value="5" min="0">
          <label class="cc-label">事由</label>
          <input type="text" id="cc-reminder-event" class="cc-input" placeholder="比如: 19点的演唱会门票开抢">
          <button id="cc-reminder-add" class="cc-btn cc-btn-sm" type="button" style="margin-top:8px">添加提醒</button>
          <div id="cc-reminder-list" class="cc-hint" style="margin-top:8px">加载中...</div>
        </div>

        <div class="cc-section">
          <h3>即时提醒</h3>
          <div id="cc-focus-status" class="cc-hint">加载中...</div>

          <label class="cc-label">多久后提醒（分钟）</label>
          <input type="number" id="cc-focus-minutes" class="cc-input" placeholder="例如 30" min="1">
          <label class="cc-label" style="margin-top:8px">事由</label>
          <input type="text" id="cc-focus-reason" class="cc-input" placeholder="例如: 午休半小时">
          <button id="cc-start-focus" class="cc-btn cc-btn-primary cc-btn-sm" type="button" style="margin-top:8px">开始提醒</button>

          <p class="cc-hint" style="margin-top:14px">安卓没有系统自带的快捷指令，直接用上面这个就行。iOS 也可以改用「快捷指令」App 远程触发（比如配合专注模式自动执行）：</p>
          <label class="cc-label">快捷指令请求地址</label>
          <div class="cc-row">
            <input type="text" id="cc-focus-url" class="cc-input" readonly>
            <button id="cc-copy-focus-url" class="cc-btn cc-btn-sm" type="button">复制</button>
          </div>
          <button id="cc-cancel-focus" class="cc-btn cc-btn-sm" type="button" style="margin-top:8px">取消当前提醒</button>
        </div>

      </div>

      <!-- ===== Tab 3: 推送内容 ===== -->
      <div class="cc-tab-panel" data-panel="content">

        <div class="cc-feature-card cc-feature-on" data-feature="weather">
          <div class="cc-feature-head">
            <div class="cc-feature-title">
              <span class="cc-feature-icon">☁️</span>
              <div>天气<div class="cc-feature-desc">播报所在地实时天气</div></div>
            </div>
            <input type="checkbox" class="cc-feature-switch" id="cc-weather-switch" checked>
          </div>
          <div class="cc-feature-body">
            <label class="cc-label">城市（中文或英文均可，也可以精确到区，比如 上海/静安区）</label>
            <div class="cc-row">
              <input type="text" id="cc-weather-city" class="cc-input" placeholder="例如: 上海 / Tokyo / 上海/静安区">
              <button id="cc-test-weather" class="cc-btn cc-btn-sm" type="button">测试</button>
            </div>
            <div id="cc-weather-result" class="cc-hint"></div>
          </div>
        </div>

        <div class="cc-feature-card" data-feature="health">
          <div class="cc-feature-head">
            <div class="cc-feature-title">
              <span class="cc-feature-icon">❤️</span>
              <div>健康数据<div class="cc-feature-desc">读取步数 / 睡眠 / 心率等</div></div>
            </div>
            <input type="checkbox" class="cc-feature-switch" id="cc-use-health">
          </div>
          <div class="cc-feature-body">
            <p class="cc-hint">当前功能仅支持iOS系统，使用快捷指令将健康数据发送至后端。</p>
            <p class="cc-hint">↓将如下地址复制到快捷指令指定位置即可</p>
            <div class="cc-row">
              <input type="text" id="cc-health-url" class="cc-input" readonly>
              <button id="cc-copy-health-url" class="cc-btn cc-btn-sm" type="button">复制</button>
            </div>
            <div id="cc-health-status" class="cc-hint"></div>
            <p class="cc-hint" style="margin-top:8px">勾选下面想让角色知道的指标(快捷指令本身会照常发送全部字段，这里只影响角色摘要里显示哪些)：</p>
            <div class="cc-wi-list" style="display:flex; flex-wrap:wrap; gap:0 14px">
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-steps" checked> 步数</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-rhr" checked> 静息心率</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-hrv" checked> HRV</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-sleep" checked> 睡眠</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-resp" checked> 呼吸频率</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-period" checked> 经期</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-spo2" checked> 血氧</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-temp" checked> 体温</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-mood" checked> 心理健康</label>
              <label class="cc-wi-item"><input type="checkbox" id="cc-health-metric-exercise" checked> 运动记录</label>
            </div>
          </div>
        </div>

        <div class="cc-feature-card" data-feature="recent-chat">
          <div class="cc-feature-head">
            <div class="cc-feature-title">
              <span class="cc-feature-icon">💬</span>
              <div>读取最近聊天记录<div class="cc-feature-desc">让消息更贴近你们正在聊的剧情</div></div>
            </div>
            <input type="checkbox" class="cc-feature-switch" id="cc-use-recent-chat">
          </div>
          <div class="cc-feature-body">
            <div class="cc-ratio-row">
              <div class="cc-ratio-head"><span>读取条数</span><span class="cc-ratio-val" id="cc-recent-chat-count-val">3条</span></div>
              <input type="range" class="cc-slider" min="1" max="5" value="3" id="cc-recent-chat-count">
            </div>
            <p class="cc-hint">只读取{{char}}自己发送的消息，不读取你的发言。</p>
          </div>
        </div>

      </div>

      <!-- ===== Tab 4: 角色设定 ===== -->
      <div class="cc-tab-panel" data-panel="persona">

        <div class="cc-section">
          <h3>用户人设</h3>
          <p class="cc-hint">留空默认使用当前用户人设，如想使用其他设定请填写人设。</p>
          <label class="cc-label">你的名字 / 身份</label>
          <input type="text" id="cc-persona-name" class="cc-input" placeholder="角色会怎么称呼你">
          <label class="cc-label">人设描述</label>
          <textarea id="cc-persona-desc" class="cc-input cc-textarea" rows="3" placeholder="关于你的背景、身份、关系等"></textarea>
        </div>

        <div class="cc-section">
          <h3>角色人设</h3>
          <p class="cc-hint">角色人设自动读取当前角色卡，不用手填。</p>
          <label class="cc-label">世界书条目</label>
          <div class="cc-select-wrap">
            <select id="cc-wi-mode" class="cc-select">
              <option value="none">不读取</option>
              <option value="all">全部读取</option>
              <option value="selected">手动选择</option>
            </select>
          </div>
          <div id="cc-wi-list" class="cc-wi-list" style="display:none; margin-top:8px"></div>
        </div>

        <div class="cc-section">
          <h3>自定义提示词</h3>
          <textarea id="cc-prompt" class="cc-input cc-textarea" rows="4" placeholder="指导 AI 怎么根据人设发消息"></textarea>
        </div>

      </div>

      <!-- ===== Tab 5: API 设定 ===== -->
      <div class="cc-tab-panel" data-panel="api">

        <div class="cc-section">
          <h3>已保存的 API 连接配置</h3>
          <div class="cc-row">
            <select id="cc-preset-select" class="cc-input"><option value="">-- 选择已保存的配置 --</option></select>
            <button id="cc-preset-apply" class="cc-btn cc-btn-sm" type="button">应用</button>
            <button id="cc-preset-delete" class="cc-btn cc-btn-sm" type="button">删除</button>
          </div>
          <button id="cc-preset-save" class="cc-btn cc-btn-sm" type="button" style="margin-top:8px">将下面当前配置保存为新的连接配置</button>
        </div>

        <div class="cc-section">
          <h3>API 配置</h3>
          <label class="cc-label">供应商</label>
          <div class="cc-select-wrap">
            <select id="cc-provider" class="cc-select">
              <option value="openai_compatible">OpenAI 兼容（GPT / 中转站）</option>
              <option value="gemini_official">Gemini 官方</option>
              <option value="deepseek_official">DeepSeek 官方</option>
            </select>
          </div>
          <label class="cc-label" id="cc-baseurl-label">Base URL
            <input type="text" id="cc-baseurl" class="cc-input" placeholder="https://api.openai.com/v1">
          </label>
          <label class="cc-label">API Key</label>
          <input type="password" id="cc-api-key" class="cc-input" autocomplete="off" spellcheck="false">
          <label class="cc-label">模型</label>
          <div class="cc-row">
            <select id="cc-model-select" class="cc-input"><option value="">-- 先点右边获取 --</option></select>
            <button id="cc-fetch-models" class="cc-btn cc-btn-sm" type="button">获取</button>
          </div>
          <label class="cc-toggle-row" style="margin-top:10px">手动输入模型名
            <input type="checkbox" id="cc-model-manual-toggle">
          </label>
          <div id="cc-model-manual-block" style="display:none; margin-top:6px">
            <input type="text" id="cc-model-manual" class="cc-input" placeholder="手动输入模型名">
          </div>
        </div>

        <div class="cc-section cc-actions">
          <button id="cc-test-api" class="cc-btn" type="button">测试 API 连接</button>
          <button id="cc-test-send" class="cc-btn cc-btn-primary" type="button">测试发送（推送到手机）</button>
        </div>

      </div>

    </div>

    <div class="cc-footer">
      <button id="cc-save" class="cc-btn cc-btn-primary cc-save-btn" type="button">保存所有设置</button>
      <div id="cc-status" class="cc-status"></div>
    </div>
  </div>
</dialog>`;
}

// ===== 顶部呼吸灯 + 角色名 状态同步 =====
function updateHeaderStatus(enabled) {
  const dot = document.getElementById('cc-header-pulse');
  const nameEl = document.getElementById('cc-header-charname');
  if (dot) {
    dot.classList.remove('cc-pulse-on', 'cc-pulse-off');
    dot.classList.add(enabled ? 'cc-pulse-on' : 'cc-pulse-off');
  }
  if (nameEl) {
    const charName = (getCharData()?.name || '').trim();
    nameEl.textContent = charName || '未选择角色';
    ensureLockButton(nameEl);
    updateLockButtonUI();
  }
}

// ===== 数据载入/收集 =====
async function loadProfile() {
  let profiles = {};
  try { profiles = await apiGet('/profiles'); } catch(e) { return; }
  let p = profiles[profileId()] || {};
  lockedCharSnapshot = p.locked_character || null; // 页面刷新后恢复角色锁状态

  // 自动找回: 如果当前头像还没有配置,但存在其他配置的角色名和当前角色名一致,
  // 说明大概率是"同一个角色换了头像图片"导致的,把那份配置的内容拿来预填,
  // 但不自动保存 — 需要用户自己确认后点"保存配置"才会真正写入。
  const isEmpty = Object.keys(p).length === 0;
  if (isEmpty) {
    const curName = (getCharData()?.name || '').trim();
    if (curName) {
      const match = Object.values(profiles).find(v => (v.character_name || '').trim() === curName);
      if (match) {
        p = match;
        setStatus(`检测到"${curName}"之前有过配置,已自动带入,确认无误后请点"保存配置"`);
      }
    }
  }

  document.getElementById('cc-enabled').checked = !!p.enabled;
  updateHeaderStatus(!!p.enabled);
  document.getElementById('cc-bark-url').value = p.bark_server_url || '';
  document.getElementById('cc-bark-key').value = p.bark_device_key || '';
  document.getElementById('cc-ntfy-topic').value = p.ntfy_topic || '';
  document.getElementById('cc-webhook-url').value = p.webhook_url || '';
  document.getElementById('cc-webhook-secret').value = p.webhook_secret || '';
  const channel = p.push_channel || 'bark';
  const channelRadio = document.getElementById('cc-ch-' + channel);
  if (channelRadio) channelRadio.checked = true;
  document.querySelectorAll('.cc-channel-field').forEach(f => f.classList.remove('cc-channel-field-active'));
  const activeField = document.querySelector('.cc-channel-field[data-field="' + channel + '"]');
  if (activeField) activeField.classList.add('cc-channel-field-active');
  document.getElementById('cc-display-name').value = p.display_name || '';
  document.getElementById('cc-avatar').value = p.avatar_url || '';
  document.getElementById('cc-interval-enabled').checked = !!p.interval_enabled;
  document.getElementById('cc-interval').value = p.interval_minutes || 180;
  document.getElementById('cc-schedule-enabled').checked = !!p.schedule_enabled;
  document.getElementById('cc-dnd-enabled').checked = !!p.dnd_enabled;
  document.getElementById('cc-dnd-start').value = p.dnd_start || '23:00';
  document.getElementById('cc-dnd-end').value = p.dnd_end || '08:00';
  renderSchedule(p.schedule_times || [{time:'08:00',note:''},{time:'12:00',note:''},{time:'20:00',note:''},{time:'00:00',note:''}]);
  document.getElementById('cc-weather-city').value = p.weather_city || '';
  document.getElementById('cc-weather-switch').checked = p.weather_enabled !== false; // 默认开启，兼容老数据
  document.getElementById('cc-use-health').checked = !!p.use_health_data;
  {
    const hm = p.health_metrics || {};
    document.getElementById('cc-health-metric-steps').checked = hm.steps !== false;
    document.getElementById('cc-health-metric-rhr').checked = hm.rhr !== false;
    document.getElementById('cc-health-metric-hrv').checked = hm.hrv !== false;
    document.getElementById('cc-health-metric-sleep').checked = hm.sleep !== false;
    document.getElementById('cc-health-metric-resp').checked = hm.resp !== false;
    document.getElementById('cc-health-metric-period').checked = hm.period !== false;
    document.getElementById('cc-health-metric-spo2').checked = hm.spo2 !== false;
    document.getElementById('cc-health-metric-temp').checked = hm.temp !== false;
    document.getElementById('cc-health-metric-mood').checked = hm.mood !== false;
    document.getElementById('cc-health-metric-exercise').checked = hm.exercise !== false;
  }
  loadHealthInfo();
  loadFocusInfo();
  loadRemindersList();
  loadApiPresets();
  document.getElementById('cc-wi-mode').value = p.world_info_mode || 'none';
  document.getElementById('cc-prompt').value = p.custom_prompt || '';
  document.getElementById('cc-persona-name').value = p.user_persona?.name || '';
  document.getElementById('cc-persona-desc').value = p.user_persona?.description || '';
  document.getElementById('cc-use-recent-chat').checked = !!p.use_recent_chat;
  const recentChatCount = p.recent_chat_count || 3;
  document.getElementById('cc-recent-chat-count').value = recentChatCount;
  document.getElementById('cc-recent-chat-count-val').textContent = recentChatCount + '条';
  // 按已保存的开关状态展开/收起对应的功能卡片(避免明明勾选了但内容还是收起的)
  document.querySelectorAll('.cc-feature-card .cc-feature-switch').forEach(sw => {
    sw.closest('.cc-feature-card').classList.toggle('cc-feature-on', sw.checked);
  });
  const pushHistoryDays = p.push_history_days === undefined ? 3 : p.push_history_days;
  document.getElementById('cc-push-history-days').value = pushHistoryDays;
  document.getElementById('cc-push-history-days-val').textContent = pushHistoryDays == 0 ? '已关闭' : pushHistoryDays + '天';
  const ratio = p.content_ratio || { daily: 40, weather: 10, health: 40, other: 10 };
  document.getElementById('cc-ratio-daily').value = ratio.daily;
  document.getElementById('cc-ratio-weather').value = ratio.weather;
  document.getElementById('cc-ratio-health').value = ratio.health;
  document.getElementById('cc-ratio-other').value = ratio.other;
  updateRatioHint();
  syncSlidersFromInputs();
  // 按开关状态锁定/解锁天气、健康两个滑轨(开关关着的话滑轨归零锁死，不参与抽奖)
  applyFeatureLock('cc-weather-switch', 'cc-slider-weather', 'cc-ratio-weather', 'cc-rv-weather');
  applyFeatureLock('cc-use-health',     'cc-slider-health',  'cc-ratio-health',  'cc-rv-health');

  const api = p.api || {};
  document.getElementById('cc-provider').value = api.provider || 'openai_compatible';
  setApiKeyField(api.api_key || '');
  document.getElementById('cc-baseurl').value = api.base_url || '';
  if (api.model) {
    const sel = document.getElementById('cc-model-select');
    const opt = document.createElement('option'); opt.value = api.model; opt.textContent = api.model;
    sel.appendChild(opt); sel.value = api.model;
  }
  toggleProvider();
  await renderWI(p.world_info_mode, p.selected_world_info_keys || []);
}

async function collectData() {
  const cd = getCharData();
  const wiMode = document.getElementById('cc-wi-mode').value;
  const wiKeys = Array.from(document.querySelectorAll('.cc-wi-cb:checked')).map(el=>el.value);
  const wiEntries = wiMode === 'none' ? [] : await getWorldEntries();
  const manualModel = document.getElementById('cc-model-manual-toggle').checked;
  const model = manualModel ? document.getElementById('cc-model-manual').value.trim() : document.getElementById('cc-model-select').value;

  const contentRatio = {
    daily: parseInt(document.getElementById('cc-ratio-daily').value, 10) || 0,
    weather: parseInt(document.getElementById('cc-ratio-weather').value, 10) || 0,
    health: parseInt(document.getElementById('cc-ratio-health').value, 10) || 0,
    other: parseInt(document.getElementById('cc-ratio-other').value, 10) || 0,
  };

  return {
    character_name: cd?.name || '', character_data: cd,
    use_recent_chat: document.getElementById('cc-use-recent-chat').checked,
    recent_chat_count: parseInt(document.getElementById('cc-recent-chat-count').value, 10) || 3,
    push_history_days: parseInt(document.getElementById('cc-push-history-days').value, 10),
    content_ratio: contentRatio,
    user_persona: {
      name: document.getElementById('cc-persona-name').value.trim(),
      description: document.getElementById('cc-persona-desc').value.trim()
    },
    enabled: document.getElementById('cc-enabled').checked,
    bark_server_url: document.getElementById('cc-bark-url').value.trim(),
    bark_device_key: document.getElementById('cc-bark-key').value.trim(),
    ntfy_topic: document.getElementById('cc-ntfy-topic').value.trim(),
    webhook_url: document.getElementById('cc-webhook-url').value.trim(),
    webhook_secret: document.getElementById('cc-webhook-secret').value.trim(),
    push_channel: document.querySelector('#cc-channel-group input[name="cc-channel"]:checked')?.value || 'bark',
    display_name: document.getElementById('cc-display-name').value.trim(),
    avatar_url: document.getElementById('cc-avatar').value.trim(),
    interval_enabled: document.getElementById('cc-interval-enabled').checked,
    interval_minutes: parseInt(document.getElementById('cc-interval').value,10)||180,
    schedule_enabled: document.getElementById('cc-schedule-enabled').checked,
    schedule_times: getTimesFromForm(),
    dnd_enabled: document.getElementById('cc-dnd-enabled').checked,
    dnd_start: document.getElementById('cc-dnd-start').value,
    dnd_end: document.getElementById('cc-dnd-end').value,
    weather_city: document.getElementById('cc-weather-city').value.trim(),
    weather_enabled: document.getElementById('cc-weather-switch').checked,
    use_health_data: document.getElementById('cc-use-health').checked,
    health_metrics: {
      steps: document.getElementById('cc-health-metric-steps').checked,
      rhr: document.getElementById('cc-health-metric-rhr').checked,
      hrv: document.getElementById('cc-health-metric-hrv').checked,
      sleep: document.getElementById('cc-health-metric-sleep').checked,
      resp: document.getElementById('cc-health-metric-resp').checked,
      period: document.getElementById('cc-health-metric-period').checked,
      spo2: document.getElementById('cc-health-metric-spo2').checked,
      temp: document.getElementById('cc-health-metric-temp').checked,
      mood: document.getElementById('cc-health-metric-mood').checked,
      exercise: document.getElementById('cc-health-metric-exercise').checked,
    },
    custom_prompt: document.getElementById('cc-prompt').value.trim(),
    world_info_mode: wiMode,
    world_info_entries: wiEntries,
    selected_world_info_keys: wiMode==='selected'?wiKeys:(wiMode==='all'?wiEntries.map(e=>e.uid):[]),
    api: {
      provider: document.getElementById('cc-provider').value,
      api_key: getApiKeyValue(),
      base_url: document.getElementById('cc-baseurl').value.trim(),
      model
    }
  };
}

// ===== UI helpers =====
function updateRatioHint() {
  const sum = ['cc-ratio-daily','cc-ratio-weather','cc-ratio-health','cc-ratio-other']
    .reduce((s, id) => s + (parseInt(document.getElementById(id).value, 10) || 0), 0);
  const el = document.getElementById('cc-ratio-hint');
  el.textContent = sum === 100 ? `合计: ${sum}% ✓` : `合计: ${sum}%(建议凑够100,不是硬性要求,系统会按比例自动折算)`;
}

// 根据功能开关(天气/健康)的勾选状态，锁定/解锁对应的比例滑轨。
// 关掉开关 -> 滑轨归零、禁用、变灰，不再参与消息类型的抽奖；
// 打开开关 -> 恢复成关闭前的数值(第一次打开则沿用页面默认值)。
function applyFeatureLock(switchId, sliderId, hiddenInputId, valSpanId) {
  const sw = document.getElementById(switchId);
  const slider = document.getElementById(sliderId);
  const hidden = document.getElementById(hiddenInputId);
  const valSpan = document.getElementById(valSpanId);
  if (!sw || !slider || !hidden) return;

  if (!sw.checked) {
    // 锁定前先把当前值记下来，方便下次打开开关时恢复
    if (slider.value !== '0') slider.dataset.prevVal = slider.value;
    slider.value = 0;
    hidden.value = 0;
    if (valSpan) valSpan.textContent = '0%';
    slider.disabled = true;
    slider.style.opacity = '0.4';
    slider.style.cursor = 'not-allowed';
  } else {
    const restoreVal = slider.dataset.prevVal || slider.value || 10;
    slider.value = restoreVal;
    hidden.value = restoreVal;
    if (valSpan) valSpan.textContent = restoreVal + '%';
    slider.disabled = false;
    slider.style.opacity = '';
    slider.style.cursor = '';
  }
  updateRatioHint();
}

function syncSlidersFromInputs() {
  const pairs = [
    ['cc-slider-daily',   'cc-ratio-daily',   'cc-rv-daily'],
    ['cc-slider-weather', 'cc-ratio-weather',  'cc-rv-weather'],
    ['cc-slider-health',  'cc-ratio-health',   'cc-rv-health'],
    ['cc-slider-other',   'cc-ratio-other',    'cc-rv-other'],
  ];
  let total = 0;
  pairs.forEach(([sliderId, inputId, valId]) => {
    const slider = document.getElementById(sliderId);
    const input  = document.getElementById(inputId);
    if (!slider || !input) return;
    const val = parseInt(input.value, 10) || 0;
    slider.value = val;
    const valEl = document.getElementById(valId);
    if (valEl) valEl.textContent = val + '%';
    total += val;
  });
  const totalEl = document.getElementById('cc-ratio-total');
  if (totalEl) {
    totalEl.textContent = total + '%';
    totalEl.className = total === 100 ? 'cc-ratio-sum-ok' : 'cc-ratio-sum-bad';
  }
}

const CC_PROVIDER_FIXED_BASE_URLS = {
  gemini_official: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  deepseek_official: 'https://api.deepseek.com',
};

function toggleProvider() {
  const val = document.getElementById('cc-provider').value;
  const fixedUrl = CC_PROVIDER_FIXED_BASE_URLS[val];
  const baseUrlInput = document.getElementById('cc-baseurl');
  if (fixedUrl) {
    baseUrlInput.value = fixedUrl;
    baseUrlInput.readOnly = true;
  } else {
    baseUrlInput.readOnly = false;
  }
}

function currentApiFormValues() {
  const manualModel = document.getElementById('cc-model-manual-toggle').checked;
  return {
    provider: document.getElementById('cc-provider').value,
    base_url: document.getElementById('cc-baseurl').value.trim(),
    api_key: getApiKeyValue(),
    model: manualModel ? document.getElementById('cc-model-manual').value.trim() : document.getElementById('cc-model-select').value,
  };
}

let ccApiKeyReal = '';
function maskApiKey(k) {
  if (!k) return '';
  return k.length <= 4 ? '\u2022'.repeat(k.length) : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4);
}
function setApiKeyField(k) {
  ccApiKeyReal = (k || '').trim();
  document.getElementById('cc-api-key').value = maskApiKey(ccApiKeyReal);
}
function getApiKeyValue() { return ccApiKeyReal; }

let ccApiPresetsCache = [];
async function loadApiPresets() {
  try { ccApiPresetsCache = await apiGet('/api-presets'); } catch (e) { ccApiPresetsCache = []; }
  const sel = document.getElementById('cc-preset-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- 选择已保存的配置 --</option>' +
    (ccApiPresetsCache || []).map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  if (prev && (ccApiPresetsCache || []).some(p => p.name === prev)) sel.value = prev;
}

async function onPresetSave() {
  const name = (prompt('给这个 API 连接配置起个名字(比如"日常Gemini"):') || '').trim();
  if (!name) return;
  const cfg = currentApiFormValues();
  if (!cfg.api_key) { setStatus('请先填写 API Key 再保存', true); return; }
  try {
    await apiPost('/api-presets', { name, ...cfg });
    await loadApiPresets();
    document.getElementById('cc-preset-select').value = name;
    setStatus('API 连接配置已保存: ' + name);
  } catch (e) { setStatus('保存配置失败: ' + e.message, true); }
}

function onPresetApply() {
  const name = document.getElementById('cc-preset-select').value;
  if (!name) return;
  const p = (ccApiPresetsCache || []).find(x => x.name === name);
  if (!p) return;
  document.getElementById('cc-provider').value = p.provider || 'openai_compatible';
  toggleProvider();
  if (!CC_PROVIDER_FIXED_BASE_URLS[p.provider]) {
    document.getElementById('cc-baseurl').value = p.base_url || '';
  }
  setApiKeyField(p.api_key || '');
  document.getElementById('cc-model-manual-toggle').checked = true;
  document.getElementById('cc-model-manual-block').style.display = 'block';
  document.getElementById('cc-model-manual').value = p.model || '';
  setStatus('已应用配置: ' + name + '（记得点"保存所有设置"才会真正生效）');
}

async function onPresetDelete() {
  const name = document.getElementById('cc-preset-select').value;
  if (!name) return;
  if (!confirm('确定删除这个 API 连接配置"' + name + '"？')) return;
  try {
    await apiDelete('/api-presets/' + encodeURIComponent(name));
    await loadApiPresets();
    setStatus('API 连接配置已删除: ' + name);
  } catch (e) { setStatus('删除配置失败: ' + e.message, true); }
}

function renderSchedule(times) {
  const c = document.getElementById('cc-schedule-list');
  c.innerHTML = times.map((t) => {
    const time = typeof t === 'string' ? t : (t.time || '');
    const note = typeof t === 'string' ? '' : (t.note || '');
    const noteEsc = String(note).replace(/"/g, '&quot;');
    return `<div class="cc-row cc-time-row"><input type="time" class="cc-input cc-time-input" value="${time}"><input type="text" class="cc-input cc-time-note" placeholder="这个点聊什么(留空自由发挥)" value="${noteEsc}"><button class="cc-btn cc-btn-sm cc-rm-time">删除</button></div>`;
  }).join('');
  c.querySelectorAll('.cc-rm-time').forEach(b=>b.addEventListener('click',()=>b.closest('.cc-time-row').remove()));
}
function getTimesFromForm() {
  return Array.from(document.querySelectorAll('.cc-time-row')).map(row => ({
    time: row.querySelector('.cc-time-input').value,
    note: row.querySelector('.cc-time-note').value.trim()
  })).filter(t => t.time);
}

async function renderWI(mode, keys) {
  const c = document.getElementById('cc-wi-list');
  if (mode!=='selected') { c.style.display='none'; c.innerHTML=''; return; }
  c.style.display='block'; c.innerHTML='<i>加载中...</i>';
  const entries = await getWorldEntries();
  c.innerHTML = entries.map(e=>`<label class="cc-wi-item"><input type="checkbox" class="cc-wi-cb" value="${e.uid}" ${keys.includes(e.uid)?'checked':''}> ${e.comment||e.key||'条目 '+e.uid}</label>`).join('') || '<i>当前角色没有世界书条目</i>';
}

let ccStatusTimer = null;
function setStatus(txt, err=false) {
  const el=document.getElementById('cc-status');
  el.textContent=txt;
  el.style.color=err?'#e06666':'#6aa84f';
  clearTimeout(ccStatusTimer);
  if (txt) {
    ccStatusTimer = setTimeout(() => { if (el.textContent === txt) el.textContent = ''; }, 4000);
  }
}

// ===== 事件处理 =====
async function onSave() {
  try {
    const data = await collectData();
    const result = await apiPost(`/profiles/${encodeURIComponent(profileId())}`, data);
    const displayName = (getCharData()?.avatar || '').trim() || profileId();
    setStatus('已保存 (id=' + displayName + ')');
    refreshProfilesCache();
  } catch(e) {
    setStatus('保存失败: '+e.message, true);
    alert('[保存失败详情]\n' + e.stack || e.message);
  }
}

async function onTestSend() {
  setStatus('发送中...');
  try { await apiPost(`/profiles/${encodeURIComponent(profileId())}`, await collectData()); const r=await apiPost(`/profiles/${encodeURIComponent(profileId())}/test-send`,{}); setStatus('已发送: '+r.message); }
  catch(e) { setStatus('发送失败: '+e.message,true); }
}

async function onTestApi() {
  setStatus('测试中...');
  try { const d=await collectData(); const r=await apiPost('/test-api',{api:d.api}); setStatus('API正常: '+r.message); }
  catch(e) { setStatus('API测试失败: '+e.message,true); }
}

async function onFetchModels() {
  setStatus('拉取模型...');
  try {
    const prov=document.getElementById('cc-provider').value;
    const key=getApiKeyValue();
    const base=document.getElementById('cc-baseurl').value.trim();
    const r=await apiPost('/fetch-models',{provider:prov,api_key:key,base_url:base});
    const sel=document.getElementById('cc-model-select');
    sel.innerHTML='<option value="">-- 选择模型 --</option>'+r.models.map(m=>`<option value="${m}">${m}</option>`).join('');
    setStatus(`已拉取 ${r.models.length} 个模型`);
  } catch(e) { setStatus('拉取失败: '+e.message,true); }
}

async function loadHealthInfo() {
  const urlInput = document.getElementById('cc-health-url');
  const statusEl = document.getElementById('cc-health-status');
  try {
    const info = await apiGet('/health-info');
    const url = `http://${location.hostname}:2588/health-data?key=${info.secret}`;
    urlInput.value = url;
    statusEl.textContent = info.last_received_at
      ? `上次收到数据: ${new Date(info.last_received_at).toLocaleString('zh-CN')}${info.summary ? '\n' + info.summary : ''}`
      : '尚未收到过数据';
  } catch (e) {
    statusEl.textContent = '加载健康数据配置信息失败: ' + e.message;
  }
}

async function loadRemindersList() {
  const el = document.getElementById('cc-reminder-list');
  try {
    const list = await apiGet('/reminders');
    if (!list.length) { el.innerHTML = '<i>当前没有设置提醒</i>'; return; }
    el.innerHTML = list.map(r => {
      const t = new Date(r.targetTime).toLocaleString('zh-CN');
      return `<div class="cc-row"><span>${t}(提前${r.leadMinutes}分钟)· ${r.event || '(未填事由)'} · ${r.characterName}</span><button class="cc-btn cc-btn-sm cc-reminder-cancel" data-id="${r.id}" type="button">取消</button></div>`;
    }).join('');
  } catch (e) {
    el.textContent = '加载提醒列表失败: ' + e.message;
  }
}

async function onAddReminder() {
  const targetTime = document.getElementById('cc-reminder-time').value;
  const leadMinutes = parseInt(document.getElementById('cc-reminder-lead').value, 10) || 0;
  const event = document.getElementById('cc-reminder-event').value.trim();
  if (!targetTime) { setStatus('请先选择目标时间', true); return; }
  try {
    await apiPost('/reminders', { targetTime, leadMinutes, event });
    setStatus('提醒已添加');
    document.getElementById('cc-reminder-event').value = '';
    loadRemindersList();
  } catch (e) {
    setStatus('添加失败: ' + e.message, true);
  }
}

async function loadFocusInfo() {
  const el = document.getElementById('cc-focus-status');
  const urlInput = document.getElementById('cc-focus-url');
  try {
    const info = await apiGet('/focus-info');
    urlInput.value = `http://${location.hostname}:2588/focus/start?key=${info.secret}&minutes=45&reason=`;
    if (info.state?.active) {
      const remain = Math.max(0, Math.round((info.state.until - Date.now()) / 60000));
      el.textContent = `提醒进行中,剩余约${remain}分钟${info.state.reason ? '(' + info.state.reason + ')' : ''}`;
    } else {
      el.textContent = '当前没有进行中的提醒';
    }
  } catch (e) {
    el.textContent = '加载提醒信息失败: ' + e.message;
  }
}

async function onTestWeather() {
  const city=document.getElementById('cc-weather-city').value.trim();
  const el=document.getElementById('cc-weather-result');
  if (!city) { el.textContent='请填写城市名'; return; }
  el.textContent='查询中...';
  try { const r=await apiPost('/test-weather',{city}); el.textContent=r.weather; }
  catch(e) { el.textContent='失败: '+e.message; }
}

// ===== 初始化 =====
jQuery(async ()=>{
  // 侧边栏只放一个按钮
  $('#extensions_settings2').append(`
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>随身推送</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
      </div>
      <div class="inline-drawer-content">
        <button id="cc-open-panel" class="menu_button" style="width:100%;padding:10px;">打开随身推送设置面板</button>
      </div>
    </div>
  `);

  // 弹窗面板(用原生 dialog,不受酒馆页面自身布局变形影响,更稳)
  $('body').append(panelHtml());
  const dialogEl = document.getElementById('cc-dialog');

  // ---------- 外观主题切换(默认深色 / 粘土拟态 / 极简-日间 / 极简-夜间, 点一下换下一个) ----------
  const CC_THEME_KEY = 'cc-ui-theme';
  const CC_THEMES = ['default', 'clay', 'minimal-day', 'minimal-night'];
  const CC_THEME_CLASS = {
    'default': null,
    'clay': 'cc-theme-clay',
    'minimal-day': 'cc-theme-minimal-day',
    'minimal-night': 'cc-theme-minimal-night',
  };
  function applyTheme(name) {
    Object.values(CC_THEME_CLASS).forEach(c => { if (c) dialogEl.classList.remove(c); });
    const cls = CC_THEME_CLASS[name];
    if (cls) dialogEl.classList.add(cls);
  }
  let ccCurrentTheme = 'default';
  try {
    const saved = localStorage.getItem(CC_THEME_KEY);
    if (saved && CC_THEMES.includes(saved)) ccCurrentTheme = saved;
  } catch (e) {}
  applyTheme(ccCurrentTheme);
  document.getElementById('cc-theme-toggle')?.addEventListener('click', () => {
    const idx = CC_THEMES.indexOf(ccCurrentTheme);
    ccCurrentTheme = CC_THEMES[(idx + 1) % CC_THEMES.length];
    applyTheme(ccCurrentTheme);
    try { localStorage.setItem(CC_THEME_KEY, ccCurrentTheme); } catch (e) {}
  });


  // ---------- 总开关联动顶部呼吸灯(未保存也实时反馈颜色) ----------
  document.getElementById('cc-enabled')?.addEventListener('change', (e) => {
    updateHeaderStatus(e.target.checked);
  });

  // ---------- Tab 切换 ----------
  document.querySelectorAll('#cc-dialog .cc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#cc-dialog .cc-tab').forEach(t => t.classList.remove('cc-tab-active'));
      document.querySelectorAll('#cc-dialog .cc-tab-panel').forEach(p => p.classList.remove('cc-tab-panel-active'));
      tab.classList.add('cc-tab-active');
      const panel = document.querySelector('#cc-dialog .cc-tab-panel[data-panel="' + tab.dataset.tab + '"]');
      if (panel) panel.classList.add('cc-tab-panel-active');
    });
  });

  // ---------- 推送渠道切换 ----------
  document.querySelectorAll('#cc-channel-group input[name="cc-channel"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.cc-channel-field').forEach(f => f.classList.remove('cc-channel-field-active'));
      const field = document.querySelector('.cc-channel-field[data-field="' + radio.value + '"]');
      if (field) field.classList.add('cc-channel-field-active');
    });
  });

  // ---------- 推送内容卡片展开/收起 ----------
  document.querySelectorAll('.cc-feature-card .cc-feature-switch').forEach(sw => {
    sw.addEventListener('change', () => {
      sw.closest('.cc-feature-card').classList.toggle('cc-feature-on', sw.checked);
    });
  });

  // ---------- 读取最近聊天记录: 条数滑块实时更新数值文字 ----------
  document.getElementById('cc-recent-chat-count')?.addEventListener('input', (e) => {
    const val = document.getElementById('cc-recent-chat-count-val');
    if (val) val.textContent = e.target.value + '条';
  });

  // ---------- 推送历史记忆: 天数滑块实时更新数值文字(0=已关闭) ----------
  document.getElementById('cc-push-history-days')?.addEventListener('input', (e) => {
    const val = document.getElementById('cc-push-history-days-val');
    const n = parseInt(e.target.value, 10);
    if (val) val.textContent = n == 0 ? '已关闭' : n + '天';
  });

  // ---------- 天气/健康开关 联动 对应比例滑轨(关开关=滑轨归零锁死，不参与内容抽奖) ----------
  document.getElementById('cc-weather-switch')?.addEventListener('change', () => {
    applyFeatureLock('cc-weather-switch', 'cc-slider-weather', 'cc-ratio-weather', 'cc-rv-weather');
  });
  document.getElementById('cc-use-health')?.addEventListener('change', () => {
    applyFeatureLock('cc-use-health', 'cc-slider-health', 'cc-ratio-health', 'cc-rv-health');
  });

  // ---------- 比例滑块同步到隐藏 input ----------
  (function() {
    const pairs = [
      ['cc-slider-daily',   'cc-ratio-daily',   'cc-rv-daily'],
      ['cc-slider-weather', 'cc-ratio-weather',  'cc-rv-weather'],
      ['cc-slider-health',  'cc-ratio-health',   'cc-rv-health'],
      ['cc-slider-other',   'cc-ratio-other',    'cc-rv-other'],
    ];
    function doSync() {
      let total = 0;
      pairs.forEach(([sid, iid, vid]) => {
        const val = parseInt(document.getElementById(sid).value, 10);
        document.getElementById(iid).value = val;
        const ve = document.getElementById(vid);
        if (ve) ve.textContent = val + '%';
        total += val;
      });
      const te = document.getElementById('cc-ratio-total');
      if (te) { te.textContent = total + '%'; te.className = total === 100 ? 'cc-ratio-sum-ok' : 'cc-ratio-sum-bad'; }
    }
    pairs.forEach(([sid]) => { const el = document.getElementById(sid); if (el) el.addEventListener('input', doSync); });
  })();

  // 事件绑定
  $('#cc-open-panel').on('click', async ()=>{
    $('#cc-open-panel').prop('disabled', true).text('加载中...');
    await loadProfile(); // 先把数据加载完
    dialogEl.showModal(); // 再显示弹窗,避免用户在数据还没到位时误触"测试发送"把空值存进去
    $('#cc-open-panel').prop('disabled', false).text('打开随身推送设置面板');
  });
  $('#cc-close').on('click', ()=>dialogEl.close());
  // 点击 dialog 自身空白区域(即背景遮罩)也能关闭
  dialogEl.addEventListener('click', (e)=>{ if (e.target === dialogEl) dialogEl.close(); });
  $('#cc-provider').on('change', function () {
    toggleProvider();
    // 手动切换供应商时清空上一个供应商残留的 Key(如果是通过"应用已保存配置"切换的,
    // 走的是 onPresetApply 那条路径,会在这之后立刻把正确的 key/url 填回去,不受影响)
    setApiKeyField('');
    if (!CC_PROVIDER_FIXED_BASE_URLS[document.getElementById('cc-provider').value]) {
      document.getElementById('cc-baseurl').value = '';
    }
  });
  $('#cc-api-key')
    .on('focus', function () { this.value = ccApiKeyReal; })
    .on('input', function () { ccApiKeyReal = this.value; })
    .on('blur', function () { ccApiKeyReal = ccApiKeyReal.trim(); this.value = maskApiKey(ccApiKeyReal); });
  $('#cc-wi-mode').on('change', function(){ renderWI(this.value,[]); });
  $('#cc-add-time').on('click', ()=>{ const t=getTimesFromForm(); t.push({time:'09:00',note:''}); renderSchedule(t); });
  $('#cc-model-manual-toggle').on('change', function(){ $('#cc-model-manual-block').toggle(this.checked); });
  $('#cc-save').on('click', onSave);
  $('#cc-test-send').on('click', onTestSend);
  $('#cc-test-api').on('click', onTestApi);
  $('#cc-fetch-models').on('click', onFetchModels);
  $('#cc-preset-apply').on('click', onPresetApply);
  $('#cc-preset-save').on('click', onPresetSave);
  $('#cc-preset-delete').on('click', onPresetDelete);
  $('#cc-test-weather').on('click', onTestWeather);
  $('#cc-start-focus').on('click', async () => {
    const minutes = parseInt(document.getElementById('cc-focus-minutes').value, 10);
    const reason = document.getElementById('cc-focus-reason').value.trim();
    if (!minutes || minutes <= 0) { setStatus('请填写有效的分钟数', true); return; }
    try {
      await apiPost('/focus/start-manual', { minutes, reason });
      setStatus('提醒已设置');
      document.getElementById('cc-focus-minutes').value = '';
      document.getElementById('cc-focus-reason').value = '';
      loadFocusInfo();
    } catch (e) { setStatus('设置失败: ' + e.message, true); }
  });
  $('#cc-copy-focus-url').on('click', () => {
    const el = document.getElementById('cc-focus-url');
    el.select(); el.setSelectionRange(0, 99999);
    (navigator.clipboard?.writeText(el.value) || Promise.reject()).catch(() => document.execCommand('copy'));
    setStatus('已复制');
  });
  $('#cc-copy-health-url').on('click', () => {
    const el = document.getElementById('cc-health-url');
    el.select(); el.setSelectionRange(0, 99999);
    (navigator.clipboard?.writeText(el.value) || Promise.reject()).catch(() => document.execCommand('copy'));
    setStatus('已复制');
  });
  $('#cc-cancel-focus').on('click', async () => {
    try { await apiPost('/focus/cancel', {}); setStatus('已取消提醒'); loadFocusInfo(); }
    catch (e) { setStatus('取消失败: ' + e.message, true); }
  });
  $('#cc-reminder-add').on('click', onAddReminder);
  $(document).on('click', '.cc-reminder-cancel', async function () {
    const id = $(this).data('id');
    try { await apiDelete(`/reminders/${id}`); loadRemindersList(); }
    catch (e) { setStatus('取消提醒失败: ' + e.message, true); }
  });

  // 切换角色卡时:先关掉之前唯一启用的那个角色的推送(总开关不跟着角色走),
  // 再刷新面板内容(如果面板正开着)。
  // 注意: 酒馆网页刚打开/刷新时加载默认聊天,也会触发一次 CHAT_CHANGED,
  // 这次不算"真的切换角色",跳过,不然每次刷新页面都会把刚保存的启用状态清掉。
  let ccFirstChatChanged = true;
  const ctx=getContext();
  ctx.eventSource?.on(ctx.eventTypes?.CHAT_CHANGED, async ()=>{
    if (ccFirstChatChanged) {
      ccFirstChatChanged = false;
      if (dialogEl.open) loadProfile();
      return;
    }
    if (!lockedCharSnapshot) { try { await apiPost('/deactivate-all', {}); } catch(e) {} } // 锁定角色时跳过自动关闭总开关
    if (dialogEl.open) loadProfile();
  });

  ['cc-ratio-daily','cc-ratio-weather','cc-ratio-health','cc-ratio-other'].forEach(id => {
    $(`#${id}`).on('input', updateRatioHint);
  });

  await refreshProfilesCache();
  ctx.eventSource?.on(ctx.eventTypes?.MESSAGE_RECEIVED, syncRecentChatIfNeeded);
  ctx.eventSource?.on(ctx.eventTypes?.MESSAGE_SENT, syncRecentChatIfNeeded);
});

