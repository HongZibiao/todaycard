'use strict';

/**
 * API Key 的存取。
 *
 * 优先用 Electron 的 safeStorage：Windows 走 DPAPI，密文绑定当前用户账户，
 * 拷走 data.json 也解不开。极少数环境（无密钥环的 Linux）不可用时，
 * 退回明文并在设置页明确提示，不偷偷降级。
 */

const { safeStorage } = require('electron');

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

/** 明文 -> 可持久化字段。返回的对象直接合并进 settings.ai */
function packKey(plain) {
  const value = String(plain || '').trim();
  if (!value) return { apiKeyEnc: null, apiKeyPlain: null };
  if (canEncrypt()) {
    return { apiKeyEnc: safeStorage.encryptString(value).toString('base64'), apiKeyPlain: null };
  }
  return { apiKeyEnc: null, apiKeyPlain: value };
}

/** 从 settings.ai 里取出明文 Key；没有则返回空串 */
function readKey(settings) {
  const ai = (settings && settings.ai) || {};
  if (ai.apiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(ai.apiKeyEnc, 'base64'));
    } catch (_) {
      return '';
    }
  }
  return ai.apiKeyPlain || '';
}

function hasKey(settings) {
  const ai = (settings && settings.ai) || {};
  return Boolean(ai.apiKeyEnc || ai.apiKeyPlain);
}

module.exports = { packKey, readKey, hasKey, canEncrypt };
