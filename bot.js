/**
 * シフト決定システム LINE Bot
 *
 * 機能:
 *   1. 月初に「シフト入力サイト」のURLをグループへ投稿
 *   2. 未回答者がいたらグループへリマインド (メンションなし)
 *   3. 確定シフトをグループへ投稿
 *
 * Webhook (オプション): LINE Developersでこのサーバ /webhook を登録すると
 * グループID取得などができます。
 */

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};
const GROUP_ID    = process.env.LINE_GROUP_ID;
const SITE_URL    = process.env.SITE_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const client = new Client(config);
const app = express();

// ============================================================
// LINE Webhook (グループID取得用)
// ============================================================
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      // グループに招待された / 発言があった時に groupId をログ出力
      if (event.source?.type === 'group') {
        console.log('GROUP ID:', event.source.groupId);
      }
      if (event.type === 'message' && event.message?.text === '/groupid') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `このグループのID: ${event.source.groupId}`,
        });
      }
    }
    res.status(200).end();
  } catch (e) {
    console.error(e); res.status(500).end();
  }
});

// ============================================================
// 月初の呼びかけ
// POST /api/notify-new-month  Header: x-admin-token
// ============================================================
app.post('/api/notify-new-month', auth, async (req, res) => {
  const ym = nextYearMonth();
  const message = [
    `📅 ${ym.replace('-', '年')}月分のシフト入力をお願いします`,
    '',
    `▼ 入力サイト`,
    SITE_URL,
    '',
    '締切: 今月22日',
    '各自で入力をお願いします。'
  ].join('\n');
  await client.pushMessage(GROUP_ID, { type: 'text', text: message });
  res.json({ ok: true, ym, message });
});

// ============================================================
// 未回答者向けリマインド (メンションなし)
// POST /api/send-reminder  Header: x-admin-token
// ============================================================
app.post('/api/send-reminder', auth, async (req, res) => {
  const ym = nextYearMonth();
  const { data: names } = await supabase.from('names').select('name');
  const { data: cfg }   = await supabase.from('month_config')
    .select('total_people').eq('year_month', ym).maybeSingle();
  const { data: resps } = await supabase.from('responses')
    .select('name, submitted').eq('year_month', ym).eq('submitted', true);

  const totalRequired = cfg?.total_people ?? 9;
  const submittedCount = (resps || []).length;
  const remaining = totalRequired - submittedCount;

  if (remaining <= 0) {
    return res.json({ ok: true, message: '全員回答済み', sent: false });
  }

  const message = [
    `🔔 シフト入力リマインド`,
    '',
    `${ym.replace('-', '年')}月分のシフト入力がまだ揃っていません`,
    `回答状況: ${submittedCount} / ${totalRequired} 名`,
    '',
    'まだの方は入力をお願いします。',
    SITE_URL,
  ].join('\n');

  await client.pushMessage(GROUP_ID, { type: 'text', text: message });
  res.json({ ok: true, remaining, sent: true, message });
});

// ============================================================
// 締切後の強リマインド (22日以降、未回答者がいる限り 1日おき)
// POST /api/send-final-reminder  Header: x-admin-token
// ============================================================
app.post('/api/send-final-reminder', auth, async (req, res) => {
  const ym = nextYearMonth();
  const { data: cfg }   = await supabase.from('month_config')
    .select('total_people').eq('year_month', ym).maybeSingle();
  const { data: resps } = await supabase.from('responses')
    .select('name, submitted').eq('year_month', ym).eq('submitted', true);

  const totalRequired = cfg?.total_people ?? 9;
  const submittedCount = (resps || []).length;
  const remaining = totalRequired - submittedCount;

  if (remaining <= 0) {
    return res.json({ ok: true, message: '全員回答済み', sent: false });
  }

  const message = [
    `⚠️ シフト入力の締切を過ぎています`,
    '',
    `${ym.replace('-', '年')}月分の回答状況: ${submittedCount} / ${totalRequired} 名`,
    '',
    '回答してもらえなければシフトを提出できません。',
    '至急入力をお願いします。',
    SITE_URL,
  ].join('\n');

  await client.pushMessage(GROUP_ID, { type: 'text', text: message });
  res.json({ ok: true, remaining, sent: true, message });
});

// ============================================================
// 確定シフトの投稿
// POST /api/post-decided-shift  Header: x-admin-token
// ============================================================
app.post('/api/post-decided-shift', auth, async (req, res) => {
  const ym = nextYearMonth();
  const { data: dec } = await supabase.from('decisions')
    .select('*').eq('year_month', ym).maybeSingle();

  if (!dec) {
    return res.status(404).json({ ok: false, error: '確定シフトが未登録です' });
  }

  // 日付ごとにまとめて整形
  const byDate = {};
  Object.entries(dec.shift_data || {}).forEach(([key, names]) => {
    const [date, slot] = key.split('_');
    if (!byDate[date]) byDate[date] = {};
    byDate[date][slot] = names;
  });

  const slotLabel = { am: '午前', noon: '正午', pm: '午後' };
  const lines = [`✅ ${ym.replace('-', '年')}月のシフトが確定しました`, ''];

  Object.keys(byDate).sort().forEach(date => {
    const [, m, d] = date.split('-');
    const w = '日月火水木金土'[new Date(date).getDay()];
    lines.push(`${parseInt(m)}/${parseInt(d)} (${w})`);
    ['am','noon','pm'].forEach(slot => {
      const names = byDate[date][slot];
      if (names && names.length) lines.push(`  ${slotLabel[slot]}: ${names.join(', ')}`);
    });
    lines.push('');
  });

  // 個人別カウント
  if (dec.shift_count) {
    lines.push('───── 個人別 ─────');
    Object.entries(dec.shift_count)
      .sort((a,b) => b[1] - a[1])
      .forEach(([n, c]) => lines.push(`${n}: ${c}枠`));
  }

  // LINEメッセージは5,000文字制限。長すぎる場合は分割
  const text = lines.join('\n');
  const chunks = chunkText(text, 4500);
  for (const chunk of chunks) {
    await client.pushMessage(GROUP_ID, { type: 'text', text: chunk });
  }
  res.json({ ok: true, chunks: chunks.length });
});

// ============================================================
// ユーティリティ
// ============================================================
function auth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function nextYearMonth() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth() + 2;
  if (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2,'0')}`;
}

function chunkText(text, maxLen) {
  const lines = text.split('\n');
  const chunks = []; let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > maxLen) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ============================================================
// 起動
// ============================================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE Bot listening on :${port}`);
  console.log(`- POST /webhook                 (LINE Webhook)`);
  console.log(`- POST /api/notify-new-month    (月初呼びかけ)`);
  console.log(`- POST /api/send-reminder       (未回答リマインド)`);
  console.log(`- POST /api/send-final-reminder (締切後の強リマインド)`);
  console.log(`- POST /api/post-decided-shift  (確定シフト投稿)`);
});
