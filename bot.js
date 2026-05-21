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
      // スタンプID調査用: グループでスタンプを送るとIDをログ出力&返信
      if (event.type === 'message' && event.message?.type === 'sticker') {
        const { packageId, stickerId } = event.message;
        console.log('STICKER:', { packageId, stickerId });
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `packageId: ${packageId}\nstickerId: ${stickerId}`,
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
    '締切: 今月21日までです。'
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

  const totalRequired = cfg?.total_people ?? 10;
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
// 締切後の強リマインド (22日以降、未回答者がいる限り毎日)
// POST /api/send-final-reminder  Header: x-admin-token
// ============================================================
app.post('/api/send-final-reminder', auth, async (req, res) => {
  const ym = nextYearMonth();
  const { data: cfg }   = await supabase.from('month_config')
    .select('total_people').eq('year_month', ym).maybeSingle();
  const { data: resps } = await supabase.from('responses')
    .select('name, submitted').eq('year_month', ym).eq('submitted', true);

  const totalRequired = cfg?.total_people ?? 10;
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
// 確定シフトの投稿 (手動・認証あり・常に投稿)
// POST /api/post-decided-shift  Header: x-admin-token
// ============================================================
app.post('/api/post-decided-shift', auth, async (req, res) => {
  const ym = nextYearMonth();
  const { data: dec } = await supabase.from('decisions')
    .select('*').eq('year_month', ym).maybeSingle();

  if (!dec) {
    return res.status(404).json({ ok: false, error: '確定シフトが未登録です' });
  }

  const newCount = (dec.post_count || 0) + 1;
  const text = formatDecidedShiftMessage(dec, ym, newCount);
  const chunks = chunkText(text, 4500);
  for (const chunk of chunks) {
    await client.pushMessage(GROUP_ID, { type: 'text', text: chunk });
  }
  await supabase.from('decisions')
    .update({ posted_at: new Date().toISOString(), post_count: newCount })
    .eq('year_month', ym);
  res.json({ ok: true, chunks: chunks.length, post_count: newCount });
});

// ============================================================
// 確定シフトの自動投稿 (フロントから呼び出し・認証なし・冪等)
// posted_at が未設定の時だけ投稿し、即 posted_at を立てる。
// 既に投稿済みなら何もせず sent:false を返す。
// POST /api/auto-post-decision
// ============================================================
const corsFrontend = (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};
app.options('/api/auto-post-decision', corsFrontend);
app.post('/api/auto-post-decision', corsFrontend, async (req, res) => {
  const ym = nextYearMonth();

  // 投稿権をアトミックに取る: posted_at IS NULL の行だけ更新成功する
  const { data: claimed, error: claimErr } = await supabase
    .from('decisions')
    .update({ posted_at: new Date().toISOString() })
    .eq('year_month', ym)
    .is('posted_at', null)
    .select();
  if (claimErr) return res.status(500).json({ ok: false, error: claimErr.message });

  if (!claimed || claimed.length === 0) {
    // 取れなかった = 「未登録」か「既に投稿済み」のどちらか
    const { data: dec } = await supabase.from('decisions')
      .select('posted_at').eq('year_month', ym).maybeSingle();
    if (!dec) return res.status(404).json({ ok: false, error: '確定シフトが未登録です', sent: false });
    return res.json({ ok: true, message: '既に投稿済み', sent: false, posted_at: dec.posted_at });
  }

  // 投稿権を取れた -> LINEに送信
  const dec = claimed[0];
  const newCount = (dec.post_count || 0) + 1;
  const text = formatDecidedShiftMessage(dec, ym, newCount);
  const chunks = chunkText(text, 4500);
  try {
    for (const chunk of chunks) {
      await client.pushMessage(GROUP_ID, { type: 'text', text: chunk });
    }
  } catch (e) {
    // 送信失敗時は posted_at を戻して次回再試行できるようにする
    await supabase.from('decisions').update({ posted_at: null }).eq('year_month', ym);
    console.error('pushMessage failed:', e);
    return res.status(500).json({ ok: false, error: e.message, sent: false });
  }
  // 投稿回数をインクリメント
  await supabase.from('decisions').update({ post_count: newCount }).eq('year_month', ym);
  res.json({ ok: true, sent: true, chunks: chunks.length, post_count: newCount });
});

// 確定シフト → LINEテキスト整形
// postCount: 1 = 初投稿, 2以降 = 修正後の再投稿
function formatDecidedShiftMessage(dec, ym, postCount = 1) {
  const byDate = {};
  Object.entries(dec.shift_data || {}).forEach(([key, names]) => {
    const [date, slot] = key.split('_');
    if (!byDate[date]) byDate[date] = {};
    byDate[date][slot] = names;
  });
  const slotLabel = { am: '午前', noon: '正午', pm: '午後' };
  const header = postCount > 1
    ? `🔄 ${ym.replace('-', '年')}月のシフトを修正しました (${postCount}回目)`
    : `✅ ${ym.replace('-', '年')}月のシフトが確定しました`;
  const lines = [header, ''];
  // 週の始まり (月曜) で空行を入れるため、前の日付の「週のキー」を覚えておく
  const weekKey = (date) => {
    const dt = new Date(date);
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  let prevWeek = null;
  Object.keys(byDate).sort().forEach(date => {
    const [, m, d] = date.split('-');
    const dow = new Date(date).getDay();    // 0=日 ... 6=土
    const w = '日月火水木金土'[dow];
    const wk = weekKey(date);
    if (prevWeek !== null && wk !== prevWeek) lines.push('');
    prevWeek = wk;
    if (dow === 6) {
      // 土曜: 午前/正午/午後 が独立スロット
      lines.push(`${parseInt(m)}/${parseInt(d)} (${w})`);
      ['am','noon','pm'].forEach(slot => {
        const names = byDate[date][slot];
        if (names && names.length) lines.push(`  ${slotLabel[slot]}: ${names.join(', ')}`);
      });
    } else {
      // 平日: pm のみなので1行に圧縮 (ラベル省略)
      const pmNames = byDate[date].pm || [];
      lines.push(`${parseInt(m)}/${parseInt(d)} (${w}) ${pmNames.join(', ')}`.trimEnd());
    }
  });
  lines.push('');
  if (dec.shift_count) {
    lines.push('───── 個人別 ─────');
    Object.entries(dec.shift_count)
      .sort((a,b) => b[1] - a[1])
      .forEach(([n, c]) => lines.push(`${n}: ${c}枠`));
  }
  return lines.join('\n');
}

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
  console.log(`- POST /api/post-decided-shift  (確定シフト投稿/手動)`);
  console.log(`- POST /api/auto-post-decision  (確定シフト自動投稿/冪等)`);
});
