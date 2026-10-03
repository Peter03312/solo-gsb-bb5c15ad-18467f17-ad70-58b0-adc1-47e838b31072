'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

const enc = encodeURIComponent;

/** 新建项目并排版：返回 { pid, cues, sub_version }（两条字幕，行版本均为 1） */
async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '整批回填测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 构造合法回填请求体（两条新译文） */
function batchBody(cues, extra = {}) {
  return {
    batch_no: 'B-1',
    sub_version: 1,
    rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hello world' },
      { subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' },
    ],
    ...extra,
  };
}

// ---------- 请求形状 ----------

test('形状：batch_no / 版本 / items 非法 → 400，不占编号', async () => {
  const { pid, cues } = await setupProject();

  const noBatchNo = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: undefined }));
  assert.equal(noBatchNo.status, 400);
  assert.ok(noBatchNo.body.errors.some((e) => e.includes('batch_no')));

  const badBatchNo = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: '   ' }));
  assert.equal(badBatchNo.status, 400);

  const negBatchNo = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: -1 }));
  assert.equal(negBatchNo.status, 400);

  const badSub = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { sub_version: '1' }));
  assert.equal(badSub.status, 400);
  assert.ok(badSub.body.errors.some((e) => e.includes('sub_version')));

  const badRules = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { rules_version: 0 }));
  assert.equal(badRules.status, 400);

  const emptyItems = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [] }));
  assert.equal(emptyItems.status, 400);
  assert.ok(emptyItems.body.errors.some((e) => e.includes('非空')));

  const blankText = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '  ' }] }));
  assert.equal(blankText.status, 400);
  assert.ok(blankText.body.errors.some((e) => e.includes('非空字符串')));

  const badCueVer = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [{ subtitle_id: cues[0].id, cue_version: 0, text: 'Hi' }] }));
  assert.equal(badCueVer.status, 400);

  const badVer = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [{ subtitle_id: cues[0].id, cue_version: 1, version: -1, text: 'Hi' }] }));
  assert.equal(badVer.status, 400);

  // 全部失败：批次编号未被占用，语言下无任何译文
  const list = await api(`/api/projects/${pid}/translations/en/batches`);
  assert.equal(list.body.batches.length, 0);
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2);
});

test('形状：同批重复字幕 ID → 400', async () => {
  const { pid, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hello' },
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hello again' },
    ],
  }));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.some((e) => e.includes('重复')));
});

test('形状：无效语言代号 / 请求体语言与路径不一致 → 400', async () => {
  const { pid, cues } = await setupProject();
  const badLang = await api(`/api/projects/${pid}/translations/${enc('zh CN')}/batches`, 'POST',
    batchBody(cues));
  assert.equal(badLang.status, 400);

  const mismatch = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { lang: 'fr' }));
  assert.equal(mismatch.status, 400);
  assert.ok(mismatch.body.error.includes('不一致'));

  // 请求体语言与路径一致时接受
  const ok = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { lang: 'en' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('形状：不存在的字幕 → 400，整批不写入且不占编号', async () => {
  const { pid, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hello' },
      { subtitle_id: 99999, cue_version: 1, text: 'Ghost' },
    ],
  }));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors[0].includes('99999'));
  // 整批不写入：第一行也未保存
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2);
  // 失败批次不占编号：修正后同号可成功提交
  const fix = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(fix.status, 201, JSON.stringify(fix.body));
});

// ---------- 成功回填 ----------

