'use strict';
// Plain words for each event type in the activity record, for the CSV download
// (routes/admin activity.csv). The admin feed in index.html keeps the same words in
// ACTIVITY_LABELS; a type missing here is shown with its underscores as spaces.
const LABELS = {
  uploaded: 'Uploaded', edited: 'Edited', renamed: 'Renamed', trashed: 'Moved to trash',
  restored: 'Restored', purged: 'Deleted permanently', updated: 'Updated',
  internal_link_sent: 'Sent a sign-in link', internal_folder_link_sent: 'Sent a folder sign-in link', external_folder_share_sent: 'Sent a folder link',
  share_created: 'Created share link', share_downloaded: 'Downloaded via link', share_revoked: 'Revoked share link',
  access_granted: 'Granted access', access_revoked: 'Revoked access',
  version_saved: 'Saved version', version_restored: 'Restored version',
  guide_added: 'Getting-started guide added automatically',
  guide_updated: 'Getting-started guide updated automatically',
  guide_removed: 'Getting-started guide (Word copy) removed automatically',
  signed_in: 'Signed in', sign_in_failed: 'Sign-in failed', signed_out: 'Signed out',
  access_reviewed: 'Access list reviewed',
};
function label(type) { return LABELS[type] || String(type || '').replace(/_/g, ' '); }
module.exports = { LABELS, label };
