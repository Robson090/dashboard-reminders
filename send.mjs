/* ── Reminder sender ─────────────────────────────────────────────────
   Runs on a schedule (GitHub Actions cron). Reads every user's synced
   doc, works out which reminders are due *in their local time*, and
   sends a Web Push to each of their devices.

   Reminders sent:
     1. Subscriptions — 1 week before AND 1 day before each renewal.
     2. Habits        — 30 minutes before the time you set, each day.
     3. Monthly spend — a report on the 1st: this past month vs the one before.
     4. Work payday   — the day before, and on the day a payment lands: take-home + the week it covers.

   Dedup state lives in a SEPARATE `notifState/{uid}` doc so the app's
   normal writes to `sessions/{uid}` never wipe it.

   Env (provided as GitHub secrets):
     FIREBASE_SERVICE_ACCOUNT  – the service-account JSON (whole file)
     VAPID_PRIVATE             – the web-push VAPID private key
─────────────────────────────────────────────────────────────────── */

import admin from 'firebase-admin'
import webpush from 'web-push'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

// Public key is safe to hardcode (it's embedded in the app too); private key is a secret.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BFoFOcasZrzcngovcTQvyiyAS98rxo54CVbHNSNZzsY4paLeOocBh2RJm3kwP_zHD94NZv4Jcj8kCJtmdtsHueQ'
webpush.setVapidDetails('mailto:eksomnang72@gmail.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE)

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* ── Currency (symbol only — matches the app's display-currency setting) ── */
const CUR = {
  AUD: { s: 'A$', d: 2 }, USD: { s: 'US$', d: 2 }, NZD: { s: 'NZ$', d: 2 },
  GBP: { s: '£', d: 2 }, EUR: { s: '€', d: 2 }, CAD: { s: 'C$', d: 2 },
  SGD: { s: 'S$', d: 2 }, JPY: { s: '¥', d: 0 }, INR: { s: '₹', d: 2 },
  KHR: { s: '៛', d: 0 }, THB: { s: '฿', d: 2 }, CNY: { s: '¥', d: 2 },
}
const money = (n, code) => {
  const c = CUR[code] || CUR.AUD
  return c.s + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: c.d, maximumFractionDigits: c.d })
}

/* ── Date helpers (pure calendar math on YYYY-MM-DD, done in UTC) ── */
const localNow = (tz) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day),
    weekday: DOW.indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  }
}
const parseYMD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
const ymd = (dt) => dt.toISOString().slice(0, 10)
const addDays = (s, n) => { const d = parseYMD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d) }
const daysBetween = (a, b) => Math.round((parseYMD(b) - parseYMD(a)) / 86400000)
const weekdayOf = (s) => parseYMD(s).getUTCDay()
const pad2 = (n) => String(n).padStart(2, '0')
const monthKey = (y, m) => `${y}-${pad2(m + 1)}`
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
const fmtDay = (s) => { const d = parseYMD(s); return `${d.getUTCDate()} ${MON_ABBR[d.getUTCMonth()]}` }
const fmtRange = (a, b) => {
  const da = parseYMD(a), dbb = parseYMD(b)
  if (da.getUTCMonth() === dbb.getUTCMonth())
    return `${da.getUTCDate()}–${dbb.getUTCDate()} ${MON_ABBR[da.getUTCMonth()]}`
  return `${fmtDay(a)} – ${fmtDay(b)}`
}

