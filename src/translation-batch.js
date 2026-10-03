'use strict';

/**
 * 译者整批译文回填：译者完成整批译文后，按一种目标语言一次性回填到当前字幕。
 *
 * 提交方携带：
 *   - batch_no       批次编号（非负整数或非空字符串，同项目同语言唯一）；
 *   - sub_version / rules_version  读取时的字幕集版本与规则版本；
 *   - items          非空逐行清单 [{ subtitle_id, cue_version, version, text }]：
 *                    字幕 ID、读取时源行版本、译文版本（新建传 0/省略）与非空译文文本。
 *
 * 语义：
 *   - 按字幕 ID 对齐；允许覆盖待复核译文（版本一致即可，覆盖后刷新源快照为 current）；
 *   - 同批重复 ID、无效语言、不存在的字幕 → 请求级拒绝（400），整批不写入；
 *   - 提交时在同一事务内重新核对字幕集/规则版本、逐行源行版本与译文版本、
 *     以及当前字数/字速规则：任一行过期（409）或违规（422），按行返回当前值与原因，
 *     整批不写入；
 *   - 全部通过则在同一事务保存全部译文：新增版本从 1 开始，更新版本递增并刷新
 *     源快照为 current；未列出的行与其他语言不受影响；
 *   - 幂等：同项目同语言批次编号重复且内容相同 → 返回首次结果而不再次写入；
 *     编号相同但内容不同 → 409 冲突；失败批次不占编号（仅成功批次落记录）。
 *
 * 回填结果就是普通译文行：现有逐行译文操作、单语言导出与多语交付直接读取，
 * 旧导出快照不受影响。
 */

const crypto = require('crypto');
const { checkTranslationText, mapRow } = require('./translation');

const MAX_BATCH_NO_LEN = 64;
const MAX_BATCH_ITEMS = 2000;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 批次编号规范化：非负整数（如 1001）或非空字符串（≤64 字，去首尾空白，如 "B-1001"）。
 * 统一按字符串存储与比对（整数 1001 与字符串 "1001" 视为同一编号）；非法返回 null。
 */
function normalizeBatchNo(raw) {
  if (isInt(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t !== '' && t.length <= MAX_BATCH_NO_LEN) return t;
  }
  return null;
}

/**
 * 回填请求形状校验（与项目当前状态无关的部分）。
 * 合法：{ batch_no, sub_version, rules_version, items: [{subtitle_id, cue_version, version, text}] }
 * items 必须非空、无重复 subtitle_id；version 省略/0 表示新建。
 * 返回 { ok, errors, request }。
 */
