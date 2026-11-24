'use strict';

/**
 * AI 排程客户端（OpenAI 兼容协议）。
 *
 * 只依赖 Node 内置 https/fetch，不引第三方 SDK：
 *  - 换服务商只改 baseUrl + model，代码零改动
 *  - 主进程独占 Key，渲染进程永远拿不到明文
 *  - 任何网络/格式异常都返回结构化错误，由上层降级为本地排程
 */

const { nowMinutes } = require('./datetime');
const { PRIORITY_LABEL } = require('./defaults');

/** 从模型回复里抠出 JSON：容忍 ```json 围栏、前后废话、多余的逗号 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);

  try {
    return JSON.parse(s);
  } catch (_) {
    // 常见毛病：尾随逗号
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch (__) {
      return null;
    }
  }
}

/** 组装提示词。任务 id 必须原样回传，否则清洗阶段会把块丢掉 */
function buildMessages({ tasks, settings, now = new Date(), dateKey }) {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lines = tasks
    .filter((t) => !t.done)
    .map((t, i) => {
      const parts = [`${i + 1}. id=${t.id}`, `标题=${t.title}`];
      parts.push(`优先级=${PRIORITY_LABEL[t.priority] || '普通'}`);
      parts.push(`预估=${t.estimateMin}分钟`);
      if (t.note) parts.push(`备注=${t.note.slice(0, 80)}`);
      if (t.carriedFrom) parts.push(`（从 ${t.carriedFrom} 顺延，之前一直没做完）`);
      return parts.join(' | ');
    })
    .join('\n');

  const system = [
    '你是一个务实的个人排程助手，服务对象是白天要上课、晚上要备课的老师。',
    '你的任务：把一堆杂乱待办排成今天可执行的时间块，并给每件事一句「立刻能动手的第一步」。',
    '要求：',
    '1) 只使用用户给出的任务 id，不要编造，不要遗漏。',
    '2) 时间必须落在用户给定的可排期区间内，必须避开午休，块与块之间不要重叠。',
    '3) 重要的事排在精力好的时段；琐碎短事可以打包塞在间隙。',
    '4) firstStep 必须是不超过 20 字、看一眼就能动手的动作，不要写「认真完成」「高效推进」这类空话。',
    '5) intro 用一句自然的中文说清今天的思路，像同事随口说的，不要写成排比句或总结陈词。',
    '6) 只输出 JSON，不要 markdown 代码块，不要任何解释。',
  ].join('\n');

  const user = [
    `日期：${dateKey}，现在时间：${hhmm}`,
    `可排期区间：${settings.dayStart}–${settings.dayEnd}，午休 ${settings.lunchStart}–${settings.lunchEnd} 不可排`,
    `单个任务默认时长不超过 ${settings.focusMin} 分钟，块之间留 ${settings.bufferMin} 分钟缓冲`,
    '',
    '任务清单：',
    lines || '（空）',
    '',
    '输出 JSON 结构：',
    '{"intro":"一句话说明今天的安排思路",',
    ' "blocks":[{"taskId":"原样回传的id","start":"HH:mm","end":"HH:mm","firstStep":"立刻动手的第一步"}],',
    ' "tips":["最多3条，针对今天的具体情况，不要泛泛而谈"]}',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 把 HTTP/网络异常翻译成用户能照着修的中文提示 */
function describeError(err, status) {
  const raw = String((err && err.message) || err || '');
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请到设置里重新填。';
  if (status === 404) return '接口地址或模型名不对，检查 baseUrl 结尾是否带 /v1、模型名是否拼错。';
  if (status === 429) return '请求太频繁或额度用完了，等一会儿再试。';
  if (status >= 500) return '服务端出错了，稍后再点一次。';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(raw)) {
    return '连不上服务器，检查网络或代理设置。';
  }
  if (/timeout|aborted/i.test(raw)) return '请求超时，可能是网络慢，也可能模型卡住了。';
  return raw || '未知错误';
}

/**
 * 请求一次排程。
 * @returns {Promise<{ok:boolean, raw?:object, error?:string, status?:number}>}
 */
async function requestPlan({ settings, apiKey, tasks, now = new Date(), dateKey, fetchImpl = globalThis.fetch }) {
  const ai = settings.ai || {};
  const baseUrl = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: '还没配置 AI 接口地址。' };
  if (!apiKey) return { ok: false, error: '还没填 API Key。' };
  if (!ai.model) return { ok: false, error: '还没填模型名。' };

  const body = {
    model: ai.model,
    messages: buildMessages({ tasks, settings, now, dateKey }),
    temperature: Number.isFinite(ai.temperature) ? ai.temperature : 0.3,
    max_tokens: 900,
    stream: false,
  };

  const doFetch = async (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ai.timeoutMs || 30000);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let { res, text } = await doFetch({ ...body, response_format: { type: 'json_object' } });

    // 部分服务商不认识 response_format，会用 400 拒绝，这时退回普通模式再试一次
    if (!res.ok && (res.status === 400 || res.status === 422) && /response_format|json_object/i.test(text)) {
      ({ res, text } = await doFetch(body));
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = JSON.parse(text);
        detail = (j.error && (j.error.message || j.error)) || j.message || '';
      } catch (_) {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: res.status, error: describeError(detail || `HTTP ${res.status}`, res.status) };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: '服务端返回的不是 JSON，检查 baseUrl 是否指向了网页而不是接口。' };
    }

    const content =
      json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型没有按要求返回 JSON，再试一次通常就好了。' };

    return { ok: true, raw: parsed };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** 设置页的「测试连接」：发一个最小请求，确认地址/Key/模型三件套都对 */
async function testConnection({ settings, apiKey, fetchImpl = globalThis.fetch }) {
  const ai = settings.ai || {};
  const baseUrl = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !apiKey || !ai.model) return { ok: false, error: '地址、Key、模型名要都填上才能测。' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(20000, ai.timeoutMs || 20000));
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
        max_tokens: 10,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        detail = (j.error && (j.error.message || j.error)) || j.message || detail;
      } catch (_) {}
      return { ok: false, status: res.status, error: describeError(detail, res.status) };
    }
    return { ok: true, message: '连接正常。' };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractJson, buildMessages, requestPlan, testConnection, describeError, nowMinutes };