/* ── Australian PAYG weekly tax (ported from the app's auTax.js) ────── */
const SCALE_2 = [ // tax-free threshold claimed, full Medicare
  { under: 361, a: 0, b: 0 }, { under: 500, a: 0.16, b: 57.8462 },
  { under: 625, a: 0.26, b: 107.8462 }, { under: 721, a: 0.18, b: 57.8462 },
  { under: 865, a: 0.189, b: 64.3365 }, { under: 1282, a: 0.3227, b: 180.0385 },
  { under: 2596, a: 0.32, b: 176.5769 }, { under: 3653, a: 0.39, b: 358.3077 },
  { under: Infinity, a: 0.47, b: 650.6154 },
]
const SCALE_1 = [ // TFN provided, tax-free threshold NOT claimed
  { under: 150, a: 0.1600, b: 0.1600 }, { under: 371, a: 0.2117, b: 7.7550 },
  { under: 515, a: 0.1890, b: -0.6702 }, { under: 932, a: 0.3227, b: 68.2367 },
  { under: 2246, a: 0.3200, b: 65.7202 }, { under: 3303, a: 0.3900, b: 222.9510 },
  { under: Infinity, a: 0.4700, b: 487.2587 },
]
const SCALE_5 = [ // tax-free threshold + full Medicare exemption
  { under: 361, a: 0, b: 0 }, { under: 721, a: 0.1600, b: 57.8462 },
  { under: 865, a: 0.1690, b: 64.3365 }, { under: 1282, a: 0.3027, b: 180.0385 },
  { under: 2596, a: 0.3000, b: 176.5769 }, { under: 3653, a: 0.3700, b: 358.3077 },
  { under: Infinity, a: 0.4500, b: 650.6154 },
]
const SCALE_6 = [ // tax-free threshold + half Medicare exemption
  { under: 361, a: 0, b: 0 }, { under: 721, a: 0.1600, b: 57.8462 },
  { under: 843, a: 0.1690, b: 64.3365 }, { under: 865, a: 0.2190, b: 106.4962 },
  { under: 1053, a: 0.3527, b: 222.1981 }, { under: 1282, a: 0.3127, b: 180.0385 },
  { under: 2596, a: 0.3100, b: 176.5769 }, { under: 3653, a: 0.3800, b: 358.3077 },
  { under: Infinity, a: 0.4600, b: 650.6154 },
]
const pickScale = (tft, med) => {
  if (!tft) return SCALE_1
  if (med === 'full') return SCALE_5
  if (med === 'half') return SCALE_6
  return SCALE_2
}
const weeklyTax = (gross, tft, med) => {
  if (!gross || gross <= 0) return 0
  const scale = pickScale(tft, med)
  const x = Math.floor(gross) + 0.99
  const br = scale.find(b => x < b.under) || scale[scale.length - 1]
  const y = br.a * x - br.b
  return y <= 0 ? 0 : Math.round(y)
}
const weeklyTaxAmount = (gross, ws) => {
  const mode = ws.taxMode || 'au'
  if (mode === 'none') return 0
  if (mode === 'custom') return Math.round(gross * (Math.max(0, ws.customTaxRate || 0) / 100) * 100) / 100
  return weeklyTax(gross, ws.claimTaxFreeThreshold ?? true, ws.medicareExemption || 'none')
}
const weeklyNet = (gross, ws) => Math.max(0, gross - weeklyTaxAmount(gross, ws))

/* ── Work week grouping (Mon–Sun; payday = ported from workData.js) ── */
const weekStartOf = (dateStr) => {
  const d = parseYMD(dateStr), dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1)) // back to Monday
  return ymd(d)
}
const paydayOf = (weekStart, delay) => addDays(weekStart, 8 + 7 * (delay ?? 1))
const entryGross = (e, hourlyRate) =>
  e.kind === 'piece' ? (Number(e.trees) || 0) * (Number(e.ratePerTree) || 0)
                     : (Number(e.hours) || 0) * (Number(hourlyRate) || 0)

/* ── Monthly spend (ported from review.js: charges in month + daily) ── */
const monthSpend = (items, daily, y, m) => {
  const key = monthKey(y, m)
  let total = 0
  for (const e of (daily || [])) if (e?.date && e.date.startsWith(key)) total += (Number(e.amount) || 0)
  for (const it of (items || [])) {
    if (it?.status && it.status !== 'active') continue
    const amt = Number(it?.amount) || 0
    if (it?.type === 'expense') { if (it.date && it.date.startsWith(key)) total += amt; continue }
    if (it?.type !== 'subscription') continue
    const anchor = it.nextRenewalDate || it.date
    if (!anchor) continue
    const f = it.frequency || 'monthly'
    if (f === 'monthly') total += amt
    else if (f === 'yearly') { if ((Number(anchor.slice(5, 7)) - 1) === m) total += amt }
    else if (f === 'weekly') {
      const dow = weekdayOf(anchor); let count = 0
      for (let dd = 1; dd <= daysInMonth(y, m); dd++)
        if (new Date(Date.UTC(y, m, dd)).getUTCDay() === dow) count++
      total += amt * count
    }
  }
  return total
}

