// Makes the sample file bytes and thumbnails for the Acme Co. demo world.
//
//   node demo/make-assets.js            # everything
//   node demo/make-assets.js --only brand-guidelines,offsite
//
// Output (all small, all made up):
//   demo/assets/files/<slug>.<ext>   what a preview or download serves (pdf, docx, xlsx, jpg, png, md, txt, csv)
//   demo/assets/thumbs/<slug>.webp   480x360 card thumbnail, drawn the way server/lib/thumbnails.js would
// PDFs and pictures are rendered by headless Chrome (capture/cdp.js) from the HTML/SVG below;
// .docx comes from the `docx` package, .xlsx from the app's own vendored SheetJS.
// base.js maps each demo file to one of these slugs (FILES[].asset).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { launch, sleep } = require('../capture/cdp');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, 'assets');
const FONT = fs.readFileSync(path.join(ROOT, 'vendor', 'fonts', 'inter-var.woff2'));
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const want = (slug) => !only || only.has(slug);

const C = { navy: '#1F3A5F', coral: '#E0674B', teal: '#2A9D8F', sand: '#F4EDE4', gold: '#E9B949', ink: '#1D2733', sky: '#5B8DB8', plum: '#7A4E7E', green: '#3E8E5E' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MARK = (size = 28, bg = C.navy) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="${bg}"/><path d="M17 46 L32 17 L47 46" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="40" r="5" fill="${C.coral}"/></svg>`;

// ───────────────────────── documents (PDF) ─────────────────────────
// A document is { title, kicker, sub, ref, c1, c2, footer, pages: [[block…]…] }.
// Blocks: {h}, {p}, {ul}, {table:{head,rows,num,total}}, {kpis:[[label,value,note]]},
// {bars:{labels,values,unit,title}}, {callout}, {meta:[[label,value]]}, {html}, {sign:[a,b]}.
const PAGE_CSS = `
@page{size:8.5in 11in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:${C.ink};-webkit-print-color-adjust:exact;print-color-adjust:exact}
/* A strict type scale (11 / 13 / 16 / 18 / 34): Chrome embeds one font subset per size and
   weight, so every extra size costs ~13 KB in each PDF. */
.page{width:816px;height:1056px;padding:58px 72px 70px;position:relative;overflow:hidden;page-break-after:always;background:#fff}
.page:last-child{page-break-after:auto}
.band{position:absolute;left:0;top:0;right:0;height:10px;background:var(--c1)}
.head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#6b7785;margin-bottom:34px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;color:${C.ink};font-size:13px}
.kicker{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--c2);font-weight:700}
h1{font-size:34px;line-height:1.12;margin:8px 0 10px;letter-spacing:-.02em;font-weight:700}
.sub{font-size:16px;color:#4a5663;margin:0 0 22px;line-height:1.45}
h2{font-size:18px;margin:24px 0 8px;font-weight:700;color:var(--c1)}
p{font-size:13px;line-height:1.6;margin:0 0 10px;color:#2e3a47}
ul{margin:0 0 12px;padding-left:18px} li{font-size:13px;line-height:1.6;color:#2e3a47;margin-bottom:2px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 16px}
th{text-align:left;background:#f1f4f7;color:#4a5663;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid #d9e0e7}
td{padding:7px 10px;border-bottom:1px solid #e6ebf0;color:#2e3a47}
.n{text-align:right;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:2px solid ${C.ink};border-bottom:0;color:${C.ink}}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 22px}
.meta div{background:#f5f7f9;border-radius:8px;padding:10px 12px;font-size:11px;color:#6b7785;text-transform:uppercase;letter-spacing:.05em}
.meta b{display:block;font-size:13px;color:${C.ink};margin-top:3px;text-transform:none;letter-spacing:0;font-weight:700}
.foot{position:absolute;bottom:26px;left:72px;right:72px;display:flex;justify-content:space-between;font-size:11px;color:#8a95a1;border-top:1px solid #e6ebf0;padding-top:8px}
.callout{border-left:4px solid var(--c2);background:#faf5f0;padding:12px 16px;border-radius:0 8px 8px 0;margin:10px 0 16px;font-size:13px;line-height:1.55;color:#2e3a47}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:8px 0 18px}
.kpi{border:1px solid #e1e7ed;border-radius:10px;padding:12px 13px}
.kpi span{font-size:11px;color:#6b7785;text-transform:uppercase;letter-spacing:.05em}
.kpi b{display:block;font-size:34px;margin:4px 0 2px;font-weight:700;letter-spacing:-.02em}
.kpi i{font-style:normal;font-size:11px;color:${C.green}}
.chart{margin:4px 0 16px}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}
.sign div{border-top:1px solid #9aa5b1;padding-top:6px;font-size:11px;color:#4a5663}
.sign b{display:block;color:${C.ink};font-size:13px}
`;
function bars({ labels, values, unit = '', color = 'var(--c1)', title = '' }) {
  const W = 672, H = 190, pad = 28, max = Math.max(...values) * 1.15, bw = (W - pad * 2) / values.length;
  const b = values.map((v, i) => {
    const h = (v / max) * (H - 46), x = pad + i * bw + bw * 0.18, y = H - 24 - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${i === values.length - 1 ? C.coral : color}"/>`
      + `<text x="${(x + bw * 0.32).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" text-anchor="middle" fill="#4a5663">${esc(unit + v.toLocaleString('en-US'))}</text>`
      + `<text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#6b7785">${esc(labels[i])}</text>`;
  }).join('');
  return `<div class="chart">${title ? `<div style="font-size:11px;color:#6b7785;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">${esc(title)}</div>` : ''}<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Arial"><line x1="${pad}" x2="${W - pad}" y1="${H - 24}" y2="${H - 24}" stroke="#d9e0e7"/>${b}</svg></div>`;
}
function block(b) {
  if (b.h) return `<h2>${esc(b.h)}</h2>`;
  if (b.p) return `<p>${esc(b.p)}</p>`;
  if (b.ul) return `<ul>${b.ul.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (b.callout) return `<div class="callout">${esc(b.callout)}</div>`;
  if (b.meta) return `<div class="meta">${b.meta.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('')}</div>`;
  if (b.kpis) return `<div class="kpis">${b.kpis.map(([k, v, n]) => `<div class="kpi"><span>${esc(k)}</span><b>${esc(v)}</b>${n ? `<i>${esc(n)}</i>` : ''}</div>`).join('')}</div>`;
  if (b.bars) return bars(b.bars);
  if (b.sign) return `<div class="sign">${b.sign.map(([n, r]) => `<div><b>${esc(n)}</b>${esc(r)}</div>`).join('')}</div>`;
  if (b.html) return b.html;
  if (b.table) {
    const t = b.table, num = new Set(t.num || []);
    const rows = t.rows.map((r, i) => `<tr${t.total && i === t.rows.length - 1 ? ' class="total"' : ''}>${r.map((c, j) => `<td${num.has(j) ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${t.head.map((h, j) => `<th${num.has(j) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  return '';
}
function docHtml(d) {
  const n = d.pages.length;
  const pages = d.pages.map((blocks, i) => `<section class="page"><div class="band"></div>`
    + `<div class="head"><span class="brand">${MARK(24)}Acme Co.</span><span>${esc(d.ref || '')}</span></div>`
    + (i === 0 ? `${d.kicker ? `<div class="kicker">${esc(d.kicker)}</div>` : ''}<h1>${esc(d.title)}</h1>${d.sub ? `<p class="sub">${esc(d.sub)}</p>` : ''}` : '')
    + blocks.map(block).join('')
    + `<div class="foot"><span>${esc(d.footer || 'Acme Co.')}</span><span>Page ${i + 1} of ${n}</span></div></section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name || d.title)}</title><style>${PAGE_CSS}:root{--c1:${d.c1 || C.navy};--c2:${d.c2 || C.coral}}</style></head><body>${pages}</body></html>`;
}

// The PDF's own title (Chrome's viewer shows it in its toolbar): the file's name in Depot.
const PDF_NAMES = {
  'brand-guidelines': 'Brand guidelines', 'harbor-point-proposal': 'Harbor Point Dental proposal', 'riverside-proposal': 'Riverside Library proposal',
  'northfield-agreement': 'Northfield Clinic service agreement', 'maple-contract': 'Maple Street Bakery contract', 'monthly-report-aug': 'Monthly report - August',
  'floor-plan': 'Floor plan', 'menu-redesign': 'Menu redesign', 'invoice-1042': 'Invoice 1042 - Northfield Clinic', 'invoice-1043': 'Invoice 1043 - Maple Street Bakery',
  'q2-summary': 'Q2 financial summary', 'expense-policy': 'Expense policy', 'new-starter-guide': 'New starter guide', 'office-move-plan': 'Office move plan',
  'travel-itinerary': 'Travel itinerary', 'intake-form': 'Intake form - signed',
};
const PDFS = {
  'brand-guidelines': {
    title: 'Brand guidelines', kicker: 'Marketing', sub: 'How Acme Co. looks, sounds and shows up. Use this guide for anything a client or the public will see.',
    ref: 'Version 3.2 · September 2026', footer: 'Acme Co. · Brand guidelines', c1: C.navy, c2: C.coral,
    pages: [
      [
        { html: `<div style="display:flex;align-items:center;gap:26px;background:${C.sand};border-radius:16px;padding:34px 38px;margin:6px 0 26px">${MARK(110)}<div><div style="font-size:44px;font-weight:700;letter-spacing:-.03em">Acme Co.</div><div style="font-size:16px;color:#4a5663;margin-top:4px">Practical design and technology for growing teams</div></div></div>` },
        { h: 'What is in this guide' },
        { table: { head: ['Section', 'What it covers', 'Page'], num: [2], rows: [['Our logo', 'The mark, the wordmark, clear space and sizes', '2'], ['Colour', 'The five brand colours and how much of each to use', '2'], ['Typography', 'Typefaces, sizes and the type scale', '3'], ['Voice and tone', 'How we write for clients and the public', '3'], ['Photography', 'What good Acme photos look like', '3']] } },
        { callout: 'Short on time? Use the logo files in Marketing / Brand, keep plenty of white space around the mark, and write the way you would talk to a client across the table.' },
        { h: 'Who looks after the brand' },
        { p: 'Priya Shah leads the brand for Acme Co. Ask Priya before you change the logo, add a new colour or produce anything printed in large numbers. Everyone is welcome to use these guidelines for proposals, reports and slides.' },
      ],
      [
        { h: 'Our logo' },
        { html: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:4px 0 14px"><div style="border:1px solid #e1e7ed;border-radius:12px;height:150px;display:flex;align-items:center;justify-content:center;gap:14px">${MARK(64)}<span style="font-size:30px;font-weight:700;letter-spacing:-.02em">Acme Co.</span></div><div style="background:${C.navy};border-radius:12px;height:150px;display:flex;align-items:center;justify-content:center;gap:14px;color:#fff">${MARK(64, '#2B4C75')}<span style="font-size:30px;font-weight:700;letter-spacing:-.02em">Acme Co.</span></div></div>` },
        { ul: ['Keep clear space around the logo equal to the height of the coral dot, at least.', 'Never place the logo smaller than 24 pixels high on screen or 10 mm in print.', 'Use the white version on navy or on photographs. Do not stretch, rotate or recolour the mark.'] },
        { h: 'Colour' },
        { html: `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:6px 0 12px">${[['Harbor navy', C.navy, '#fff'], ['Coral', C.coral, '#fff'], ['Teal', C.teal, '#fff'], ['Sand', C.sand, C.ink], ['Gold', C.gold, C.ink]].map(([n, hex, ink]) => `<div style="border-radius:10px;overflow:hidden;border:1px solid #e1e7ed"><div style="background:${hex};height:92px;color:${ink};padding:10px;font-size:11px;font-weight:700">${n}</div><div style="padding:8px 10px;font-size:11px;color:#4a5663">${hex.toUpperCase()}</div></div>`).join('')}</div>` },
        { p: 'Navy and white carry most layouts. Use coral sparingly for the one thing you want people to notice, such as a call to action or a key number. Teal, sand and gold support charts and backgrounds.' },
        { table: { head: ['Colour', 'Use it for', 'Share of a layout'], rows: [['Harbor navy', 'Headings, the logo, dark backgrounds', 'About 30%'], ['White and sand', 'Page backgrounds and space', 'About 60%'], ['Coral', 'One highlight per page', 'Under 5%'], ['Teal and gold', 'Charts, tags and illustrations', 'About 5%']] } },
      ],
      [
        { h: 'Typography' },
        { html: `<div style="border:1px solid #e1e7ed;border-radius:12px;padding:18px 22px;margin:4px 0 14px"><div style="font-size:34px;font-weight:700;letter-spacing:-.02em">Display, 34 / 40</div><div style="font-size:20px;font-weight:700;margin-top:6px">Section heading, 20 / 26</div><div style="font-size:13px;color:#4a5663;margin-top:8px;line-height:1.6">Body text, 13 / 21. Helvetica Neue is our typeface everywhere: documents, slides and the web. If it is not available, use Arial.</div></div>` },
        { h: 'Voice and tone' },
        { table: { head: ['We are', 'We are not'], rows: [['Clear: short sentences and plain words', 'Clever at the cost of being understood'], ['Warm: we write to people, not at them', 'Casual about facts, dates or prices'], ['Confident: we say what we recommend', 'Pushy or full of superlatives'], ['Helpful: we tell people what happens next', 'Vague about who does what']] } },
        { h: 'Photography' },
        { ul: ['Real people at work, in natural light. No staged handshakes.', 'Leave space in the frame for a headline when a photo will carry text.', 'Ask before photographing a client site, and store photos in the client\'s project folder.'] },
        { callout: 'Questions about the brand? Message Priya Shah or leave a comment on this file in Depot.' },
      ],
    ],
  },
  'harbor-point-proposal': {
    title: 'Patient portal refresh', kicker: 'Proposal for Harbor Point Dental', sub: 'A simpler way for patients to book, reschedule and pay, on any phone.', ref: 'Proposal P-2026-031', footer: 'Acme Co. · Prepared for Harbor Point Dental', c1: C.teal, c2: C.coral,
    pages: [[
      { meta: [['Prepared for', 'Harbor Point Dental'], ['Prepared by', 'Jordan Lee'], ['Valid until', '31 October 2026']] },
      { h: 'Summary' },
      { p: 'Harbor Point Dental takes most bookings by phone, and about one in five appointments is missed. We propose a refreshed patient portal with online booking, automatic reminders and card payments, built on the practice system you already use.' },
      { h: 'What we will deliver' },
      { ul: ['Online booking and rescheduling that shows real availability', 'Text and email reminders two days and two hours before each visit', 'Secure card payments and saved receipts', 'A short training session for the front desk team'] },
      { h: 'Timeline' },
      { table: { head: ['Phase', 'What happens', 'Weeks'], num: [2], rows: [['Discover', 'Interviews with staff and five patients', '2'], ['Design', 'Screens tested on real phones', '3'], ['Build', 'Portal, reminders and payments', '5'], ['Launch', 'Training, go-live and two weeks of support', '2']] } },
      { h: 'Investment' },
      { table: { head: ['Item', 'Price'], num: [1], total: true, rows: [['Discovery and design', '$14,500'], ['Build and testing', '$26,000'], ['Training and launch support', '$4,200'], ['Total', '$44,700']] } },
    ], [
      { h: 'Why Acme Co.' },
      { p: 'We have built booking tools for three clinics in the region. Each one cut missed appointments by at least a third within six months. We work in short cycles, show you progress every week and hand over everything you need to run the portal yourselves.' },
      { h: 'Next steps' },
      { ul: ['Reply to confirm the scope, or tell us what to change.', 'We send a short agreement and a start date.', 'Kick-off meeting at the practice in the first week.'] },
      { callout: 'Questions? Contact Jordan Lee at jordan.lee@acme.example.' },
    ]],
  },
  'riverside-proposal': {
    title: 'Community room booking', kicker: 'Proposal for Riverside Library', sub: 'Let residents find and book the library\'s three community rooms online.', ref: 'Proposal P-2025-044', footer: 'Acme Co. · Prepared for Riverside Library', c1: C.green, c2: C.gold,
    pages: [[
      { meta: [['Prepared for', 'Riverside Library'], ['Prepared by', 'Jordan Lee'], ['Date', 'May 2025']] },
      { h: 'The problem' },
      { p: 'Room requests arrive by phone, email and paper forms. Staff spend several hours a week checking a shared calendar by hand, and double bookings still happen.' },
      { h: 'Our recommendation' },
      { ul: ['A public calendar that shows free and booked times for each room', 'Simple request form with automatic confirmation emails', 'A staff view to approve, move or cancel bookings', 'Monthly usage report for the library board'] },
      { h: 'Investment' },
      { table: { head: ['Item', 'Price'], num: [1], total: true, rows: [['Design and build', '$18,000'], ['Training', '$1,500'], ['First year of hosting and support', '$2,400'], ['Total', '$21,900']] } },
    ]],
  },
  'northfield-agreement': {
    title: 'Service agreement', kicker: 'Acme Co. and Northfield Clinic', sub: 'Scheduling and records upgrade, phase one.', ref: 'Agreement SA-2026-018', footer: 'Acme Co. · Service agreement SA-2026-018', c1: C.navy, c2: C.teal,
    pages: [[
      { meta: [['Client', 'Northfield Clinic'], ['Start date', '6 October 2026'], ['Term', '16 weeks']] },
      { h: '1. Parties' },
      { p: 'This agreement is between Acme Co. ("Acme") and Northfield Clinic ("the Client"). It describes the services Acme will provide, the fees, and how both parties will work together.' },
      { h: '2. Services' },
      { ul: ['Replace the clinic\'s paper intake forms with secure online forms.', 'Connect online booking to the clinic\'s existing scheduling system.', 'Move ten years of scanned records into a searchable archive.', 'Train reception and clinical staff, and support the first month of use.'] },
      { h: '3. Fees and payment' },
      { table: { head: ['Milestone', 'Due', 'Amount'], num: [2], total: true, rows: [['Signed agreement', 'On signing', '$12,000'], ['Online forms live', 'Week 6', '$16,000'], ['Booking connected', 'Week 11', '$14,000'], ['Archive and training complete', 'Week 16', '$10,000'], ['Total', '', '$52,000']] } },
      { h: '4. Confidentiality' },
      { p: 'Acme will treat all patient information as confidential, store it only in systems approved by the Client, and delete working copies when the project ends.' },
    ], [
      { h: '5. Changes' },
      { p: 'Either party may ask for a change in writing. Acme will reply within five working days with the effect on cost and timeline. No change takes effect until both parties agree.' },
      { h: '6. Ending the agreement' },
      { p: 'Either party may end this agreement with 30 days written notice. The Client pays for work completed up to the end date.' },
      { sign: [['Jordan Lee', 'For Acme Co.'], ['Dana Whitfield', 'For Northfield Clinic']] },
    ]],
  },
  'maple-contract': {
    title: 'Design services contract', kicker: 'Acme Co. and Maple Street Bakery', sub: 'New brand, menu and online ordering.', ref: 'Contract C-2026-009', footer: 'Acme Co. · Contract C-2026-009', c1: '#8A5A2B', c2: C.coral,
    pages: [[
      { meta: [['Client', 'Maple Street Bakery'], ['Start date', '1 September 2026'], ['Term', '10 weeks']] },
      { h: 'Scope' },
      { ul: ['Logo and brand refresh, three concepts and two rounds of changes', 'Printed and online menu design', 'Online ordering page for collection orders'] },
      { h: 'Fees' },
      { table: { head: ['Item', 'Amount'], num: [1], total: true, rows: [['Brand refresh', '$6,800'], ['Menu design', '$3,200'], ['Online ordering page', '$7,500'], ['Total', '$17,500']] } },
      { h: 'Payment terms' },
      { p: 'Half on signing, half on completion. Invoices are due within 30 days.' },
      { sign: [['Jordan Lee', 'For Acme Co.'], ['Owner', 'For Maple Street Bakery']] },
    ]],
  },
  'monthly-report-aug': {
    title: 'Monthly report: August 2026', kicker: 'Client services', sub: 'Hours, delivery and client feedback across active projects.', ref: 'Report · August 2026', footer: 'Acme Co. · Internal', c1: C.navy, c2: C.coral,
    pages: [[
      { kpis: [['Billable hours', '612', '+8% on July'], ['Active clients', '7', '+1 new'], ['On-time delivery', '94%', 'Target 90%'], ['Client score', '4.6 / 5', '12 responses']] },
      { bars: { title: 'Billable hours by client', labels: ['Northfield', 'Harbor Point', 'Maple St', 'Riverside', 'Other'], values: [184, 142, 118, 96, 72] } },
      { h: 'Highlights' },
      { ul: ['Northfield Clinic signed phase one of the records upgrade.', 'Maple Street Bakery approved the new logo on the first round.', 'Harbor Point Dental asked for a proposal for their patient portal.'] },
      { h: 'Risks and follow-ups' },
      { table: { head: ['Item', 'Owner', 'Due'], rows: [['Confirm Northfield data migration window', 'Jordan Lee', '12 Sep'], ['Book photographer for Maple Street launch', 'Priya Shah', '19 Sep'], ['Review Q3 budget against actuals', 'Marcus Chen', '26 Sep']] } },
    ], [
      { h: 'Client feedback' },
      { p: '"The team explained every step and never left us guessing." Northfield Clinic' },
      { p: '"Our customers noticed the new menu on day one." Maple Street Bakery' },
      { h: 'Next month' },
      { ul: ['Start Northfield online forms build.', 'Send Harbor Point proposal.', 'Plan the autumn campaign with Marketing.'] },
    ]],
  },
  'floor-plan': {
    title: 'Ground floor plan', kicker: 'Northfield Clinic', sub: 'Survey drawing for the reception and waiting area refresh. Not to scale.', ref: 'Drawing NC-02 · Rev B', footer: 'Acme Co. · Site survey by Sam Okafor', c1: C.teal, c2: C.coral,
    pages: [[
      { html: planSvg() },
      { table: { head: ['Room', 'Area', 'Notes'], rows: [['Reception', '28 m²', 'New desk with a lower section for wheelchair users'], ['Waiting room', '46 m²', 'Seating for 18, children\'s corner by the window'], ['Consult 1 to 3', '12 m² each', 'No change'], ['Staff room', '16 m²', 'Move lockers to the corridor']] } },
    ]],
  },
  'menu-redesign': {
    title: 'Menu redesign: first concepts', kicker: 'Maple Street Bakery', sub: 'Two directions for the printed menu board and the online menu.', ref: 'Concepts · Round 1', footer: 'Acme Co. · For Maple Street Bakery', c1: '#8A5A2B', c2: C.gold,
    pages: [[
      { html: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:6px 0 16px">${['#FBF3E6', '#2F2A26'].map((bg, k) => `<div style="background:${bg};color:${k ? '#F7EBDD' : '#3B2A1C'};border-radius:14px;padding:22px 22px 18px;height:430px"><div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">Direction ${k ? 'B · Evening' : 'A · Morning'}</div><div style="font-size:30px;font-weight:700;margin:6px 0 14px;font-family:Georgia,serif">Maple Street</div>${[['Sourdough loaf', '6.50'], ['Cinnamon knot', '3.80'], ['Maple pecan scone', '3.60'], ['Seeded rye', '5.90'], ['Almond croissant', '4.20'], ['Flat white', '3.40'], ['Chai latte', '3.70']].map(([n, p]) => `<div style="display:flex;justify-content:space-between;border-bottom:1px dashed ${k ? '#5a4d43' : '#e2cdb3'};padding:8px 0;font-size:13px"><span>${n}</span><span>${p}</span></div>`).join('')}</div>`).join('')}</div>` },
      { h: 'What we would like from you' },
      { ul: ['Pick a direction, or tell us what you like from each.', 'Confirm prices and the items for the autumn menu.', 'Send any photos of your bakes you would like us to use.'] },
    ]],
  },
  'invoice-1042': invoice('1042', 'Northfield Clinic', 'Dana Whitfield, Practice manager', [['Service agreement SA-2026-018: signing milestone', '1', '12,000.00']], '12,000.00'),
  'invoice-1043': invoice('1043', 'Maple Street Bakery', 'Accounts', [['Brand refresh: 50% on signing', '1', '3,400.00'], ['Menu design: 50% on signing', '1', '1,600.00'], ['Online ordering page: 50% on signing', '1', '3,750.00']], '8,750.00'),
  'q2-summary': {
    title: 'Q2 2026 financial summary', kicker: 'Finance', sub: 'April to June. Prepared for the partners\' meeting.', ref: 'Finance · Q2 2026', footer: 'Acme Co. · Finance · Confidential', c1: C.navy, c2: C.teal,
    pages: [[
      { kpis: [['Revenue', '$486k', '+12% on Q1'], ['Gross margin', '41%', '+2 pts'], ['Cash at bank', '$312k', '4.8 months'], ['Invoices overdue', '3', '$18.4k']] },
      { bars: { title: 'Revenue by month ($k)', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], values: [138, 142, 154, 158, 161, 167], color: C.teal } },
      { h: 'Revenue by service' },
      { table: { head: ['Service', 'Q1', 'Q2', 'Change'], num: [1, 2, 3], total: true, rows: [['Design', '$162k', '$178k', '+10%'], ['Build', '$201k', '$236k', '+17%'], ['Support', '$71k', '$72k', '+1%'], ['Total', '$434k', '$486k', '+12%']] } },
    ], [
      { h: 'Costs' },
      { table: { head: ['Category', 'Budget', 'Actual', 'Variance'], num: [1, 2, 3], total: true, rows: [['Salaries', '$214k', '$211k', '-$3k'], ['Software and hosting', '$18k', '$21k', '+$3k'], ['Office', '$24k', '$24k', '$0'], ['Travel', '$9k', '$6k', '-$3k'], ['Total', '$265k', '$262k', '-$3k']] } },
      { h: 'Notes' },
      { ul: ['Software costs rose with two new design tools; both replace older ones in Q3.', 'Travel stayed low because most kick-offs moved to video calls.', 'The office move in November is budgeted separately.'] },
    ]],
  },
  'expense-policy': {
    title: 'Expense policy', kicker: 'Finance', sub: 'What Acme Co. pays for when you travel or buy things for work, and how to claim it back.', ref: 'Policy FIN-03 · Updated July 2026', footer: 'Acme Co. · Finance policy FIN-03', c1: C.navy, c2: C.gold,
    pages: [[
      { h: 'The short version' },
      { ul: ['Spend company money as if it were your own.', 'Keep every receipt. A photo is fine.', 'Claim within 30 days using the travel expense form in Finance.'] },
      { h: 'Limits' },
      { table: { head: ['Item', 'Limit', 'Needs approval'], rows: [['Hotel, per night', '$180', 'Above the limit'], ['Meals when travelling, per day', '$60', 'Never'], ['Client lunch, per person', '$45', 'Above $200 in total'], ['Train and coach', 'Standard class', 'First class'], ['Software and subscriptions', '$50 a month', 'Always'], ['Equipment', '$250', 'Above the limit']] } },
      { h: 'How to claim' },
      { p: 'Fill in the travel expense form, attach your receipts and send it to Marcus Chen. Claims approved by the 20th are paid with that month\'s salary.' },
    ], [
      { h: 'What we do not pay for' },
      { ul: ['Fines, including parking and speeding tickets.', 'Upgrades you chose for comfort, such as seat selection.', 'Alcohol, unless it is part of a client meal within the limit.'] },
      { callout: 'Not sure whether something counts? Ask Marcus Chen before you spend, not after.' },
    ]],
  },
  'new-starter-guide': {
    title: 'New starter guide', kicker: 'Operations', sub: 'Everything you need for your first two weeks at Acme Co.', ref: 'Onboarding · 2026 edition', footer: 'Acme Co. · Onboarding', c1: C.plum, c2: C.coral,
    pages: [[
      { h: 'Your first day' },
      { table: { head: ['Time', 'What happens', 'With'], rows: [['9:00', 'Welcome and building tour', 'Elena Garcia'], ['10:00', 'Laptop, accounts and Depot set-up', 'Sam Okafor'], ['12:30', 'Team lunch', 'Everyone'], ['14:00', 'How we run projects', 'Jordan Lee'], ['16:00', 'Your first week plan', 'Your manager']] } },
      { h: 'Who is who' },
      { table: { head: ['Name', 'Role', 'Ask them about'], rows: [['Elena Garcia', 'Operations lead', 'The office, holidays, anything unclear'], ['Priya Shah', 'Marketing lead', 'The brand, the website, social media'], ['Marcus Chen', 'Finance lead', 'Expenses, invoices, budgets'], ['Sam Okafor', 'IT and facilities', 'Laptops, Wi-Fi, printers, access'], ['Jordan Lee', 'Client services', 'Client projects and proposals']] } },
      { h: 'Where files live' },
      { p: 'We keep work files in Depot. Your own library is named after you. Team libraries such as Marketing and Finance are shared with the people who need them.' },
    ], [
      { h: 'Your first two weeks' },
      { ul: ['Read the brand guidelines and the expense policy.', 'Shadow a client call with Jordan.', 'Set up your profile photo in Depot.', 'Book a coffee with each lead.'] },
      { callout: 'Welcome to Acme Co. We are glad you are here.' },
    ]],
  },
  'office-move-plan': {
    title: 'Office move plan', kicker: 'Operations', sub: 'Moving to the new studio on Harbor Road in November.', ref: 'Plan · Draft 2', footer: 'Acme Co. · Operations', c1: C.plum, c2: C.gold,
    pages: [[
      { meta: [['Move date', 'Friday 13 November'], ['Owner', 'Elena Garcia'], ['Budget', '$24,000']] },
      { h: 'Timeline' },
      { table: { head: ['Week of', 'Task', 'Owner'], rows: [['12 Oct', 'Sign off the floor plan and furniture order', 'Elena Garcia'], ['19 Oct', 'Book movers and the internet install', 'Sam Okafor'], ['26 Oct', 'Tell clients about the new address', 'Priya Shah'], ['2 Nov', 'Pack non-essential items', 'Everyone'], ['9 Nov', 'Test Wi-Fi, printers and meeting rooms', 'Sam Okafor'], ['13 Nov', 'Move day', 'Everyone']] } },
      { h: 'What you need to do' },
      { ul: ['Label your boxes with your name and desk number.', 'Take anything personal home before 12 November.', 'Work from home on move day. The new office opens on Monday 16 November.'] },
    ]],
  },
  'travel-itinerary': {
    title: 'Travel itinerary', kicker: 'Client visit', sub: 'Harbor Point Dental discovery workshop.', ref: 'Trip · 14 to 15 October', footer: 'Acme Co. · Travel', c1: C.sky, c2: C.coral,
    pages: [[
      { meta: [['Traveller', 'Jordan Lee'], ['Dates', '14 to 15 October'], ['Booked by', 'Elena Garcia']] },
      { table: { head: ['When', 'What', 'Details'], rows: [['Wed 07:40', 'Train out', 'Coach C, seat 42. E-ticket in email.'], ['Wed 10:30', 'Workshop at the practice', 'Ask for Dr. Moss at reception.'], ['Wed 18:30', 'Hotel check-in', 'Quayside Hotel, 1 night, breakfast included'], ['Thu 09:00', 'Patient interviews', 'Five 20-minute sessions'], ['Thu 15:10', 'Train back', 'Coach B, seat 17']] } },
      { h: 'Remember' },
      { ul: ['Bring the consent forms for patient interviews.', 'Keep receipts for meals. The limit is $60 a day.'] },
    ]],
  },
  'intake-form': {
    title: 'Patient intake form', kicker: 'Northfield Clinic', sub: 'Signed copy returned for the forms review.', ref: 'Form NC-INT-01', footer: 'Northfield Clinic · Returned through Acme Co. link', c1: C.teal, c2: C.navy,
    pages: [[
      { table: { head: ['Field', 'Answer'], rows: [['Full name', 'Sample Patient'], ['Date of birth', '01 / 01 / 1980'], ['Phone', '555 0100'], ['Email', 'patient@example.com'], ['Emergency contact', 'Sample Contact, 555 0101'], ['Allergies', 'None known'], ['Current medication', 'None'], ['Reason for visit', 'Annual check-up']] } },
      { callout: 'This is a sample form with made-up details, returned for the online forms design review.' },
      { sign: [['Sample Patient', 'Signature'], ['Dana Whitfield', 'Checked by, Northfield Clinic']] },
    ]],
  },
};
function invoice(no, client, attn, lines, total) {
  return {
    title: `Invoice ${no}`, kicker: 'Finance', sub: `${client}`, ref: `Invoice ${no}`, footer: 'Acme Co. · Pay within 30 days', c1: C.navy, c2: C.teal,
    pages: [[
      { meta: [['Bill to', client], ['Attention', attn], ['Date', '25 September 2026']] },
      { table: { head: ['Description', 'Qty', 'Amount ($)'], num: [1, 2], rows: lines } },
      { table: { head: ['', 'Amount ($)'], num: [1], total: true, rows: [['Subtotal', total], ['Tax (0%)', '0.00'], ['Total due', total]] } },
      { h: 'How to pay' },
      { p: 'Bank transfer to Acme Co., account details on file. Please quote the invoice number. Payment is due within 30 days.' },
      { p: 'Questions about this invoice? Contact Marcus Chen, Finance.' },
    ]],
  };
}
function planSvg() {
  const room = (x, y, w, h, label, fill = '#EAF4F2') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${C.ink}" stroke-width="3"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-size="15" font-weight="700" fill="${C.ink}">${label}</text>`;
  return `<svg width="672" height="440" viewBox="0 0 672 440" font-family="Helvetica Neue, Arial" style="margin:6px 0 18px"><rect x="0" y="0" width="672" height="440" fill="#fbfcfd"/>`
    + room(20, 20, 250, 170, 'Reception') + room(270, 20, 382, 170, 'Waiting room', '#FFF4E6')
    + room(20, 190, 150, 120, 'Consult 1') + room(170, 190, 150, 120, 'Consult 2') + room(320, 190, 150, 120, 'Consult 3') + room(470, 190, 182, 120, 'Staff room', '#F1ECF6')
    + room(20, 310, 632, 110, 'Corridor', '#fff')
    + `<rect x="60" y="120" width="140" height="26" rx="4" fill="${C.teal}" opacity=".85"/><text x="130" y="138" text-anchor="middle" font-size="11" fill="#fff">new desk</text>`
    + [0, 1, 2, 3, 4, 5].map(i => `<rect x="${300 + i * 55}" y="140" width="40" height="28" rx="6" fill="${C.coral}" opacity=".75"/>`).join('')
    + `<path d="M 336 420 v -14 h 40 v 14" fill="none" stroke="${C.coral}" stroke-width="4"/><text x="356" y="400" text-anchor="middle" font-size="11" fill="${C.coral}">entrance</text>`
    + `<text x="652" y="36" text-anchor="end" font-size="12" fill="#6b7785">N ↑</text></svg>`;
}

// ───────────────────────── Word documents (.docx) ─────────────────────────
const DOCX = {
  'northfield-proposal': {
    title: 'Proposal: Clinic scheduling and records upgrade', sub: 'Prepared for Northfield Clinic by Jordan Lee, Acme Co.',
    blocks: [
      { h: 'Summary' },
      { p: 'Northfield Clinic has grown to three doctors and eleven staff, but patients still fill in paper forms and book by phone. This proposal sets out a four-month project to move intake forms online, connect booking to your scheduling system, and make ten years of scanned records searchable.' },
      { h: 'What we will deliver' },
      { ul: ['Secure online intake forms that patients complete before they arrive', 'Online booking connected to your existing scheduling system', 'A searchable archive of scanned records', 'Training for reception and clinical staff, and a month of support'] },
      { h: 'Timeline' },
      { table: { head: ['Phase', 'Weeks', 'Outcome'], rows: [['Discover', '1 to 2', 'Current process mapped with the reception team'], ['Forms', '3 to 6', 'Online forms live for new patients'], ['Booking', '7 to 11', 'Booking connected and tested'], ['Archive and training', '12 to 16', 'Records searchable, staff trained']] } },
      { h: 'Investment' },
      { table: { head: ['Milestone', 'Amount'], rows: [['Signed agreement', '$12,000'], ['Online forms live', '$16,000'], ['Booking connected', '$14,000'], ['Archive and training', '$10,000'], ['Total', '$52,000']] } },
      { h: 'Next steps' },
      { ul: ['Dana Whitfield reviews this proposal with the partners.', 'Acme sends the service agreement for signature.', 'Kick-off at the clinic on 6 October.'] },
    ],
  },
  'maple-proposal': {
    title: 'Proposal: Online ordering', sub: 'Prepared for Maple Street Bakery by Jordan Lee, Acme Co.',
    blocks: [
      { h: 'Summary' }, { p: 'Customers ask every day whether they can order ahead. A simple online ordering page for collection would cut queues at peak times and bring in larger orders for events.' },
      { h: 'Scope' }, { ul: ['Ordering page that matches the new brand', 'Daily cut-off time and collection slots', 'Order emails to the bakery and the customer', 'Card payments'] },
      { h: 'Price' }, { table: { head: ['Item', 'Amount'], rows: [['Design', '$2,500'], ['Build and testing', '$5,000'], ['Total', '$7,500']] } },
    ],
  },
  'proposal-template': {
    title: 'Proposal template', sub: 'Copy this file into the client\'s folder, then replace everything in square brackets.',
    blocks: [
      { h: 'Summary' }, { p: '[Two or three sentences: the client\'s problem, what we recommend, and the result they can expect.]' },
      { h: 'What we will deliver' }, { ul: ['[Deliverable one]', '[Deliverable two]', '[Deliverable three]'] },
      { h: 'Timeline' }, { table: { head: ['Phase', 'Weeks', 'Outcome'], rows: [['[Discover]', '[1 to 2]', '[Outcome]'], ['[Design]', '[3 to 5]', '[Outcome]'], ['[Build]', '[6 to 10]', '[Outcome]']] } },
      { h: 'Investment' }, { table: { head: ['Item', 'Amount'], rows: [['[Item]', '[$0]'], ['Total', '[$0]']] } },
    ],
  },
  'monthly-report-sep': {
    title: 'Monthly report: September 2026', sub: 'Draft. Client services. Numbers to be confirmed by Finance.',
    blocks: [
      { h: 'Headlines' }, { ul: ['Northfield Clinic agreement signed; kick-off booked for 6 October.', 'Maple Street Bakery menu concepts sent for review.', 'Harbor Point Dental proposal sent on 17 September.'] },
      { h: 'Hours by client' }, { table: { head: ['Client', 'Hours', 'Change on August'], rows: [['Northfield Clinic', '201', '+17'], ['Harbor Point Dental', '118', '-24'], ['Maple Street Bakery', '131', '+13'], ['Riverside Library', '64', '-32'], ['Other', '80', '+8']] } },
      { h: 'For October' }, { ul: ['Start the Northfield forms build.', 'Autumn campaign with Marketing.', 'Plan the office move with Operations.'] },
    ],
  },
  'kickoff-agenda': {
    title: 'Kick-off meeting agenda', sub: 'Northfield Clinic · Tuesday 6 October, 10:00 to 12:00 · Clinic meeting room',
    blocks: [
      { table: { head: ['Time', 'Topic', 'Lead'], rows: [['10:00', 'Introductions and goals', 'Dana Whitfield'], ['10:20', 'How reception works today', 'Reception team'], ['10:50', 'Online forms: first ideas', 'Jordan Lee'], ['11:20', 'Records archive: what to move', 'Sam Okafor'], ['11:45', 'Next steps and dates', 'Jordan Lee']] } },
      { h: 'Please bring' }, { ul: ['A copy of each paper form you use today', 'A list of the busiest days and times', 'Any questions from staff who cannot attend'] },
    ],
  },
  'requirements': {
    title: 'Harbor Point Dental: requirements', sub: 'Notes from the discovery call with the practice manager.',
    blocks: [
      { h: 'Must have' }, { ul: ['Patients can book, move and cancel appointments online', 'Reminders by text two days and two hours before', 'Works well on older phones'] },
      { h: 'Nice to have' }, { ul: ['Waiting list for cancelled slots', 'Family bookings under one login'] },
      { h: 'Open questions' }, { ul: ['Which card provider does the practice use today?', 'Who approves reminder wording?'] },
    ],
  },
  'campaign-brief': {
    title: 'Autumn 2026 campaign brief', sub: 'Marketing · Owner: Priya Shah',
    blocks: [
      { h: 'Goal' }, { p: 'Win three new clients in healthcare and hospitality before the end of the year, by showing the results we delivered for Northfield Clinic and Maple Street Bakery.' },
      { h: 'Audience' }, { ul: ['Practice managers at small clinics', 'Owners of independent cafes and bakeries'] },
      { h: 'Channels and dates' }, { table: { head: ['Channel', 'Start', 'Owner'], rows: [['Case study on the website', '5 Oct', 'Priya Shah'], ['Email newsletter', '12 Oct', 'Jordan Lee'], ['Social posts, two a week', '5 Oct', 'Priya Shah'], ['Local business breakfast', '22 Oct', 'Elena Garcia']] } },
    ],
  },
  'newsletter-oct': {
    title: 'Newsletter: October', sub: 'Draft by Jordan Lee for the Acme Co. client newsletter.',
    blocks: [
      { h: 'A calmer front desk at Northfield Clinic' }, { p: 'This month we start moving Northfield Clinic\'s paper forms online. Patients will fill them in at home, and reception will spend less time typing.' },
      { h: 'New menu, same favourites' }, { p: 'Maple Street Bakery has a fresh look. Pop in and try the maple pecan scone.' },
      { h: 'We are moving' }, { p: 'From 16 November you will find us at our new studio on Harbor Road.' },
    ],
  },
  'it-setup-checklist': {
    title: 'IT setup checklist', sub: 'For new starters. Sam Okafor will go through this with you on day one.',
    blocks: [
      { ul: ['Laptop handed over and signed for', 'Password manager set up', 'Email and calendar working on laptop and phone', 'Signed in to Depot, profile photo added', 'Added to the right Depot groups', 'Printer and Wi-Fi tested', 'Two-step sign-in turned on'] },
      { h: 'Need help?' }, { p: 'Message Sam Okafor, or stop by the IT desk next to the kitchen.' },
    ],
  },
};

// ───────────────────────── spreadsheets (.xlsx / .csv) ─────────────────────────
const SHEETS = {
  'q3-budget': { sheets: [{ name: 'Q3 budget', cols: [26, 12, 12, 12, 12, 12, 12], rows: [
    ['Category', 'July', 'August', 'September', 'Q3 total', 'Budget', 'Variance'],
    ['Contractors', 8200, 9400, 8800, 26400, 27000, -600], ['Software', 1150, 1150, 1320, 3620, 3300, 320], ['Travel', 640, 1210, 890, 2740, 3000, -260],
    ['Client events', 0, 1800, 450, 2250, 2500, -250], ['Training', 400, 0, 950, 1350, 1500, -150], ['Hardware', 0, 2300, 0, 2300, 2000, 300], ['Printing', 120, 90, 310, 520, 600, -80],
    ['Total', 10510, 15950, 12720, 39180, 39900, -720]] }, { name: 'Notes', cols: [60], rows: [['Notes'], ['September includes the new design tool subscription.'], ['Hardware: two replacement laptops in August.'], ['Figures confirmed with Marcus Chen on 26 September.']] }] },
  'fy2026-budget': { sheets: [{ name: 'Summary', cols: [24, 12, 12, 12, 12, 13], rows: [
    ['Department', 'Q1', 'Q2', 'Q3', 'Q4', 'Year'], ['Client services', 118000, 124000, 131000, 135000, 508000], ['Marketing', 24000, 26000, 31000, 29000, 110000], ['Operations', 41000, 40000, 43000, 62000, 186000],
    ['Finance', 18000, 18000, 19000, 19000, 74000], ['IT', 22000, 21000, 24000, 23000, 90000], ['Total', 223000, 229000, 248000, 268000, 968000]] }, { name: 'Headcount', cols: [24, 10, 10], rows: [['Team', 'Now', 'Planned'], ['Client services', 6, 7], ['Marketing', 2, 2], ['Operations', 2, 2], ['Finance', 1, 1], ['IT', 1, 2]] }] },
  'social-calendar': { sheets: [{ name: 'October', cols: [12, 12, 44, 14, 12], rows: [
    ['Date', 'Channel', 'Post', 'Owner', 'Status'], ['5 Oct', 'LinkedIn', 'Case study: Northfield Clinic online forms', 'Priya Shah', 'Scheduled'], ['7 Oct', 'Instagram', 'Behind the scenes at Maple Street Bakery', 'Priya Shah', 'Drafted'],
    ['12 Oct', 'Email', 'October newsletter', 'Jordan Lee', 'In review'], ['14 Oct', 'LinkedIn', 'Five questions to ask before a website project', 'Priya Shah', 'Idea'], ['19 Oct', 'Instagram', 'Autumn at Acme: the team', 'Elena Garcia', 'Idea'],
    ['22 Oct', 'Event', 'Local business breakfast', 'Elena Garcia', 'Booked'], ['26 Oct', 'LinkedIn', 'We are moving to Harbor Road', 'Priya Shah', 'Idea']] }] },
  'project-schedule': { sheets: [{ name: 'Schedule', cols: [34, 14, 10, 10, 12], rows: [
    ['Task', 'Owner', 'Start', 'End', 'Status'], ['Kick-off at the clinic', 'Jordan Lee', '6 Oct', '6 Oct', 'Booked'], ['Map current intake process', 'Jordan Lee', '6 Oct', '16 Oct', 'Not started'], ['Design online forms', 'Priya Shah', '19 Oct', '30 Oct', 'Not started'],
    ['Build and test forms', 'Sam Okafor', '2 Nov', '13 Nov', 'Not started'], ['Connect booking system', 'Sam Okafor', '16 Nov', '11 Dec', 'Not started'], ['Scan and index records', 'Sam Okafor', '4 Jan', '22 Jan', 'Not started'], ['Staff training', 'Jordan Lee', '25 Jan', '29 Jan', 'Not started']] }] },
  'survey': { sheets: [{ name: 'Responses', cols: [22, 8, 56], rows: [
    ['Client', 'Score', 'Comment'], ['Northfield Clinic', 5, 'Explained every step. Never left us guessing.'], ['Maple Street Bakery', 5, 'Customers noticed the new menu on day one.'], ['Riverside Library', 4, 'Great result, launch week was busy.'],
    ['Harbor Point Dental', 4, 'Quick to reply and easy to talk to.'], ['Quayside Hotel', 5, 'Loved the booking page.'], ['Average', 4.6, '']] }] },
  'expenses-september': { csv: true, rows: [['Date', 'Description', 'Category', 'Amount'], ['2026-09-02', 'Train to Northfield Clinic', 'Travel', '42.50'], ['2026-09-02', 'Lunch with Dana Whitfield', 'Client meal', '38.20'], ['2026-09-09', 'Printer paper and toner', 'Office', '64.99'], ['2026-09-15', 'Design tool subscription', 'Software', '29.00'], ['2026-09-17', 'Taxi to Harbor Point Dental', 'Travel', '18.40'], ['2026-09-24', 'Workshop sticky notes and pens', 'Office', '12.75']] },
};

// ───────────────────────── text files ─────────────────────────
const TEXTS = {
  'meeting-notes': { ext: 'md', body: `# Weekly team meeting

Monday 28 September · Jordan, Priya, Marcus, Elena, Sam

## Decisions
- Northfield Clinic kick-off stays on 6 October.
- Priya owns the autumn campaign; Jordan writes the newsletter.
- Office move date confirmed: Friday 13 November.

## Actions
- [ ] Jordan: send the Northfield proposal to Dana for sign-off
- [ ] Priya: upload the hero banner to Marketing / Campaigns
- [ ] Marcus: share the Q3 numbers before Friday
- [ ] Sam: book the internet install at the new office
- [x] Elena: order boxes for the move

## Next meeting
Monday 5 October, 9:30, Summit room.
` },
  'wifi-setup': { ext: 'txt', body: `Wi-Fi and printer setup
=======================

Wi-Fi
  Network:   Acme-Staff
  Password:  ask Sam Okafor (changed every quarter)
  Guests:    Acme-Guest, code on the kitchen board

Printers
  Studio printer (colour)   near the window
  Office printer (mono)     next to Operations
  Both appear automatically on your laptop.
  If not: Settings > Printers > Add > "Acme Studio".

Problems?
  Message Sam Okafor or visit the IT desk.
` },
};

// ───────────────────────── pictures ─────────────────────────
const people = (xs, baseY, scale = 1) => xs.map(([x, shirt, hair], i) => {
  const s = scale * (0.92 + (i % 3) * 0.05);
  return `<g transform="translate(${x} ${baseY}) scale(${s})"><rect x="-17" y="-64" width="34" height="62" rx="14" fill="${shirt}"/><rect x="-14" y="-6" width="11" height="40" rx="5" fill="#2d3440"/><rect x="3" y="-6" width="11" height="40" rx="5" fill="#2d3440"/><circle cx="0" cy="-80" r="15" fill="#e9b996"/><path d="M-15 -84 a15 15 0 0 1 30 0 v-2 a15 13 0 0 0 -30 0z" fill="${hair}"/></g>`;
}).join('');
const IMAGES = {
  'offsite': { ext: 'jpg', w: 1600, h: 1067, svg: `
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8DB6D9"/><stop offset=".55" stop-color="#F6D3A5"/><stop offset="1" stop-color="#F3A774"/></linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9A57E"/><stop offset=".25" stop-color="#7AA3C4"/><stop offset="1" stop-color="#3E6A8E"/></linearGradient>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFF6DA"/><stop offset=".6" stop-color="#FFE0A0"/><stop offset="1" stop-color="#FFE0A0" stop-opacity="0"/></radialGradient></defs>
    <rect width="1600" height="1067" fill="url(#sky)"/><circle cx="1060" cy="560" r="170" fill="url(#sun)"/><circle cx="1060" cy="560" r="62" fill="#FFF2CF"/>
    <path d="M0 610 L180 420 L320 540 L520 330 L720 560 L880 450 L1060 600 L1260 380 L1450 520 L1600 440 L1600 660 L0 660Z" fill="#7B7FA8" opacity=".75"/>
    <path d="M0 640 L240 500 L420 600 L610 470 L800 620 L1000 520 L1230 630 L1420 540 L1600 610 L1600 690 L0 690Z" fill="#5E6790"/>
    <rect y="660" width="1600" height="407" fill="url(#lake)"/>
    <ellipse cx="1060" cy="700" rx="60" ry="8" fill="#FFF2CF" opacity=".7"/><ellipse cx="1060" cy="730" rx="42" ry="5" fill="#FFF2CF" opacity=".5"/><ellipse cx="1060" cy="760" rx="28" ry="4" fill="#FFF2CF" opacity=".35"/>
    ${[40, 120, 190, 1380, 1450, 1530].map((x, i) => `<path d="M${x} ${700 - (i % 2) * 20} l-46 0 l46 -150 l46 150z" fill="#2F4A3F"/><path d="M${x} ${650 - (i % 2) * 20} l-38 0 l38 -120 l38 120z" fill="#35574A"/><rect x="${x - 6}" y="${700 - (i % 2) * 20}" width="12" height="26" fill="#3a2d25"/>`).join('')}
    <path d="M430 1067 L560 820 L1040 820 L1170 1067Z" fill="#9C7552"/><path d="M430 1067 L560 820 L1040 820 L1170 1067Z" fill="none" stroke="#7d5c40" stroke-width="3"/>
    ${[860, 900, 945, 995, 1050].map(y => `<line x1="${560 - (y - 820) * 0.53}" x2="${1040 + (y - 820) * 0.53}" y1="${y}" y2="${y}" stroke="#7d5c40" stroke-width="3"/>`).join('')}
    ${people([[610, C.coral, '#3b2a20'], [680, C.navy, '#1c1c1c'], [745, C.teal, '#6b4a2e'], [810, C.gold, '#2a2a2a'], [870, '#FFFFFF', '#8a5a3a'], [935, C.plum, '#1f1f1f'], [1000, C.sky, '#4b3528']], 860, 1.6)}` },
  'new-office': { ext: 'jpg', w: 1600, h: 1067, svg: officeSvg({ wall: '#EFE8DE', floor: '#C9A983', accent: C.navy, sign: 'Acme Co.' }) },
  'reception': { ext: 'jpg', w: 1600, h: 1067, svg: officeSvg({ wall: '#E6F1EF', floor: '#BFC7CC', accent: C.teal, sign: 'Northfield Clinic', desk: true }) },
  'waiting-room': { ext: 'jpg', w: 1600, h: 1067, svg: officeSvg({ wall: '#F4EEE3', floor: '#B8A58C', accent: C.coral, sign: 'Waiting room', chairs: true }) },
  'whiteboard': { ext: 'png', w: 1400, h: 933, svg: `
    <rect width="1400" height="933" fill="#C9CED3"/><rect x="60" y="50" width="1280" height="820" rx="10" fill="#FBFBF8" stroke="#9aa3ab" stroke-width="10"/>
    <g font-family="Marker Felt, Chalkboard SE, Comic Sans MS, cursive" fill="none" stroke-linecap="round">
    <text x="140" y="150" font-size="54" fill="${C.navy}" stroke="none">Northfield: new patient journey</text>
    ${[['Book online', 150, C.teal], ['Forms at home', 450, C.coral], ['Check in', 750, C.navy], ['See doctor', 1030, C.plum]].map(([t, x, c]) => `<rect x="${x}" y="260" width="230" height="120" rx="18" stroke="${c}" stroke-width="6"/><text x="${x + 115}" y="332" font-size="34" fill="${c}" stroke="none" text-anchor="middle">${t}</text>`).join('')}
    ${[380, 680, 980].map(x => `<path d="M${x + 6} 320 L${x + 64} 320 M${x + 46} 302 L${x + 66} 320 L${x + 46} 338" stroke="#333" stroke-width="5"/>`).join('')}
    <path d="M560 400 C 560 480, 700 470, 720 520" stroke="${C.coral}" stroke-width="4" stroke-dasharray="10 10"/>
    <text x="740" y="550" font-size="30" fill="${C.coral}" stroke="none">saves ~6 min per patient!</text>
    <text x="150" y="480" font-size="30" fill="#333" stroke="none">Questions:</text>
    <text x="150" y="530" font-size="28" fill="#333" stroke="none">- who checks forms?</text><text x="150" y="575" font-size="28" fill="#333" stroke="none">- paper option for older patients</text></g>
    ${[[980, 620, '#FFE680', 'Ask Dana re: timeline'], [1150, 660, '#FFB3C7', 'Pilot with 1 doctor'], [1000, 740, '#A8D8FF', 'Sam: archive size?']].map(([x, y, c, t], i) => `<g transform="rotate(${[-4, 3, -2][i]} ${x} ${y})"><rect x="${x}" y="${y}" width="170" height="130" fill="${c}"/><text x="${x + 14}" y="${y + 48}" font-family="Marker Felt, Chalkboard SE, cursive" font-size="22" fill="#333">${t.split(' ').slice(0, 2).join(' ')}</text><text x="${x + 14}" y="${y + 80}" font-family="Marker Felt, Chalkboard SE, cursive" font-size="22" fill="#333">${t.split(' ').slice(2).join(' ')}</text></g>`).join('')}
    <rect x="600" y="880" width="200" height="16" rx="6" fill="#8b949c"/>` },
  'acme-logo': { ext: 'png', w: 1200, h: 800, svg: `<rect width="1200" height="800" fill="#ffffff"/><g transform="translate(250 290)">${MARK(220).replace('<svg ', '<svg x="0" y="0" ')}</g><text x="500" y="440" font-family="Inter" font-weight="800" font-size="120" letter-spacing="-4" fill="${C.ink}">Acme Co.</text><text x="505" y="500" font-family="Inter" font-size="30" fill="#6b7785">Practical design and technology</text>` },
  'color-palette': { ext: 'png', w: 1400, h: 800, pos: 'left', svg: `<rect width="1400" height="800" fill="#ffffff"/><text x="80" y="110" font-family="Inter" font-weight="800" font-size="52" fill="${C.ink}">Acme colour palette</text>
    ${[['Harbor navy', C.navy, '#fff'], ['Coral', C.coral, '#fff'], ['Teal', C.teal, '#fff'], ['Sand', C.sand, C.ink], ['Gold', C.gold, C.ink]].map(([n, c, ink], i) => `<rect x="${80 + i * 252}" y="170" width="228" height="440" rx="22" fill="${c}" stroke="#e1e7ed"/><text x="${104 + i * 252}" y="560" font-family="Inter" font-weight="700" font-size="30" fill="${ink}">${n}</text><text x="${104 + i * 252}" y="596" font-family="Inter" font-size="24" fill="${ink}" opacity=".8">${c.toUpperCase()}</text>`).join('')}
    <text x="80" y="700" font-family="Inter" font-size="26" fill="#6b7785">Navy and white for most layouts. Coral for the one thing people should notice.</text>` },
  'hero-banner': { ext: 'jpg', w: 1800, h: 800, pos: '8% 50%', svg: `
    <defs><linearGradient id="au" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2B4C75"/><stop offset="1" stop-color="${C.navy}"/></linearGradient></defs>
    <rect width="1800" height="800" fill="url(#au)"/>
    ${Array.from({ length: 34 }, (_, i) => { const x = 980 + ((i * 197) % 820), y = 40 + ((i * 131) % 720), r = (i * 37) % 360, c = [C.coral, C.gold, '#C8553D', '#F2A541', '#9E3B2B'][i % 5], s = 0.7 + (i % 4) * 0.25; return `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><path d="M0 -40 C 26 -26, 26 22, 0 40 C -26 22, -26 -26, 0 -40Z" fill="${c}" opacity=".92"/><line x1="0" y1="-36" x2="0" y2="38" stroke="#6b2c1e" stroke-width="2" opacity=".5"/></g>`; }).join('')}
    <text x="110" y="330" font-family="Inter" font-weight="800" font-size="110" fill="#fff" letter-spacing="-3">Autumn at Acme</text>
    <text x="114" y="410" font-family="Inter" font-size="42" fill="#DCE6F2">New services for growing teams</text>
    <rect x="114" y="480" width="330" height="84" rx="42" fill="${C.coral}"/><text x="279" y="534" font-family="Inter" font-weight="700" font-size="32" fill="#fff" text-anchor="middle">Book a call</text>` },
  'logo-concepts': { ext: 'png', w: 1500, h: 900, pos: 'left', svg: `<rect width="1500" height="900" fill="#FBF6EE"/><text x="80" y="110" font-family="Georgia, serif" font-weight="700" font-size="52" fill="#3B2A1C">Maple Street Bakery · logo concepts</text>
    ${[0, 1, 2].map(i => { const x = 80 + i * 460; const inner = [
      `<circle cx="${x + 190}" cy="360" r="120" fill="#8A5A2B"/><path d="M${x + 190} 270 C ${x + 250} 320, ${x + 250} 400, ${x + 190} 450 C ${x + 130} 400, ${x + 130} 320, ${x + 190} 270Z" fill="${C.gold}"/><line x1="${x + 190}" y1="280" x2="${x + 190}" y2="445" stroke="#8A5A2B" stroke-width="6"/>`,
      `<rect x="${x + 80}" y="250" width="220" height="220" rx="30" fill="#3B2A1C"/><text x="${x + 190}" y="390" font-family="Georgia, serif" font-size="110" font-weight="700" fill="#F7EBDD" text-anchor="middle">M</text><circle cx="${x + 265}" cy="290" r="14" fill="${C.coral}"/>`,
      `<path d="M${x + 90} 440 Q ${x + 190} 200, ${x + 290} 440Z" fill="${C.coral}"/>${[0, 1, 2, 3].map(k => `<ellipse cx="${x + 150 + k * 28}" cy="${330 + (k % 2) * 20}" rx="10" ry="22" fill="#FBF6EE" transform="rotate(${-20 + k * 13} ${x + 150 + k * 28} ${330 + (k % 2) * 20})"/>`).join('')}`][i];
      return `<rect x="${x}" y="170" width="380" height="580" rx="24" fill="#ffffff" stroke="#EADBC6" stroke-width="3"/>${inner}<text x="${x + 190}" y="560" font-family="Georgia, serif" font-size="40" font-weight="700" fill="#3B2A1C" text-anchor="middle">Maple Street</text><text x="${x + 190}" y="610" font-family="Inter" font-size="24" fill="#8a7663" text-anchor="middle">Concept ${'ABC'[i]}</text>`; }).join('')}` },
  'office-map': { ext: 'png', w: 1400, h: 900, pos: 'left', svg: `<rect width="1400" height="900" fill="#ffffff"/><text x="70" y="90" font-family="Inter" font-weight="800" font-size="46" fill="${C.ink}">Office map · Harbor Road studio</text>
    ${[[70, 140, 520, 330, 'Studio · desks 1 to 12', '#EEF3F9'], [590, 140, 360, 330, 'Kitchen', '#FFF4E6'], [950, 140, 380, 160, 'Summit room', '#F1ECF6'], [950, 300, 380, 170, 'Harbor room', '#EAF4F2'], [70, 470, 400, 330, 'Reception', '#F5F7F9'], [470, 470, 480, 330, 'Quiet room and phone booths', '#EEF3F9'], [950, 470, 380, 330, 'IT desk and storage', '#FDF2EE']].map(([x, y, w, h, t, f]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}" stroke="${C.ink}" stroke-width="4"/><text x="${x + w / 2}" y="${y + h / 2 + 10}" font-family="Inter" font-weight="600" font-size="28" fill="${C.ink}" text-anchor="middle">${t}</text>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${100 + (i % 6) * 80}" y="${190 + Math.floor(i / 6) * 190}" width="56" height="36" rx="6" fill="${C.sky}" opacity=".55"/>`).join('')}
    <circle cx="270" cy="760" r="16" fill="${C.coral}"/><text x="296" y="770" font-family="Inter" font-size="24" fill="${C.coral}">You start here</text>` },
};
function officeSvg({ wall, floor, accent, sign, desk = false, chairs = false }) {
  return `<defs><linearGradient id="win" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#BFD9EE"/><stop offset="1" stop-color="#E8F1F8"/></linearGradient></defs>
    <rect width="1600" height="1067" fill="${wall}"/><rect y="760" width="1600" height="307" fill="${floor}"/>
    ${Array.from({ length: 9 }, (_, i) => `<line x1="${i * 200}" y1="760" x2="${i * 260 - 240}" y2="1067" stroke="#000" stroke-opacity=".06" stroke-width="3"/>`).join('')}
    <rect x="880" y="130" width="620" height="480" fill="url(#win)" stroke="#fff" stroke-width="16"/><line x1="1190" y1="130" x2="1190" y2="610" stroke="#fff" stroke-width="12"/><line x1="880" y1="370" x2="1500" y2="370" stroke="#fff" stroke-width="12"/>
    ${[[930, 470, 60, 140], [1010, 420, 70, 190], [1100, 500, 50, 110], [1240, 440, 80, 170], [1340, 480, 60, 130], [1420, 430, 60, 180]].map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#9FB6C8" opacity=".6"/>`).join('')}
    <text x="120" y="250" font-family="Inter" font-weight="800" font-size="84" fill="${accent}" letter-spacing="-2">${sign}</text>
    <rect x="120" y="280" width="260" height="10" rx="5" fill="${accent}" opacity=".6"/>
    ${[260, 700].map(x => `<line x1="${x}" y1="0" x2="${x}" y2="90" stroke="#555" stroke-width="3"/><path d="M${x - 50} 150 Q ${x} 70 ${x + 50} 150Z" fill="${accent}"/><ellipse cx="${x}" cy="152" rx="30" ry="8" fill="#FFF6D8"/>`).join('')}
    ${desk ? `<rect x="180" y="600" width="620" height="210" rx="18" fill="#F8F8F6" stroke="#cfd6dc" stroke-width="4"/><rect x="180" y="600" width="620" height="36" rx="12" fill="${accent}"/><rect x="560" y="530" width="120" height="76" rx="6" fill="#2d3440"/><rect x="605" y="606" width="30" height="6" fill="#2d3440"/>`
      : chairs ? [0, 1, 2, 3, 4].map(i => `<rect x="${140 + i * 150}" y="640" width="120" height="120" rx="20" fill="${[C.teal, C.coral, C.gold, C.navy, C.teal][i]}"/><rect x="${150 + i * 150}" y="760" width="12" height="60" fill="#555"/><rect x="${238 + i * 150}" y="760" width="12" height="60" fill="#555"/>`).join('') + `<rect x="160" y="850" width="560" height="26" rx="13" fill="#000" opacity=".08"/>`
      : `<rect x="120" y="640" width="720" height="26" rx="6" fill="#8A6A4C"/><rect x="150" y="666" width="16" height="170" fill="#6d5139"/><rect x="794" y="666" width="16" height="170" fill="#6d5139"/>${[190, 450].map(x => `<rect x="${x}" y="540" width="170" height="100" rx="8" fill="#2d3440"/><rect x="${x + 75}" y="640" width="20" height="4" fill="#2d3440"/>`).join('')}${[200, 460, 700].map(x => `<rect x="${x}" y="700" width="110" height="120" rx="24" fill="${accent}" opacity=".85"/>`).join('')}`}
    ${[[80, 740, 1.3], [1450, 780, 1.6], [860, 700, 1.0]].map(([x, y, s]) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-40 0 h80 l-10 70 h-60z" fill="#B5654A"/>${[-30, -12, 8, 26, 0].map((dx, k) => `<ellipse cx="${dx}" cy="${-40 - (k % 3) * 22}" rx="16" ry="44" fill="${['#3E8E5E', '#4FA36E', '#2F7A4F'][k % 3]}" transform="rotate(${dx} ${dx} ${-40 - (k % 3) * 22})"/>`).join('')}</g>`).join('')}`;
}

// Slides (pptx thumbnails only: the demo never previews a .pptx inline).
const SLIDES = {
  'product-launch': `<div style="width:1066px;height:600px;background:${C.navy};color:#fff;font-family:Inter;position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center"><div style="position:absolute;left:-90px;top:-90px;width:300px;height:300px;border-radius:50%;background:${C.coral};opacity:.9"></div><div style="position:absolute;right:-60px;bottom:-110px;width:320px;height:320px;border-radius:50%;background:${C.teal};opacity:.8"></div>${MARK(90, '#2B4C75')}<div style="font-size:22px;letter-spacing:.12em;text-transform:uppercase;color:${C.gold};margin-top:26px">Marketing · Autumn 2026</div><div style="font-size:74px;font-weight:800;letter-spacing:-.03em;margin-top:12px;line-height:1.02">Product launch<br>plan</div></div>`,
  'q3-review': `<div style="width:1066px;height:600px;background:#fff;color:${C.ink};font-family:Inter;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center"><div style="display:flex;align-items:center;gap:12px;font-weight:700;font-size:24px">${MARK(44)}Acme Co.</div><div style="font-size:84px;font-weight:800;letter-spacing:-.03em;margin-top:18px">Q3 review</div><div style="font-size:26px;color:#4a5663;margin-top:6px">Client services · July to September</div><div style="display:flex;gap:22px;margin-top:40px;align-items:flex-end;height:150px">${[80, 110, 95, 135, 125, 150].map((h, i) => `<div style="width:56px;height:${h}px;border-radius:8px;background:${i === 5 ? C.coral : C.teal}"></div>`).join('')}</div></div>`,
};

// ───────────────────────── rendering ─────────────────────────
function serve(pages) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/font.woff2') { res.writeHead(200, { 'content-type': 'font/woff2' }); return res.end(FONT); }
      const html = pages.get(decodeURIComponent(req.url.slice(1)));
      if (html == null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}
async function shot(page, file, { format, quality, clip }) {
  const params = { format, captureBeyondViewport: false };
  if (quality) params.quality = quality;
  if (clip) params.clip = { scale: 1, ...clip };
  const r = await page.session.send('Page.captureScreenshot', params);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}
const THUMB = { format: 'webp', quality: 72 };
const T = (slug) => path.join(OUT, 'thumbs', slug + '.webp');
const F = (slug, ext) => path.join(OUT, 'files', `${slug}.${ext}`);
const shell = (body, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:Inter;src:url(/font.woff2) format('woff2');font-weight:100 900}html,body{margin:0;background:#fff;font-family:Inter,sans-serif}${css}</style></head><body>${body}</body></html>`;

// Word-page look for .docx thumbnails (what a LibreOffice render of page 1 looks like).
function wordHtml(d) {
  const b = d.blocks.map(x => x.h ? `<h2>${esc(x.h)}</h2>` : x.p ? `<p>${esc(x.p)}</p>` : x.ul ? `<ul>${x.ul.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : x.table ? `<table><tr>${x.table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${x.table.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : '').join('');
  return shell(`<div class="pg"><h1>${esc(d.title)}</h1><p class="s">${esc(d.sub)}</p>${b}</div>`,
    `.pg{width:816px;height:1056px;padding:80px 90px;box-sizing:border-box;font-family:'Helvetica Neue',Arial,sans-serif;color:#222}h1{font-size:30px;font-weight:600;color:${C.navy};margin:0 0 6px;letter-spacing:-.01em}.s{color:#666;font-size:14px;margin:0 0 20px;font-style:italic}h2{font-size:19px;color:${C.navy};margin:18px 0 6px;font-weight:600}p,li{font-size:14px;line-height:1.5;margin:0 0 8px}ul{padding-left:22px;margin:0 0 8px}table{border-collapse:collapse;width:100%;font-size:13px;margin:4px 0 10px}th{background:#E8EEF4;text-align:left}th,td{border:1px solid #bfc8d2;padding:5px 8px}`);
}
function gridHtml(rows, csv) {
  const fmt = (v) => typeof v === 'number' ? v.toLocaleString('en-US') : esc(v);
  return shell(`<div class="pg"><table>${rows.slice(0, 18).map((r, i) => `<tr>${r.map(c => `<${i ? 'td' : 'th'} class="${typeof c === 'number' ? 'n' : ''}">${fmt(c)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`,
    `.pg{width:816px;height:1056px;padding:56px 50px;box-sizing:border-box;font-family:'Helvetica Neue',Arial,sans-serif}table{border-collapse:collapse;font-size:15px}th,td{border:1px solid #c9d0d7;padding:6px 10px;white-space:nowrap;color:#222}th{background:${csv ? '#fff' : '#EEF2F6'};font-weight:${csv ? 400 : 700}}.n{text-align:right}`);
}
function textThumbSvg(body) {
  const rows = body.replace(/\r/g, '').split('\n').slice(0, 15).map(s => (s.length > 56 ? s.slice(0, 55) + '…' : s));
  const t = rows.map((ln, i) => `<text x="26" y="${44 + i * 20.5}" font-family="Menlo, Consolas, monospace" font-size="13" fill="#3a3f45" xml:space="preserve">${esc(ln)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#ffffff"/><rect width="480" height="7" fill="#e9ebef"/><rect x="20" y="20" width="120" height="9" rx="2" fill="#eef0f3"/>${t}</svg>`;
}

async function makeDocx(slug, d) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, HeadingLevel } = require('docx');
  const kids = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(d.title)] }),
    new Paragraph({ children: [new TextRun({ text: d.sub, italics: true, color: '666666' })], spacing: { after: 240 } }),
  ];
  for (const b of d.blocks) {
    if (b.h) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(b.h)] }));
    else if (b.p) kids.push(new Paragraph({ children: [new TextRun(b.p)], spacing: { after: 120 } }));
    else if (b.ul) b.ul.forEach(x => kids.push(new Paragraph({ text: x, bullet: { level: 0 } })));
    else if (b.table) {
      const cell = (t, head) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(t), bold: !!head })] })], ...(head ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EEF4' } } : {}) });
      kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: b.table.head.map(h => cell(h, true)) }), ...b.table.rows.map(r => new TableRow({ children: r.map(c => cell(c)) }))] }));
      kids.push(new Paragraph({ text: '' }));
    }
  }
  const doc = new Document({
    creator: 'Acme Co.', title: d.title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 44, color: '1F3A5F' }, paragraph: { spacing: { after: 80 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, color: '1F3A5F' }, paragraph: { spacing: { before: 240, after: 100 } } },
      ],
    },
    sections: [{ children: kids }],
  });
  fs.writeFileSync(F(slug, 'docx'), await Packer.toBuffer(doc));
}
function makeSheet(slug, s) {
  if (s.csv) { fs.writeFileSync(F(slug, 'csv'), s.rows.map(r => r.map(c => /[",]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n') + '\n'); return; }
  const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const wb = XLSX.utils.book_new();
  for (const sh of s.sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    ws['!cols'] = sh.cols.map(w => ({ wch: w }));
    for (const k of Object.keys(ws)) if (k[0] !== '!' && ws[k].t === 'n' && Math.abs(ws[k].v) >= 1000) ws[k].z = '#,##0';
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  }
  fs.writeFileSync(F(slug, 'xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'files'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
  const pages = new Map();
  for (const [slug, d] of Object.entries(PDFS)) pages.set('pdf/' + slug, docHtml({ ...d, name: PDF_NAMES[slug] }));
  for (const [slug, d] of Object.entries(DOCX)) pages.set('docx/' + slug, wordHtml(d));
  for (const [slug, s] of Object.entries(SHEETS)) pages.set('sheet/' + slug, gridHtml(s.csv ? s.rows : s.sheets[0].rows, s.csv));
  for (const [slug, im] of Object.entries(IMAGES)) pages.set('img/' + slug, shell(`<svg width="${im.w}" height="${im.h}" viewBox="0 0 ${im.w} ${im.h}" xmlns="http://www.w3.org/2000/svg" style="display:block">${im.svg}</svg>`));
  for (const [slug, im] of Object.entries(IMAGES)) pages.set('imgthumb/' + slug, shell(`<img src="/asset/${slug}.${im.ext}" style="display:block;width:480px;height:360px;object-fit:cover;object-position:${im.pos || 'center'}">`));
  for (const [slug, html] of Object.entries(SLIDES)) pages.set('slide/' + slug, shell(`<div style="width:480px;height:360px;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center"><div style="transform:scale(.6004);transform-origin:center">${html}</div></div>`));
  for (const [slug, t] of Object.entries(TEXTS)) pages.set('text/' + slug, shell(textThumbSvg(t.body)));
  const { srv, base } = await serve(pages);
  // images the thumbnail pages load back
  const origEmit = srv.listeners('request')[0];
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => {
    if (req.url.startsWith('/asset/')) { const f = path.join(OUT, 'files', req.url.slice(7)); if (fs.existsSync(f)) { res.writeHead(200); return res.end(fs.readFileSync(f)); } }
    origEmit(req, res);
  });

  const chrome = await launch();
  const page = await chrome.newPage();
  const go = async (key, w, h) => { await page.viewport(w, h, { scale: 1 }); await page.goto(base + key, { waitMs: 250 }); await page.eval(() => document.fonts.ready.then(() => true)); };
  const made = [];
  try {
    for (const slug of Object.keys(PDFS)) {
      if (!want(slug)) continue;
      await go('pdf/' + slug, 816, 1056);
      await page.pdf(F(slug, 'pdf'), { paperWidth: 8.5, paperHeight: 11, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
      await shot(page, T(slug), { ...THUMB, clip: { x: 0, y: 0, width: 816, height: 612, scale: 480 / 816 } });
      made.push(slug + '.pdf');
    }
    for (const [slug, d] of Object.entries(DOCX)) {
      if (!want(slug)) continue;
      await makeDocx(slug, d);
      await go('docx/' + slug, 816, 1056);
      await shot(page, T(slug), { ...THUMB, clip: { x: 0, y: 0, width: 816, height: 612, scale: 480 / 816 } });
      made.push(slug + '.docx');
    }
    for (const [slug, s] of Object.entries(SHEETS)) {
      if (!want(slug)) continue;
      makeSheet(slug, s);
      await go('sheet/' + slug, 816, 1056);
      await shot(page, T(slug), { ...THUMB, clip: { x: 0, y: 0, width: 816, height: 612, scale: 480 / 816 } });
      made.push(slug + (s.csv ? '.csv' : '.xlsx'));
    }
    for (const [slug, im] of Object.entries(IMAGES)) {
      if (!want(slug)) continue;
      await go('img/' + slug, im.w, im.h);
      await shot(page, F(slug, im.ext), im.ext === 'jpg' ? { format: 'jpeg', quality: 80 } : { format: 'png' });
      await go('imgthumb/' + slug, 480, 360);
      await sleep(150);
      await shot(page, T(slug), THUMB);
      made.push(`${slug}.${im.ext}`);
    }
    for (const slug of Object.keys(SLIDES)) {
      if (!want(slug)) continue;
      await go('slide/' + slug, 480, 360);
      await shot(page, T(slug), THUMB);
      made.push(slug + '.pptx (thumb)');
    }
    for (const [slug, t] of Object.entries(TEXTS)) {
      if (!want(slug)) continue;
      fs.writeFileSync(F(slug, t.ext), t.body);
      await go('text/' + slug, 480, 360);
      await shot(page, T(slug), THUMB);
      made.push(`${slug}.${t.ext}`);
    }
  } finally {
    await page.close(); await chrome.close(); srv.close();
  }
  let total = 0;
  for (const dir of ['files', 'thumbs']) for (const f of fs.readdirSync(path.join(OUT, dir))) total += fs.statSync(path.join(OUT, dir, f)).size;
  console.log(`made ${made.length}: ${made.join(', ')}`);
  console.log(`demo/assets total ${(total / 1024 / 1024).toFixed(2)} MB`);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { PDFS, DOCX, SHEETS, IMAGES, SLIDES, TEXTS };
