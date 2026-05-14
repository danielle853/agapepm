/**
 * AGAPE PROPERTY MANAGEMENT
 * Firebase Cloud Functions — index.js
 * ─────────────────────────────────────────────────────────────
 * Notifications: WhatsApp (Twilio) primary + Email (Gmail) backup
 *
 * Functions:
 *   1. checkIcalBookings    — every hour, reads iCal, creates jobs
 *   2. onJobCreated         — notifies operator, dispatches by tier
 *   3. onReportSubmitted    — emails host, notifies operator
 *   4. onWorkerApplied      — notifies operator, confirms to worker
 * ─────────────────────────────────────────────────────────────
 */

const functions  = require('firebase-functions');
const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');
const twilio     = require('twilio');
const https      = require('https');

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ───────────────────────────────────────────────────
const OPERATOR_EMAIL    = 'danielle.lindsey9@gmail.com';
const OPERATOR_WHATSAPP = 'whatsapp:+14696058877'; // 
const OPERATOR_NAME     = 'Agape Property Management';
const BASE_URL          = 'https://agapepm.netlify.app';

// ── TWILIO CLIENT ────────────────────────────────────────────
function getTwilio() {
  const cfg = functions.config();
  return twilio(
    cfg.twilio?.sid   || process.env.TWILIO_SID,
    cfg.twilio?.token || process.env.TWILIO_TOKEN
  );
}

const TWILIO_FROM = 'whatsapp:+14155238886'; // Twilio sandbox number

// ── EMAIL TRANSPORTER ────────────────────────────────────────
function getMailer() {
  const cfg = functions.config();
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: cfg.gmail?.user || process.env.GMAIL_USER,
      pass: cfg.gmail?.pass || process.env.GMAIL_PASS,
    }
  });
}

// ─────────────────────────────────────────────────────────────
// SEND HELPERS — WhatsApp first, email as backup
// ─────────────────────────────────────────────────────────────

/**
 * Send WhatsApp message. Falls back to email if WhatsApp fails.
 * @param {string} toWhatsapp  - e.g. 'whatsapp:+12145550100'
 * @param {string} toEmail     - fallback email address
 * @param {string} waMessage   - WhatsApp message text
 * @param {object} emailOpts   - { subject, html } for email fallback
 */
async function notify(toWhatsapp, toEmail, waMessage, emailOpts) {
  let whatsappSent = false;

  // Try WhatsApp first
  if (toWhatsapp) {
    try {
      const client = getTwilio();
      await client.messages.create({
        from: TWILIO_FROM,
        to:   toWhatsapp,
        body: waMessage,
      });
      whatsappSent = true;
      console.log(`WhatsApp sent to ${toWhatsapp}`);
    } catch (e) {
      console.warn(`WhatsApp failed for ${toWhatsapp}:`, e.message);
    }
  }

  // Always send email as backup (or if WhatsApp failed)
  if (toEmail && emailOpts) {
    try {
      const mailer = getMailer();
      await mailer.sendMail({
        from:    `"${OPERATOR_NAME}" <${OPERATOR_EMAIL}>`,
        to:      toEmail,
        subject: emailOpts.subject,
        html:    emailOpts.html,
      });
      console.log(`Email sent to ${toEmail}`);
    } catch (e) {
      console.error(`Email failed for ${toEmail}:`, e.message);
    }
  }

  return whatsappSent;
}

// ─────────────────────────────────────────────────────────────
// 1. CHECK ICAL BOOKINGS — every 60 minutes
// ─────────────────────────────────────────────────────────────
exports.checkIcalBookings = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    console.log('checkIcalBookings started');

    const propsSnap = await db.collection('properties')
      .where('active', '==', true)
      .get();

    const properties = propsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.icalLink);

    console.log(`${properties.length} properties with iCal links`);

    for (const prop of properties) {
      try {
        await processPropertyIcal(prop);
      } catch (e) {
        console.error(`Error processing ${prop.address}:`, e.message);
      }
    }
    return null;
  });