test('成功：整批新建 → 201，版本从 1 开始，快照为 current；未列出的行与其他语言不变', async () => {
  const { pid, cues } = await setupProject();
  // 另一语言先存一条，验证不受影响
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour', cue_version: 1 });

  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'Hello world' }],
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.batch_no, 'B-1');
  assert.equal(r.body.lang, 'en');
  assert.equal(r.body.item_count, 1);
  assert.equal(r.body.created_count, 1);
  assert.equal(r.body.updated_count, 0);
  const it = r.body.items[0];
  assert.equal(it.action, 'created');
  assert.equal(it.version, 1);
  assert.equal(it.translation.status, 'current');
  assert.equal(it.translation.src_text, cues[0].text);
  assert.equal(it.translation.cue_version_snapshot, 1);

  // 未列出的行仍缺译；其他语言不受影响
  const viewEn = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(viewEn.body.counts.current, 1);
  assert.equal(viewEn.body.counts.missing, 1);
  const viewFr = await api(`/api/projects/${pid}/translations/fr`);
  assert.equal(viewFr.body.entries[0].translation.text, 'Bonjour');
  // 回填不推进字幕集版本
  const project = await api(`/api/projects/${pid}`);
  assert.equal(project.body.sub_version, 1);
});

test('成功：更新版本递增并刷新源快照为 current；允许覆盖待复核译文', async () => {
  const { pid, cues } = await setupProject();
  // 先逐行保存两条译文（v1）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  // 改第一条源文本 → 其译文转待复核
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好呀世界' });
  assert.equal(edit.status, 200);
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');
  assert.equal(view.body.entries[1].state, 'current');

  // 整批回填：覆盖待复核（版本 1）+ 更新当前（版本 1），携带新的字幕集版本
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B-7',
    sub_version: edit.body.sub_version,
    rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 2, version: 1, text: 'Hi there world' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 1, text: 'Welcome!' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created_count, 0);
  assert.equal(r.body.updated_count, 2);
  const [a, b] = r.body.items;
  assert.equal(a.action, 'updated');
  assert.equal(a.version, 2, '更新版本递增');
  assert.equal(a.translation.status, 'current', '覆盖待复核后转 current');
  assert.equal(a.translation.src_text, '你好呀世界', '源快照刷新为当前');
  assert.equal(a.translation.cue_version_snapshot, 2);
  assert.equal(b.version, 2);

  const view2 = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view2.body.counts.current, 2);
  assert.equal(view2.body.counts.review, 0);
});

test('成功：整数批次编号规范化为字符串；同语言不同批次各自占用编号', async () => {
  const { pid, cues } = await setupProject();
  const r1 = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: 1001, items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'Hello' }] }));
  assert.equal(r1.status, 201);
  assert.equal(r1.body.batch_no, '1001');

  // 整数 1001 与字符串 "1001" 视为同一编号：内容不同 → 409
  const dup = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: '1001', items: [{ subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' }] }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.conflict, true);

  // 不同编号可继续提交
  const r2 = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { batch_no: 1002, items: [{ subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' }] }));
  assert.equal(r2.status, 201);

  // 同一批次编号在不同语言下互不占位
  const r3 = await api(`/api/projects/${pid}/translations/fr/batches`, 'POST',
    batchBody(cues, { batch_no: 1001, items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'Bonjour' }] }));
  assert.equal(r3.status, 201);
});

// ---------- 版本过期（409，按行返回当前值与原因） ----------

test('过期：sub_version / rules_version 漂移 → 409 带当前值，整批不写入', async () => {
  const { pid, cues } = await setupProject();
  const staleSub = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { sub_version: 99 }));
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.sub_version_stale, true);
  assert.equal(staleSub.body.current.sub_version, 1);

  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 40, min_duration_ms: 800, max_cps: 20,
  });
  const staleRules = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { rules_version: 1 }));
  assert.equal(staleRules.status, 409);
  assert.equal(staleRules.body.rules_version_stale, true);
  assert.equal(staleRules.body.current.rules_version, 2);

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '整批不写入');
  assert.equal((await api(`/api/projects/${pid}/translations/en/batches`)).body.batches.length, 0);
});

