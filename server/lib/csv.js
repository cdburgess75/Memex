'use strict';
// CSV cell serializer that also neutralizes spreadsheet formula injection: any
// value beginning with = + - @ (or a tab/CR that some parsers treat as a cell
// lead-in) is prefixed with an apostrophe so Excel / Sheets / LibreOffice render
// it as text rather than evaluating it as a formula. Quoting alone does not stop
// this, since spreadsheets strip the quotes on import.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { csvCell };
