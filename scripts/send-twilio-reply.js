// scripts/send-twilio-reply.js — DISPATCH VERSION (Jay's ruling,
// ticket confirmed). Headers and body verbatim from Jay. Still
// requires --to AND --send; preview otherwise.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const sgMail = require('@sendgrid/mail');

const FROM = { name: 'Jay Horton — R2 Labs LLC', email: 'jay@modernmanagementapp.com' };
const REPLY_TO = 'jayhorton87@gmail.com';
const SUBJECT = 'Re: Request #28847766 — R2 LABS LLC profile verification (BU93940826a7eaa1d353df389e1204e09c)';

const BODY_TEXT = [
  'Hi Danny,',
  '',
  'Thank you for the response — happy to provide both items.',
  '',
  '1. Business association with the website: Modern Management is the',
  'product name of R2 LABS LLC — there is no separate company. The site',
  'previously displayed outdated placeholder text reading "Modern',
  'Management Inc.," which was an error; no such corporation exists. The',
  'site has been corrected: every public page of',
  'https://modernmanagementapp.com now identifies R2 LABS LLC, a New York',
  'limited liability company, as the operating entity, and the footer',
  'reads "Modern Management is a product of R2 LABS LLC, New York, NY" —',
  'which you can verify live.',
  '',
  '2. Business domain email: this reply is sent from',
  'jay@modernmanagementapp.com, on our business domain, to confirm our',
  'association with the entity.',
  '',
  'For reference: Profile SID BU93940826a7eaa1d353df389e1204e09c,',
  'R2 LABS LLC, EIN 42-3378394 — our CP-575 is already attached to this',
  'ticket.',
  '',
  'Please let me know if anything further would help.',
  '',
  'Best regards,',
  'James "Jay" Horton',
  'R2 Labs LLC',
].join('\n');

const args = process.argv.slice(2);
const toIdx = args.indexOf('--to');
const to = toIdx >= 0 ? args[toIdx + 1] : null;
const send = args.includes('--send');

console.log('FROM:     ' + FROM.name + ' <' + FROM.email + '>');
console.log('REPLY-TO: ' + REPLY_TO);
console.log('TO:       ' + (to || '(not provided)'));
console.log('SUBJECT:  ' + SUBJECT);
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
sgMail.send({ to, from: FROM, replyTo: REPLY_TO, subject: SUBJECT, text: BODY_TEXT })
  .then(([res]) => {
    console.log('SENT to ' + to);
    console.log('SendGrid status: ' + res.statusCode);
    console.log('x-message-id: ' + (res.headers['x-message-id'] || '(none)'));
  })
  .catch((e) => { console.error('SEND FAILED: ' + (e.response ? JSON.stringify(e.response.body) : e.message)); process.exit(1); });