test('过期：源行版本过期 → 409 按行返回当前值与原因', async () => {
  const { pid, cues } = await setupProject();
  // 改第一条源文本（行版本 → 2，字幕集版本 → 2）
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好呀世界' });
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B-2',
    sub_version: edit.body.sub_version,
    rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hi there world' }, // 过期：当前 v2
      { subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' },
    ],
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].subtitle_id, cues[0].id);
  assert.equal(r.body.items[0].state, 'stale');
  assert.equal(r.body.items[0].current.cue_version, 2);
  assert.ok(r.body.items[0].reasons[0].includes('源字幕行版本过期'));
  // 整批不写入
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2);
});

test('过期：译文版本过期 / 新建冲突 / 无译文却带版本 → 409 按行返回当前值', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });

  // 已存在译文却按新建提交（version 省略/0）
  const asNew = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    batch_no: 'B-3',
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'Hi' }],
  }));
  assert.equal(asNew.status, 409);
  assert.equal(asNew.body.items[0].current.translation.version, 1);
  assert.ok(asNew.body.items[0].reasons[0].includes('已存在译文'));

  // 译文版本过期（当前 v1，提交 v9）
  const staleVer = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    batch_no: 'B-4',
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 9, text: 'Hi' }],
  }));
  assert.equal(staleVer.status, 409);
  assert.ok(staleVer.body.items[0].reasons[0].includes('译文版本过期'));

  // 无译文却携带译文版本
  const ghost = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    batch_no: 'B-5',
    items: [{ subtitle_id: cues[1].id, cue_version: 1, version: 3, text: 'Welcome' }],
  }));
  assert.equal(ghost.status, 409);
  assert.ok(ghost.body.items[0].reasons[0].includes('当前无译文'));

  // 三次失败均未写入、不占编号
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.current, 1);
  assert.equal(view.body.counts.missing, 1);
  assert.equal((await api(`/api/projects/${pid}/translations/en/batches`)).body.batches.length, 0);
});

// ---------- 规则违规（422，按行返回原因） ----------

test('违规：译文超当前 max_chars / max_cps → 422 按行返回原因，整批不写入', async () => {
  const { pid, cues } = await setupProject();
  const tooLong = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: 'x'.repeat(31) },
      { subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' },
    ],
  }));
  assert.equal(tooLong.status, 422);
  assert.equal(tooLong.body.items.length, 1);
  assert.equal(tooLong.body.items[0].state, 'invalid');
  assert.ok(tooLong.body.items[0].reasons.some((m) => m.includes('最大字数')));

  // 源行时长约 1000ms：21 字 → 21 字/秒 > 20
  const tooFast = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    batch_no: 'B-6',
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'x'.repeat(21) }],
  }));
  assert.equal(tooFast.status, 422);
  assert.ok(tooFast.body.items[0].reasons.some((m) => m.includes('字/秒')));

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '违规批次整批不写入');
  assert.equal((await api(`/api/projects/${pid}/translations/en/batches`)).body.batches.length, 0);
});

// ---------- 幂等 ----------

test('幂等：同号同内容（含逐行顺序变化）→ 200 返回首次结果，不再次写入', async () => {
  const { pid, cues } = await setupProject();
  const first = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(first.status, 201);

  // 逐行顺序不同、内容相同 → 仍视为同一批
  const replay = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[1].id, cue_version: 1, text: 'Welcome' },
      { subtitle_id: cues[0].id, cue_version: 1, text: 'Hello world' },
    ],
  }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(
    replay.body.items.map((i) => [i.subtitle_id, i.version]),
    first.body.items.map((i) => [i.subtitle_id, i.version])
  );

  // 不再次写入：译文版本仍为 1（若重放会推进到 2）
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.ok(view.body.entries.every((e) => e.translation.version === 1));
  assert.equal((await api(`/api/projects/${pid}/translations/en/batches`)).body.batches.length, 1);
});