async function run() {
  const snap = await db.collection('sessions').get()
  let sentTotal = 0

  for (const doc of snap.docs) {
    const uid = doc.id
    const d = doc.data() || {}
    const subs = (d.pushSubscriptions || []).filter(s => s?.endpoint && s?.keys)
    if (!subs.length) continue

    const tz = subs.find(s => s.tz)?.tz || 'Australia/Melbourne'
    const now = localNow(tz)
    const code = d.profile?.currency || 'AUD'

    const stateRef = db.collection('notifState').doc(uid)
    const sent = new Set((((await stateRef.get()).data() || {}).sent) || [])
    const queue = []
    const add = (key, title, body) => { if (!sent.has(key)) queue.push({ key, title, body, tag: key }) }

    /* 1. Subscriptions — 1 week before AND 1 day before (from 9am local) */
    if (now.minutes >= 540) {
      for (const it of (d.subscriptions || [])) {
        if (it.type !== 'subscription' || it.status !== 'active' || !it.nextRenewalDate) continue
        const du = daysBetween(now.date, it.nextRenewalDate)
        if (du === 7) add(`sub7:${it.id}:${now.date}`,
          `💳 ${it.name} renews in 1 week`, `${money(it.amount, code)} on ${fmtDay(it.nextRenewalDate)}.`)
        if (du === 1) add(`sub1:${it.id}:${now.date}`,
          `💳 ${it.name} renews tomorrow`, `${money(it.amount, code)} on ${fmtDay(it.nextRenewalDate)}.`)
      }
    }

    /* 2. Habits — 30 minutes before the set time, on scheduled days, if not done */
    for (const h of (d.habits || [])) {
      if (!h.reminderTime) continue
      if (!(h.days || [0, 1, 2, 3, 4, 5, 6]).includes(now.weekday)) continue
      if ((d.habitLog?.[h.id] || []).includes(now.date)) continue
      const [hh, mm] = String(h.reminderTime).split(':').map(Number)
      const start = hh * 60 + mm
      const fireFrom = Math.max(0, start - 30)
      if (now.minutes >= fireFrom && now.minutes < start)
        add(`habit:${h.id}:${now.date}`, `${h.emoji || '⏰'} ${h.name} in 30 min`, `Starts at ${h.reminderTime}.`)
    }

    /* 3. Monthly spend report — on the 1st, from 9am: last month vs the one before */
    if (now.day === 1 && now.minutes >= 540) {
      const lm = { y: now.month === 0 ? now.year - 1 : now.year, m: now.month === 0 ? 11 : now.month - 1 }
      const bm = { y: lm.m === 0 ? lm.y - 1 : lm.y, m: lm.m === 0 ? 11 : lm.m - 1 }
      const last = monthSpend(d.subscriptions, d.dailyExpenses, lm.y, lm.m)
      const prev = monthSpend(d.subscriptions, d.dailyExpenses, bm.y, bm.m)
      if (last > 0 || prev > 0) {
        let cmp = '.'
        if (prev > 0) {
          const diff = Math.round((last - prev) / prev * 100)
          cmp = diff === 0 ? ` — same as ${MONTHS[bm.m]}.`
            : ` — ${Math.abs(diff)}% ${diff > 0 ? 'more' : 'less'} than ${MONTHS[bm.m]}.`
        }
        add(`report:${monthKey(lm.y, lm.m)}`, `📊 ${MONTHS[lm.m]} spending`,
          `You spent ${money(last, code)}${cmp}`)
      }
    }

    /* 4. Work payday — a heads-up the day before, and on the day it lands (9am local) */
    if (now.minutes >= 540) {
      const ws = d.workSettings || {}
      const delay = ws.payDelayWeeks ?? 1
      const rate = Number(ws.hourlyRate) || 0
      const tomorrow = addDays(now.date, 1)
      const weeks = {}
      for (const e of (d.workEntries || [])) {
        if (!e?.date) continue
        const k = weekStartOf(e.date)
        ;(weeks[k] || (weeks[k] = [])).push(e)
      }
      for (const k of Object.keys(weeks)) {
        const payday = paydayOf(k, delay)
        const isToday = payday === now.date
        const isTomorrow = payday === tomorrow
        if (!isToday && !isTomorrow) continue
        const gross = weeks[k].reduce((s, e) => s + entryGross(e, rate), 0)
        if (gross <= 0) continue
        const net = weeklyNet(gross, ws)
        const range = fmtRange(k, addDays(k, 6))
        if (isTomorrow)
          add(`payday-eve:${k}`, `💰 Payday tomorrow — ${money(net, code)}`, `For ${range}, landing tomorrow.`)
        if (isToday)
          add(`payday:${k}`, `💰 Payday — ${money(net, code)}`, `Take-home for ${range}.`)
      }
    }

    if (!queue.length) continue

    for (const msg of queue) {
      const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: '/' })
      for (const s of subs) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); sentTotal++ }
        catch (e) { if (![404, 410].includes(e.statusCode)) console.error('push error', uid, e.statusCode || e.message) }
      }
      sent.add(msg.key)
    }

    // Prune day-stamped dedup keys older than ~5 days (month/report keys have no day → kept).
    const cutoff = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)
    const pruned = [...sent].filter(k => { const m = k.match(/:(\d{4}-\d{2}-\d{2})$/); return !m || m[1] >= cutoff })
    await stateRef.set({ sent: pruned, updatedAt: new Date().toISOString() })
  }

  console.log(`Done. Sent ${sentTotal} notification(s).`)
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
