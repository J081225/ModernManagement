// scripts/send-twilio-reply.js — PREPARED, NOT SENT.
//
// The Twilio-reviewer reply, sent from the authenticated domain
// (jay@modernmanagementapp.com — SendGrid domain auth covers any
// @modernmanagementapp.com sender). Deliberately inert without BOTH:
//   --to <ticket-reply-address>   (Jay provides from the ticket)
//   --send                        (the explicit trigger)
// Anything less prints the preview and exits. Body text below is the
// draft awaiting Jay's approval — edit before sending if he revises.
//
// Usage:
//   node scripts/send-twilio-reply.js                      # preview only
//   node scripts/send-twilio-reply.js --to X@twilio.com --send
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const sgMail = require('@sendgrid/mail');

const FROM = { name: 'Jay Horton — R2 LABS LLC', email: 'jay@modernmanagementapp.com' };
const SUBJECT = 'Re: Toll-Free Verification — Modern Management (R2 LABS LLC)';

// ---- DRAFT BODY (awaiting Jay's approval) ----
const BODY_TEXT = [
  'Hello,',
  '',
  'Thank you for the review. Two updates on the items raised:',
  '',
  '1. Entity attribution: modernmanagementapp.com has been corrected',
  '   site-wide. Every public page now carries the accurate notice:',
  '   "© 2026 R2 LABS LLC · Modern Management is a product of',
  '   R2 LABS LLC, New York, NY." The Terms of Service and Privacy',
  '   Policy name R2 LABS LLC, a New York limited liability company,',
  '   as the operating entity.',
  '',
  '2. This reply is sent from the authenticated business domain',
  '   (jay@modernmanagementapp.com), matching the website and the',
  '   business records on the verification.',
  '',
  'Happy to provide anything further.',
  '',
  'Jay Horton',
  'R2 LABS LLC — Modern Management',
  'modernmanagementapp.com',
].join('\n');

const args = process.argv.slice(2);
const toIdx = args.indexOf('--to');
const to = toIdx >= 0 ? args[toIdx + 1] : null;
const send = args.includes('--send');

console.log('FROM:    ' + FROM.name + ' <' + FROM.email + '>');
console.log('TO:      ' + (to || '(not provided — waiting on the ticket reply address)'));
console.log('SUBJECT: ' + SUBJECT);
console.log('---\n' + BODY_TEXT + '\n---');

if (!to || !send) {
  console.log('\nPREVIEW ONLY — nothing sent. Provide --to <address> --send to dispatch.');
  process.exit(0);
}
if (!process.env.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY missing.');
  process.exit(1);
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
sgMail.send({ to, from: FROM, subject: SUBJECT, text: BODY_TEXT })
  .then(() => console.log('SENT to ' + to))
  .catch((e) => { console.error('SEND FAILED: ' + (e.response ? JSON.stringify(e.response.body) : e.message)); process.exit(1); });