async function processPropertyIcal(prop) {
  const icalText = await fetchIcal(prop.icalLink);
  if (!icalText) return;

  const bookings = parseIcal(icalText);

  for (const booking of bookings) {
    const checkoutDate = booking.end;
    if (!checkoutDate || new Date(checkoutDate) < new Date()) continue;

    // Skip if job already exists
    const existing = await db.collection('jobs')
      .where('propertyId',  '==', prop.id)
      .where('checkoutDate','==', checkoutDate)
      .where('source',      '==', 'ical-auto')
      .get();

    if (!existing.empty) continue;

    // Create job
    await db.collection('jobs').add({
      propertyId:    prop.id,
      address:       prop.address || '',
      city:          prop.city || 'Dallas, TX',
      hostEmail:     prop.hostEmail || '',
      hostName:      prop.hostName || '',
      hostWhatsapp:  prop.hostWhatsapp || null,
      serviceType:   'cleaning',
      checkoutDate,
      checkoutTime:  prop.defaultCheckoutTime || '11:00',
      cleanerNotes:  prop.cleanerNotes || '',
      status:        'pending',
      source:        'ical-auto',
      bookingRef:    booking.uid || '',
      guestName:     booking.summary || 'Guest',
      workerId:      prop.defaultWorkerId || null,
      workerName:    prop.defaultWorkerName || null,
      workerEmail:   prop.defaultWorkerEmail || null,
      workerWhatsapp:prop.defaultWorkerWhatsapp || null,
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Job created: ${prop.address} on ${checkoutDate}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. ON JOB CREATED — notify operator + dispatch by tier
// ─────────────────────────────────────────────────────────────
exports.onJobCreated = functions.firestore
  .document('jobs/{jobId}')
  .onCreate(async (snap, context) => {
    const job   = snap.data();
    const jobId = context.params.jobId;

    if (job.source !== 'ical-auto') return null;

    // Build job link with address in URL
    const addressSlug = encodeURIComponent((job.address||'').replace(/\s+/g,'-'));
    const jobLink     = `${BASE_URL}/worker/?jobId=${jobId}&address=${addressSlug}`;
    const dashLink    = `${BASE_URL}/operator/`;

    // Get worker tier
    let workerTier = 'standard';
    if (job.workerId) {
      const wSnap = await db.collection('workers').doc(job.workerId).get();
      if (wSnap.exists) workerTier = wSnap.data().tier || 'standard';
    }

    const tierLabel = {
      'white-glove': '⭐ White Glove — auto-dispatched',
      'premium':     '✦ Premium — tap to approve',
      'standard':    '· Standard — manual review needed',
    }[workerTier] || 'Manual review needed';

    // ── Notify operator via WhatsApp + email ──
    const operatorWA = `🏠 *New Agape booking*\n\n` +
      `📍 ${job.address}\n` +
      `📅 Check-out: ${job.checkoutDate} at ${job.checkoutTime}\n` +
      `👤 Guest: ${job.guestName||'—'}\n` +
      `👷 ${job.workerName||'No worker assigned'}\n` +
      `🏷 ${tierLabel}\n\n` +
      `Open dashboard:\n${dashLink}`;

    await notify(
      OPERATOR_WHATSAPP,
      OPERATOR_EMAIL,
      operatorWA,
      {
        subject: `New booking — ${job.address} · ${job.checkoutDate}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2>New booking detected.</h2>
            <p><strong>Property:</strong> ${job.address}</p>
            <p><strong>Check-out:</strong> ${job.checkoutDate} at ${job.checkoutTime}</p>
            <p><strong>Guest:</strong> ${job.guestName||'—'}</p>
            <p><strong>Worker:</strong> ${job.workerName||'Not assigned'}</p>
            <p><strong>Tier:</strong> ${tierLabel}</p>
            <a href="${dashLink}" style="display:inline-block;background:#111;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;margin:16px 0;">Open dashboard →</a>
          </div>`,
      }
    );

    // ── Dispatch based on tier ──
    if (workerTier === 'white-glove' && job.workerId) {
      // Auto-dispatch immediately
      await db.collection('jobs').doc(jobId).update({
        status: 'dispatched',
        jobLink,
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await notifyWorker(job, jobLink);

    } else if (workerTier === 'premium' && job.workerId) {
      await db.collection('jobs').doc(jobId).update({
        status: 'awaiting-approval',
        jobLink,
        requiresApproval: true,
      });

    } else {
      await db.collection('jobs').doc(jobId).update({
        status: 'pending',
        jobLink,
        requiresApproval:  true,
        requiresAssignment: !job.workerId,
      });
    }

    return null;
  });

// ─────────────────────────────────────────────────────────────
// 3. ON REPORT SUBMITTED
// ─────────────────────────────────────────────────────────────
exports.onReportSubmitted = functions.firestore
  .document('reports/{reportId}')
  .onCreate(async (snap, context) => {
    const report   = snap.data();
    const reportId = context.params.reportId;

    // Get job details
    let job = {};
    if (report.jobId) {
      const jSnap = await db.collection('jobs').doc(report.jobId).get();
      if (jSnap.exists) job = jSnap.data();
      await db.collection('jobs').doc(report.jobId).update({
        status:      'complete',
        reportId,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const address    = report.address || job.address || 'your property';
    const workerName = report.workerName || job.workerName || 'Your cleaner';
    const payLink    = `${BASE_URL}/pay/?jobId=${report.jobId||''}&reportId=${reportId}`;
    const damage     = report.damageNotes ? `\n⚠️ Damage noted: ${report.damageNotes}` : '';

    // ── Notify operator ──
    const operatorWA = `✅ *Report submitted*\n\n` +
      `📍 ${address}\n` +
      `👷 ${workerName}\n` +
      `✔️ Tasks: ${report.tasksDone||'—'}\n` +
      `📸 Photos: ${report.photosTotal||0}` +
      damage + `\n\n` +
      `Review + approve payment:\n${payLink}`;

    await notify(
      OPERATOR_WHATSAPP,
      OPERATOR_EMAIL,
      operatorWA,
      {
        subject: `Report submitted — ${address}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2>Report submitted.</h2>
            <p><strong>Property:</strong> ${address}</p>
            <p><strong>Worker:</strong> ${workerName}</p>
            <p><strong>Tasks done:</strong> ${report.tasksDone||'—'}</p>
            <p><strong>Photos:</strong> ${report.photosTotal||0}</p>
            ${report.damageNotes ? `<p style="color:red;"><strong>⚠ Damage:</strong> ${report.damageNotes}</p>` : ''}
            <a href="${payLink}" style="display:inline-block;background:#111;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;margin:16px 0;">Review report →</a>
          </div>`,
      }
    );

    // ── Notify host ──
    const hostWhatsapp = job.hostWhatsapp || null;
    const hostEmail    = job.hostEmail || null;
    const hostWA = `✅ *Your property is ready*\n\n` +
      `📍 ${address}\n` +
      `🧹 Clean complete — ${workerName}\n\n` +
      `Review your report and approve payment:\n${payLink}`;

    await notify(
      hostWhatsapp,
      hostEmail,
      hostWA,
      {
        subject: `✓ Clean complete — ${address}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2>Your property is ready.</h2>
            <p>${workerName} has completed the clean at <strong>${address}</strong>.</p>
            <a href="${payLink}" style="display:inline-block;background:#4CAF50;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;margin:16px 0;font-weight:600;">Review report &amp; approve payment →</a>
            <p style="color:#aaa;font-size:12px;">— Agape Property Management · Dallas, TX</p>
          </div>`,
      }
    );

    return null;
  });

// ─────────────────────────────────────────────────────────────
// 4. ON WORKER APPLIED
// ─────────────────────────────────────────────────────────────
exports.onWorkerApplied = functions.firestore
  .document('workers/{workerId}')
  .onCreate(async (snap, context) => {
    const worker   = snap.data();
    const dashLink = `${BASE_URL}/operator/`;

    if (worker.status !== 'pending') return null;

    // ── Notify operator ──
    const operatorWA = `🆕 *New provider application*\n\n` +
      `👤 ${worker.name||'—'}\n` +
      `📧 ${worker.email||'—'}\n` +
      `📱 ${worker.phone||'—'}\n` +
      `🔧 Services: ${(worker.services||[]).join(', ')||'—'}\n\n` +
      `Review in dashboard:\n${dashLink}`;

    await notify(
      OPERATOR_WHATSAPP,
      OPERATOR_EMAIL,
      operatorWA,
      {
        subject: `New worker application — ${worker.name||worker.email}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2>New provider application.</h2>
            <p><strong>Name:</strong> ${worker.name||'—'}</p>
            <p><strong>Email:</strong> ${worker.email||'—'}</p>
            <p><strong>Phone:</strong> ${worker.phone||'—'}</p>
            <p><strong>Services:</strong> ${(worker.services||[]).join(', ')||'—'}</p>
            <a href="${dashLink}" style="display:inline-block;background:#4CAF50;color:#111;padding:12px 28px;text-decoration:none;border-radius:4px;margin:16px 0;font-weight:600;">Review in dashboard →</a>
          </div>`,
      }
    );

    // ── Confirm to worker via email ──
    if (worker.email) {
      const mailer = getMailer();
      await mailer.sendMail({
        from:    `"${OPERATOR_NAME}" <${OPERATOR_EMAIL}>`,
        to:      worker.email,
        subject: 'Application received — Agape Property Management',
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2>Application received.</h2>
            <p>Hi ${(worker.name||'').split(' ')[0]||'there'},</p>
            <p>Thank you for applying to join the Agape network. We'll review your application within 24 hours and reach out via WhatsApp once approved.</p>
            <p style="color:#aaa;font-size:12px;">— Agape Property Management · Dallas, TX</p>
          </div>`,
      });
    }

    return null;
  });

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function notifyWorker(job, jobLink) {
  const firstName = (job.workerName||'').split(' ')[0] || 'there';
  const workerWA  = `👋 Hi ${firstName}!\n\n` +
    `*New Agape job* 🧹\n\n` +
    `📍 ${job.address}\n` +
    `📅 ${job.checkoutDate} at ${job.checkoutTime}\n` +
    `🔧 ${job.serviceType||'Cleaning'}\n` +
    (job.cleanerNotes ? `📝 Notes: ${job.cleanerNotes}\n` : '') +
    `\nOpen your checklist:\n${jobLink}`;

  await notify(
    job.workerWhatsapp || null,
    job.workerEmail    || null,
    workerWA,
    {
      subject: `New job — ${job.address} · ${job.checkoutDate}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;">
          <h2>You have a new job.</h2>
          <p>Hi ${firstName},</p>
          <p><strong>📍 Property:</strong> ${job.address}</p>
          <p><strong>📅 Check-out:</strong> ${job.checkoutDate} at ${job.checkoutTime}</p>
          <p><strong>🧹 Service:</strong> ${job.serviceType||'Cleaning'}</p>
          ${job.cleanerNotes ? `<p><strong>Notes:</strong> ${job.cleanerNotes}</p>` : ''}
          <a href="${jobLink}" style="display:inline-block;background:#4CAF50;color:#111;padding:14px 32px;text-decoration:none;border-radius:4px;margin:16px 0;font-weight:700;font-size:16px;">Open my checklist →</a>
          <p style="color:#aaa;font-size:12px;">— Agape Property Management · Dallas, TX</p>
        </div>`,
    }
  );
}

async function fetchIcal(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', (e) => {
      console.error('iCal fetch error:', e.message);
      resolve(null);
    });
  });
}

function parseIcal(text) {
  const bookings = [];
  const events   = text.split('BEGIN:VEVENT');
  for (let i = 1; i < events.length; i++) {
    const block = events[i];
    const get   = (key) => {
      const m = block.match(new RegExp(key + '[^:]*:(.+)'));
      return m ? m[1].trim().replace(/\r/g,'') : null;
    };
    const summary = get('SUMMARY');
    const sum     = (summary||'').toLowerCase();
    if (sum.includes('block') || sum.includes('unavailable') || sum.includes('closed')) continue;
    const fmt = (d) => {
      if (!d) return null;
      const c = d.replace(/[^0-9]/g,'').slice(0,8);
      return c.length === 8 ? `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}` : null;
    };
    bookings.push({
      uid:     get('UID'),
      summary,
      start:   fmt(get('DTSTART')),
      end:     fmt(get('DTEND')),
    });
  }
  return bookings;
}
