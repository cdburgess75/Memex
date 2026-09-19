// The first time a share's recipient opens it, its sharer is told -- in the app and by
// email -- and never again for that share. Later opens and downloads are recorded on the
// share (access_count, last_accessed_at) and at most noted in the app.
//
// Every function here is best-effort and never throws: telling the sharer must not be
// able to fail the open it is reporting.
const db = require('./db');
const notifications = require('./notifications');
const emailEvents = require('./emailEvents');

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const baseName = (n) => String(n || '').split('/').filter(Boolean).pop() || String(n || '');

async function tell({ toId = null, toEmail, title, body, subject, text, refType, refId, refPath = null }) {
  if (!toEmail) return;
  try {
    await notifications.create({ userId: toId, userEmail: toEmail, type: 'share_opened', title, body, refType, refId, refPath });
  } catch (e) { console.error('notification (share_opened) failed:', e.message); }
  emailEvents.send('share_opened', { to: toEmail, subject, text }).catch(() => {});
}

// Claims the "first open" of one row. True only for the caller that set it.
async function claim(table, id) {
  try {
    const rows = await db.query(`UPDATE ${table} SET opened_at = NOW() WHERE id = $1 AND opened_at IS NULL RETURNING id`, [id]);
    return rows.length > 0;
  } catch (e) { console.error(`share open (${table}) failed:`, e.message); return false; }
}

// A file link (public page, or a colleague's sign-in link). `opener` is the signed-in
// address when there is one. Returns whether this was the first open.
async function linkOpened(share, opener = null) {
  if (!share || !share.id || same(opener, share.created_by_email)) return false;
  if (!(await claim('document_share_links', share.id))) return false;
  const who = share.recipient_email || opener;
  const name = baseName(share.name);
  await tell({
    toId: share.created_by || null, toEmail: share.created_by_email,
    title: who ? `${who} opened your file` : 'Your shared file was opened',
    body: `"${name}" · via ${who ? 'their link' : 'a share link'}`,
    subject: who ? `${who} opened: ${name}` : `Your shared file was opened: ${name}`,
    text: `"${name}" was just opened via ${share.recipient_email ? `the link you sent to ${share.recipient_email}` : 'a share link you created'}.\n\nYou will not be emailed again about this link; later opens and downloads are listed under "Who has access" on the file.`,
    refType: 'document', refId: share.document_id,
  });
  return true;
}

async function folderLinkOpened(share) {
  if (!share || !share.id) return false;
  if (!(await claim('folder_share_links', share.id))) return false;
  const name = baseName(share.folder_path);
  await tell({
    toId: share.created_by || null, toEmail: share.created_by_email,
    title: 'Your shared folder was opened',
    body: `"${name}" · via a share link`,
    subject: `Your shared folder was opened: ${name}`,
    text: `The folder "${name}" was just opened via a share link you created.\n\nYou will not be emailed again about this link.`,
    refType: null, refId: null,
  });
  return true;
}

// A signed-in person opened a file. If somebody gave THEM that file -- the file itself, or
// the library or folder it sits in -- and they have not opened it before, tell whoever did.
// Shares with a group are not tracked: there is no one "recipient" to have opened them.
async function grantsOpened(user, doc) {
  const me = String(user?.email || '').toLowerCase();
  if (!me || !doc?.id) return;
  try {
    const acl = await db.query(
      `UPDATE document_acl SET opened_at = NOW()
        WHERE document_id = $1 AND lower(subject_email) = $2 AND opened_at IS NULL
          AND granted_by_email IS NOT NULL AND lower(granted_by_email) <> $2
        RETURNING granted_by, granted_by_email`, [doc.id, me]);
    for (const g of acl) {
      await tell({
        toId: g.granted_by || null, toEmail: g.granted_by_email,
        title: `${me} opened your file`, body: `"${baseName(doc.name)}" · you shared it with them`,
        subject: `${me} opened: ${baseName(doc.name)}`,
        text: `${me} just opened "${baseName(doc.name)}", which you shared with them in Depot.\n\nYou will not be emailed again about this share.`,
        refType: 'document', refId: doc.id,
      });
    }
    if (!doc.library_id) return;
    const places = await db.query(
      `UPDATE library_grants SET opened_at = NOW()
        WHERE library_id = $1 AND subject_type = 'user' AND lower(subject_email) = $2 AND opened_at IS NULL
          AND granted_by_email IS NOT NULL AND lower(granted_by_email) <> $2
          AND (folder_path = '' OR $3 = folder_path OR starts_with($3, folder_path || '/'))
        RETURNING granted_by, granted_by_email, folder_path`, [doc.library_id, me, String(doc.name || '')]);
    for (const g of places) {
      const what = g.folder_path ? `the folder "${baseName(g.folder_path)}"` : 'the library';
      await tell({
        toId: g.granted_by || null, toEmail: g.granted_by_email,
        title: `${me} opened ${g.folder_path ? 'your shared folder' : 'your shared library'}`,
        body: `${what} · first file opened: "${baseName(doc.name)}"`,
        subject: `${me} opened ${what}`,
        text: `${me} just opened a file in ${what}, which you shared with them in Depot: "${baseName(doc.name)}".\n\nYou will not be emailed again about this share.`,
        refType: 'library', refId: doc.library_id, refPath: g.folder_path || null,
      });
    }
  } catch (e) { console.error('share open (grants) failed:', e.message); }
}

module.exports = { linkOpened, folderLinkOpened, grantsOpened };
