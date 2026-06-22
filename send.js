import admin from 'firebase-admin'
import webpush from 'web-push'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BFoFOcasZrzcngovcTQvyiyAS98rxo54CVbHNSNZzsY4paLeOocBh2RJm3kwP_zHD94NZv4Jcj8kCJtmdtsHueQ'
webpush.setVapidDetails('mailto:eksomnang72@gmail.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE)

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const localNow = (tz) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: DOW.indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) }
}

const daysBetween = (fromYMD, toYMD) =>
  Math.round((Date.parse(toYMD + 'T00:00:00Z') - Date.parse(fromYMD + 'T00:00:00Z')) / 86400000)

async function run() {
  const snap = await db.collection('sessions').get()
  let sentTotal = 0
  for (const doc of snap.docs) {
    const uid = doc.id
    const d = doc.data() || {}
    const subs = (d.pushSubscriptions || []).filter(s => s?.endpoint && s?.keys)
    if (!subs.length) continue
    const tz = subs.find(s => s.tz)?.tz || 'Australia/Melbourne'
    const { date, weekday, minutes } = localNow(tz)
    const stateRef = db.collection('notifState').doc(uid)
    const sent = new Set((((await stateRef.get()).data() || {}).sent) || [])
    const queue = []
    for (const h of (d.habits || [])) {
      if (!h.reminderTime) continue
      if (!(h.days || [0, 1, 2, 3, 4, 5, 6]).includes(weekday)) continue
      if ((d.habitLog?.[h.id] || []).includes(date)) continue
      const [hh, mm] = String(h.reminderTime).split(':').map(Number)
      const rem = hh * 60 + mm
      if (minutes >= rem && minutes < rem + 60) {
        const key = `habit:${h.id}:${date}`
        if (!sent.has(key)) queue.push({ key, title: `${h.emoji || '⏰'} ${h.name}`, body: 'Time to do your habit', tag: key })
      }
    }
    const lead = d.profile?.subReminderDays ?? 2
    if (minutes >= 540) {
      for (const it of (d.subscriptions || [])) {
        if (it.type !== 'subscription' || it.status !== 'active' || !it.nextRenewalDate) continue
        const du = daysBetween(date, it.nextRenewalDate)
        if (du < 0 || du > lead) continue
        const key = `sub:${it.id}:${date}`
        if (!sent.has(key)) {
          const when = du === 0 ? 'today' : du === 1 ? 'tomorrow' : `in ${du} days`
          queue.push({ key, title: `💳 ${it.name} renews ${when}`, body: 'Upcoming subscription charge', tag: `sub:${it.id}` })
        }
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
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
    const pruned = [...sent].filter(k => { const m = k.match(/:(\d{4}-\d{2}-\d{2})$/); return !m || m[1] >= cutoff })
    await stateRef.set({ sent: pruned, updatedAt: new Date().toISOString() })
  }
  console.log(`Done. Sent ${sentTotal} notification(s).`)
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