function parseBatchBody(body) {
  const errors = [];
  const b = body || {};

  const batchNo = normalizeBatchNo(b.batch_no);
  if (batchNo === null) {
    errors.push('batch_no（批次编号）必须是非负整数或非空字符串（≤64 字），如 1001 或 "B-1001"');
  }
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（读取时规则版本）必须是 ≥1 的整数');
  }

  const items = [];
  if (!Array.isArray(b.items) || b.items.length === 0) {
    errors.push('items（逐行译文清单）必须是非空数组：[{subtitle_id, cue_version, version, text}]');
  } else if (b.items.length > MAX_BATCH_ITEMS) {
    errors.push(`items 共 ${b.items.length} 行，超过单批上限 ${MAX_BATCH_ITEMS}`);
  } else {
    const seen = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, cue_version, version, text}`);
        return;
      }
      let bad = false;
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        errors.push(`items[${i}].subtitle_id（字幕 ID）必须是 ≥1 的整数`);
        bad = true;
      }
      if (!isInt(it.cue_version) || it.cue_version < 1) {
        errors.push(`items[${i}].cue_version（读取时源行版本）必须是 ≥1 的整数`);
        bad = true;
      }
      let version = 0;
      if (it.version !== undefined && it.version !== null) {
        if (!isInt(it.version) || it.version < 0) {
          errors.push(`items[${i}].version（译文版本）必须是 ≥0 的整数；新建传 0 或省略，更新传当前版本`);
          bad = true;
        } else {
          version = it.version;
        }
      }
      if (typeof it.text !== 'string' || it.text.trim() === '') {
        errors.push(`items[${i}].text（译文文本）必须是非空字符串`);
        bad = true;
      }
      if (bad) return;
      if (seen.has(it.subtitle_id)) {
        errors.push(`items[${i}] 字幕 ${it.subtitle_id} 在同批中重复：逐行清单每行只能出现一次`);
        return;
      }
      seen.add(it.subtitle_id);
      items.push({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        version,
        text: it.text,
      });
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? {
        batch_no: batchNo,
        sub_version: b.sub_version,
        rules_version: b.rules_version,
        items,
      }
      : null,
  };
}

/**
 * 规范化内容哈希：语言 + 字幕集/规则版本 + 按字幕 ID 排序的逐行内容。
 * 逐行顺序不影响哈希（同一批行无论顺序如何内容相同）。
 */
function contentHash(lang, request) {
  const canon = {
    lang,
    sub_version: request.sub_version,
    rules_version: request.rules_version,
    items: [...request.items]
      .map((it) => ({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        version: it.version,
        text: it.text,
      }))
      .sort((a, b) => a.subtitle_id - b.subtitle_id),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** 规范化请求快照（留档/审计用；保持提交时的逐行顺序） */
function canonicalRequest(lang, request) {
  return {
    lang,
    batch_no: request.batch_no,
    sub_version: request.sub_version,
    rules_version: request.rules_version,
    items: request.items.map((it) => ({
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      version: it.version,
      text: it.text,
    })),
  };
}

/**
 * 提交时整批核对（在事务内对权威当前状态执行）。
 *
 * project：loadProject 结果（含 sub_version/rules/subtitles）
 * request：parseBatchBody 通过后的 request
 * existingByCue：Map(subtitle_id -> translationRow)，该语言非历史译文
 *
 * 返回：
 *   { sub_version_stale, rules_version_stale,
 *     items: [{ subtitle_id, state, reasons, current }] }
 * state：ok / stale（版本过期：源行版本、译文版本或字幕已消失）/ invalid（现行规则违规）。
 * 规则核对只对版本一致的行进行（过期行的当前时长可能已变，规则结论会失真）。
 */
function evaluateBatch(project, request, existingByCue) {
  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));

  const items = request.items.map((it) => {
    const cue = cueById.get(it.subtitle_id) || null;
    const existing = existingByCue.get(it.subtitle_id) || null;
    const current = {
      cue_version: cue ? cue.version : null,
      cue,
      translation: existing ? mapRow(existing) : null,
    };
    const reasons = [];
    let state = 'ok';

    if (!cue) {
      // 兜底：正常流程在事务外已按 400 拒绝；事务内对权威状态再核对一次
      state = 'stale';
      reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在` +
        '（可能已被重排删除），请刷新后按当前行重新提交'
      );
    } else {
      if (it.cue_version !== cue.version) {
        state = 'stale';
        reasons.push(`源字幕行版本过期：提交基于 v${it.cue_version}，当前已是 v${cue.version}，请刷新后重新提交`);
      }
      if (existing) {
        if (it.version === 0) {
          state = 'stale';
          reasons.push(
            `该字幕在此语言下已存在译文 v${existing.version}` +
            `（${existing.status === 'review' ? '待复核' : '当前'}）：覆盖须携带其 version`
          );
        } else if (it.version !== existing.version) {
          state = 'stale';
          reasons.push(`译文版本过期：提交基于 v${it.version}，当前已是 v${existing.version}，请刷新后重新提交`);
        }
      } else if (it.version > 0) {
        state = 'stale';
        reasons.push(`提交基于译文 v${it.version}，但该字幕当前无译文（旧译文可能已留作历史）：新建请传 version 0`);
      }
    }

    if (state === 'ok' && cue) {
      const ruleReasons = checkTranslationText(it.text, cue, project.rules);
      if (ruleReasons.length > 0) {
        state = 'invalid';
        reasons.push(...ruleReasons);
      }
    }

    return { subtitle_id: it.subtitle_id, state, reasons, current };
  });

  return {
    sub_version_stale: request.sub_version !== project.sub_version,
    rules_version_stale: request.rules_version !== project.rules.version,
    items,
  };
}

/** 按编号取批次记录（含存储的首次结果），不存在返回 null */
function findBatch(db, projectId, lang, batchNo) {
  return db.prepare(
    'SELECT * FROM translation_batches WHERE project_id = ? AND lang = ? AND batch_no = ?'
  ).get(projectId, lang, batchNo) || null;
}

/** 批次列表视图行（不含请求/结果正文） */
function mapBatchRow(r) {
  return {
    batch_no: r.batch_no,
    lang: r.lang,
    item_count: r.item_count,
    created_count: r.created_count,
    updated_count: r.updated_count,
    sub_version: r.sub_version,
    rules_version: r.rules_version,
    created_at: r.created_at,
  };
}

/** 项目某语言全部回填批次（列表视图，按记录倒序） */
function listBatches(db, projectId, lang) {
  return db.prepare(
    'SELECT * FROM translation_batches WHERE project_id = ? AND lang = ? ORDER BY id DESC'
  ).all(projectId, lang).map(mapBatchRow);
}

module.exports = {
  MAX_BATCH_NO_LEN,
  MAX_BATCH_ITEMS,
  normalizeBatchNo,
  parseBatchBody,
  contentHash,
  canonicalRequest,
  evaluateBatch,
  findBatch,
  listBatches,
  mapBatchRow,
};
