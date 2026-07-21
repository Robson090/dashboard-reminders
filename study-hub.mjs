/* ── Study hub assessment reminders ──────────────────────────────────
   Separate from send.mjs on purpose: different data source, different
   cadence (once a day, not every 15 minutes), and keeping it apart means
   a change here can never disturb the dashboard's own reminders.

   Reads `study_hub/{uid}`:
     deadlines         – [{ subject, what, weight, due:'YYYY-MM-DD' }]
                         written by the hub itself, so the schedule shown on
                         the page and the one notified on are always the same
     pushSubscriptions – [{ endpoint, keys }] per device

   Sends at 7 days, 3 days, 1 day before, and on the due day. Dedup state
   lives in a SEPARATE `studyNotifState/{uid}` doc so the app's normal
   writes to study_hub can never wipe it.

   Env (GitHub secrets, already present in this repo):
     FIREBASE_SERVICE_ACCOUNT  – service-account JSON
     VAPID_PRIVATE             – web-push VAPID private key
─────────────────────────────────────────────────────────────────── */

import admin from 'firebase-admin'
import webpush from 'web-push'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BFoFOcasZrzcngovcTQvyiyAS98rxo54CVbHNSNZzsY4paLeOocBh2RJm3kwP_zHD94NZv4Jcj8kCJtmdtsHueQ'
webpush.setVapidDetails('mailto:eksomnang72@gmail.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE)

const TZ = 'Australia/Melbourne'
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// "today" as YYYY-MM-DD in the user's timezone, not the runner's UTC
const todayInTz = (tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {})
  return `${p.year}-${p.month}-${p.day}`
}
const daysBetween = (fromISO, toISO) =>
  Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86400000)

const pretty = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MON[m - 1]}`
}

const MILESTONES = [
  { days: 7, word: 'in a week' },
  { days: 3, word: 'in 3 days' },
  { days: 1, word: 'tomorrow' },
  { days: 0, word: 'today' },
]

async function run() {
  const snap = await db.collection('study_hub').get()
  let users = 0, sent = 0, pruned = 0

  for (const doc of snap.docs) {
    const uid = doc.id
    const d = doc.data() || {}
    const subs = (d.pushSubscriptions || []).filter(s => s?.endpoint && s?.keys)
    const deadlines = (d.deadlines || []).filter(x => x?.due && x?.what)
    if (!subs.length || !deadlines.length) continue
    users++

    const today = todayInTz(d.tz || TZ)
    const stateRef = db.collection('studyNotifState').doc(uid)
    const state = (await stateRef.get()).data() || {}
    const already = state.sent || {}
    const fresh = {}

    for (const a of deadlines) {
      const left = daysBetween(today, a.due)
      const m = MILESTONES.find(x => x.days === left)
      if (!m) continue
      const key = `${a.subject}|${a.what}|${a.due}|${m.days}`
      if (already[key]) continue

      const title = left === 0
        ? `Due today · ${a.subject}`
        : `${a.subject} · due ${m.word}`
      const body = `${a.what}${a.weight ? ` (${a.weight})` : ''} — due ${pretty(a.due)}.`

      const payload = JSON.stringify({
        title, body,
        tag: `${a.subject}-${a.due}`,     // collapses repeats for the same assessment
        url: '/#deadlines',
      })

      const live = []
      for (const s of subs) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); live.push(s); sent++ }
        catch (e) {
          if ([404, 410].includes(e.statusCode)) { pruned++ }   // device gone — drop it
          else { live.push(s); console.error('push error', uid, e.statusCode || e.message) }
        }
      }
      // drop dead endpoints so they don't get retried forever
      if (live.length !== subs.length) {
        await db.collection('study_hub').doc(uid).set({ pushSubscriptions: live }, { merge: true })
        subs.length = 0; subs.push(...live)
      }
      fresh[key] = true
    }

    if (Object.keys(fresh).length) {
      // keep only keys for deadlines still in the future, so this doc can't grow forever
      const keep = {}
      for (const [k, v] of Object.entries({ ...already, ...fresh })) {
        const due = k.split('|')[2]
        if (due && daysBetween(today, due) >= -3) keep[k] = v
      }
      await stateRef.set({ sent: keep, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
    }
  }

  console.log(`study-hub reminders — users:${users} sent:${sent} prunedDeadDevices:${pruned}`)
}

run().catch(e => { console.error(e); process.exit(1) })
