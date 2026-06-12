# Memex UI QA Checklist

Use this before a release or broad manual review. Check desktop first, then repeat the high-risk items on a narrow/mobile viewport.

## First Load And Auth

- Login screen loads without console errors.
- Theme selector is visible on the login screen.
- Each theme button applies immediately and remains selected after refresh.
- Google, Microsoft 365, and email/password sign-in controls are visible and aligned.
- Offline/server-unreachable state explains what happened and does not show a blank screen.

## Top Chrome

- Theme selector is visible after sign-in and does not crowd Ask/Menu/user controls.
- Menu contains workspace/account actions only, not duplicated theme controls.
- Ask opens the collection question modal.
- Admin actions remain hidden for non-admin users.

## Themes

- Verify `365`, `Drive`, `Dropbox`, `Graphite`, and `Dark`.
- Text has readable contrast in each theme.
- Active navigation, selected rows, buttons, inputs, modals, and empty states all follow the selected theme.
- Theme choice persists after refresh and after sign-out/sign-in.

## Files Home

- Home summary cards load and do not shift layout badly.
- Recent documents table is scannable and row actions are not crowded.
- File filters work for All, Word, Excel, PowerPoint, and PDF.
- Empty workspace state is helpful and not alarming.
- Upload progress is visible and clears when complete.

## Documents View

- Files, Shared, Links, and Trash nav items activate the correct view.
- Search finds filename/owner matches and shows a helpful no-results state.
- Selection command bar appears only when rows are selected.
- Details pane opens, closes, and keeps action groups readable.
- Danger actions are visually distinct from normal actions.

## Sharing

- Share modal lists existing links or a helpful empty state.
- Creating a link shows the URL and copy action.
- Links page lists active, expired, and revoked links clearly.
- Revoke action updates the list without a full page reload.

## AI

- Ask collection modal opens from top chrome and search menu.
- Ask selected documents requires selected files.
- Streaming answer states are clear: searching, reading, answer, stopped, or failed.
- Provider failures degrade gracefully and do not expose secrets or raw prompts.

## Responsive

- At tablet width, masthead actions wrap or scroll without overlap.
- At phone width, the file rail, filters, tables, and row actions remain usable.
- No text is clipped in buttons, chips, file rows, or modals.
- Modals fit within the viewport and can scroll when content is tall.

## Final Smoke

- Browser console has no warnings or errors during the core flow.
- Refresh keeps the user in a coherent state.
- Live server returns HTTP 200.
- Container is running and on the expected Git commit.