test('幂等：同号不同内容 → 409 冲突且不写入；项目演进后重放仍返回首次结果', async () => {
  const { pid, cues } = await setupProject();
  const first = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(first.status, 201);

  const conflict = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'Different text' }],
  }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.conflict, true);
  assert.equal(conflict.body.batch_no, 'B-1');
  assert.equal(conflict.body.existing.item_count, 2);

  // 项目演进（改源文本 → 字幕集版本推进、译文转待复核）后，同号同内容重放仍返回首次结果
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好呀世界' });
  const replay = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.items[0].translation.status, 'current', '返回的是首次写入时的结果快照');
  // 重放不触碰数据：第一条译文仍是待复核
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');
});

test('幂等：失败批次不占编号（过期/违规/非法后同号可重新提交）', async () => {
  const { pid, cues } = await setupProject();
  // 1) 版本过期失败
  const stale = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { sub_version: 99 }));
  assert.equal(stale.status, 409);
  // 2) 规则违规失败
  const invalid = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [{ subtitle_id: cues[0].id, cue_version: 1, text: 'x'.repeat(31) }] }));
  assert.equal(invalid.status, 422);
  // 3) 请求非法失败
  const bad = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, { items: [] }));
  assert.equal(bad.status, 400);
  // 同号修正后成功
  const ok = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await api(`/api/projects/${pid}/translations/en/batches`)).body.batches.length, 1);
});

// ---------- 批次查询 ----------

test('查询：批次列表与单个批次；不存在 → 404', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, { batch_no: 'A-1' }));
  await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues, {
    batch_no: 'A-2',
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 1, text: 'Hello again' }],
  }));

  const list = await api(`/api/projects/${pid}/translations/en/batches`);
  assert.equal(list.status, 200);
  assert.equal(list.body.lang, 'en');
  assert.deepEqual(list.body.batches.map((b) => b.batch_no), ['A-2', 'A-1'], '倒序');
  assert.equal(list.body.batches[1].created_count, 2);
  assert.equal(list.body.batches[0].updated_count, 1);

  const one = await api(`/api/projects/${pid}/translations/en/batches/A-1`);
  assert.equal(one.status, 200);
  assert.equal(one.body.item_count, 2);
  assert.equal(one.body.items.length, 2);
  assert.ok(one.body.created_at);

  const ghost = await api(`/api/projects/${pid}/translations/en/batches/NOPE`);
  assert.equal(ghost.status, 404);

  // 其他语言看不到该批次
  const frList = await api(`/api/projects/${pid}/translations/fr/batches`);
  assert.equal(frList.body.batches.length, 0);
});

// ---------- 与现有译文操作 / 导出 / 交付的兼容 ----------

test('兼容：回填结果供逐行操作、单语言导出与多语交付读取；旧快照不变', async () => {
  const { pid, cues } = await setupProject();
  // 整批回填英语（两行）
  const b = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(b.status, 201);
  // 法语逐行补齐
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour le monde', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'Bienvenue', cue_version: 1 });

  // 逐行操作继续在回填版本上工作（更新须带当前版本 1 → 推进到 2）
  const upd = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello, world', cue_version: 1, version: 1 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.translation.version, 2);

  // 单语言导出读取回填结果
  const exp = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.ok(exp.body.content.includes('Hello, world'));
  assert.ok(exp.body.content.includes('Welcome'));

  // 多语交付读取回填结果（en 第一行译文版本已是 2）
  const del = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: 1,
    rules_version: 1,
    languages: ['en', 'fr'],
    translations: {
      en: [
        { subtitle_id: cues[0].id, version: 2 },
        { subtitle_id: cues[1].id, version: 1 },
      ],
      fr: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
    },
  });
  assert.equal(del.status, 201, JSON.stringify(del.body));
  assert.equal(del.body.files.find((f) => f.lang === 'en').version, 2, 'en 导出序列：单语言导出 v1 之后');

  // 旧导出快照保持不变
  const old = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.equal(old.status, 200);
  assert.ok(old.body.includes('Hello, world'));
});

test('兼容：回填后源字幕变化仍按既有规则使译文待复核；历史不挪用', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  // 改源文本 → 回填译文同样转待复核
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好呀世界' });
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');
  assert.equal(view.body.entries[1].state, 'current');
});
