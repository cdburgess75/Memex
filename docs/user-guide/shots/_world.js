// Smoke shots for the shared Acme world (demo/fixtures/base.js). Not part of the guide:
//   node capture/run.js _world
// Every shot should come back with no UNMOCKED calls, no console errors and no missing
// callouts (the callouts here double as a check that the selectors in world-notes.md exist).
'use strict';
const { world, settle } = require('../demo/fixtures/base');
const { F, LIB, CONNECTORS } = world;
const { sleep } = require('../capture/cdp');

const MY = { memex_library_id: LIB.jordan };
const preview = (id, ms = 1800) => async (page) => { await settle(page); await page.eval((fid) => previewFile(fid), id); await sleep(ms); };
const row = (f) => `tr[data-fid="${f.id}"]`;
// A screenshot with no clip drops :hover in headless Chrome, and row actions only show on hover.
// An explicit whole-viewport clip keeps it.
const FULL = { x: 0, y: 0, width: 1440, height: 900 };

module.exports = [
  // First paint with no settle at all: the list latency in base.js must already give a full Home.
  { id: 'home-raw', theme: 'light', route: '#/home', caption: 'world: Home, first paint (no settle)' },
  { id: 'home', theme: 'light', route: '#/home', setup: settle, caption: 'world: Home',
    callouts: [{ n: 1, selector: '#notif-btn', place: 'b' }, { n: 2, selector: '#meet-btn', place: 'b' }, { n: 3, selector: '.file-nav-link[data-view="links"]', place: 'r' }, { n: 4, selector: '.file-library-heading', place: 'r' }] },
  { id: 'home-dark', theme: 'dark', route: '#/home', setup: settle, caption: 'world: Home, dark' },
  { id: 'files-root', theme: 'light', route: '#/files', localStorage: MY, setup: settle, caption: 'world: Files, library root (list)',
    callouts: [{ n: 1, selector: '#file-library-commandbar .masthead-upload-secondary', place: 'b' }, { n: 2, selector: '#file-library-commandbar .masthead-upload:not(.masthead-upload-secondary)', place: 'b' }] },
  { id: 'folder', theme: 'dark', route: '#/files/Proposals/2026', localStorage: MY, setup: async (page) => { await settle(page); await page.hover(row(F['Northfield Clinic proposal'])); }, clip: FULL, caption: 'world: a folder',
    callouts: [{ n: 1, selector: `${row(F['Northfield Clinic proposal'])} .file-library-icon-btn[title="Share"]`, place: 't' }, { n: 2, selector: `${row(F['Northfield Clinic proposal'])} .file-bell-btn`, place: 't' }] },
  { id: 'folder-row', theme: 'light', route: '#/files/Proposals', localStorage: MY, setup: async (page) => { await settle(page); await page.hover('tr[data-folder="Proposals/2026"]'); }, clip: FULL, caption: 'world: folder rows',
    callouts: [{ n: 1, selector: 'tr[data-folder="Proposals/2026"] .file-bell-btn', place: 't' }, { n: 2, selector: 'tr[data-folder="Proposals/2026"] .file-library-icon-btn[title="Folder actions"]', place: 't' }] },
  { id: 'tiles', theme: 'light', route: '#/files/Northfield%20Clinic', localStorage: { memex_library_id: LIB.client, memex_file_view_size: '3' }, setup: settle, caption: 'world: tiles view' },
  { id: 'photos-tiles', theme: 'dark', route: '#/files/Photos', localStorage: { ...MY, memex_file_view_size: '3' }, setup: settle, caption: 'world: photo tiles' },
  { id: 'marketing', theme: 'dark', route: '#/files/Campaigns/Autumn%202026', localStorage: { memex_library_id: LIB.marketing, memex_file_view_size: '3' }, setup: settle, caption: 'world: a shared library' },
  { id: 'pdf-preview', theme: 'light', route: '#/files/Proposals/2026', localStorage: MY, setup: preview(F['Harbor Point Dental proposal'].id, 2500), caption: 'world: PDF preview' },
  { id: 'image-preview', theme: 'dark', route: '#/files/Photos', localStorage: MY, setup: preview(F['Team offsite photo'].id), caption: 'world: image preview' },
  { id: 'docx-preview', theme: 'light', route: '#/files/Proposals/2026', localStorage: MY, setup: preview(F['Northfield Clinic proposal'].id, 2500), caption: 'world: Word preview' },
  { id: 'xlsx-preview', theme: 'dark', route: '#/files', localStorage: MY, setup: preview(F['Q3 budget'].id, 2500), caption: 'world: Excel preview' },
  { id: 'notifications', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.click('#notif-btn'); await sleep(600); }, caption: 'world: Notifications panel' },
  { id: 'meetings', theme: 'dark', route: '#/home', setup: async (page) => { await settle(page); await page.click('#meet-btn'); await sleep(600); }, caption: 'world: Meetings panel' },
  { id: 'settings', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.eval(() => openSettings()); await sleep(900); }, caption: 'world: Settings' },
  { id: 'shared', theme: 'dark', route: '#/shared', setup: settle, caption: 'world: Shared with me' },
  { id: 'links', theme: 'light', route: '#/links', setup: settle, caption: 'world: My links' },
  { id: 'trash', theme: 'dark', route: '#/trash', setup: settle, caption: 'world: Trash' },
  { id: 'share-dialog', theme: 'light', route: '#/files/Northfield%20Clinic', localStorage: { memex_library_id: LIB.client }, setup: async (page) => { await settle(page); await page.eval((id) => openShareFile(id), F['Kickoff agenda'].id); await sleep(1200); await page.eval(() => { const d = document.getElementById('file-access-details'); if (d) d.open = true; document.querySelector('.file-share-modal')?.scrollTo?.(0, 9999); }); await sleep(400); }, caption: 'world: file Share dialog, who has access' },
  { id: 'library-share', theme: 'dark', route: '#/files', localStorage: { memex_library_id: LIB.client }, setup: async (page) => { await settle(page); await page.eval((id) => openLibraryShare({ libraryId: id }), LIB.client); await sleep(1200); }, caption: 'world: Share "Client Projects"' },
  { id: 'sharepoint', theme: 'light', route: '#/files', localStorage: MY, setup: async (page) => { await settle(page); await page.eval((id) => openMount(id), CONNECTORS[0].id); await sleep(1000); }, caption: 'world: SharePoint connection' },
  { id: 'search', theme: 'light', route: '#/files', localStorage: MY, setup: async (page) => { await settle(page); await page.click('#global-search'); await page.type('budget'); await sleep(1500); }, caption: 'world: search' },
  // Second batch: menus, dialogs and settings tabs, to flush out any call base.js does not answer.
  { id: 'file-menu', theme: 'light', route: '#/files/Proposals/2026', localStorage: MY, clip: FULL, setup: async (page) => { await settle(page); await page.hover(row(F['Northfield Clinic proposal'])); await page.click(`${row(F['Northfield Clinic proposal'])} .file-library-icon-btn[title="Actions"]`); await sleep(500); }, caption: 'world: file row menu' },
  { id: 'folder-menu', theme: 'dark', route: '#/files/Proposals', localStorage: MY, clip: FULL, setup: async (page) => { await settle(page); await page.hover('tr[data-folder="Proposals/2026"]'); await page.click('tr[data-folder="Proposals/2026"] .file-library-icon-btn[title="Folder actions"]'); await sleep(500); }, caption: 'world: folder menu' },
  { id: 'folder-share', theme: 'light', route: '#/files', localStorage: { memex_library_id: LIB.client }, setup: async (page) => { await settle(page); await page.eval(() => openFolderShare('Northfield Clinic')); await sleep(1500); }, caption: 'world: folder Share dialog' },
  { id: 'details', theme: 'dark', route: '#/files/Proposals/2026', localStorage: MY, setup: async (page) => { await settle(page); await page.eval((id) => { selectSingleFile(id); toggleDetailsPane(); }, F['Northfield Clinic proposal'].id); await sleep(900); }, caption: 'world: details pane' },
  { id: 'settings-notifications', theme: 'dark', route: '#/home', setup: async (page) => { await settle(page); await page.eval(() => openSettingsAt('notifications')); await sleep(900); }, caption: 'world: Settings, Notifications' },
  { id: 'settings-groups', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.eval(() => openSettingsAt('groups')); await sleep(900); }, caption: 'world: Settings, Groups' },
  { id: 'group-open', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.eval(async (id) => { await openSettingsAt('groups'); await openGroup(id); }, world.GROUPS[1].id); await sleep(900); }, caption: 'world: a group' },
  { id: 'library-menu', theme: 'light', route: '#/files', localStorage: MY, setup: async (page) => { await settle(page); await page.click('.file-library-heading'); await sleep(500); }, caption: 'world: library switcher' },
  { id: 'ask', theme: 'dark', route: '#/home', setup: async (page) => { await settle(page); await page.eval(() => openCollectionAsk()); await sleep(300); await page.type('What does the Northfield Clinic project cost?'); await page.eval(() => submitCollectionAsk(false)); await sleep(1500); }, caption: 'world: Ask' },
  { id: 'schedule', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.eval(() => openScheduleMeeting()); await sleep(600); }, caption: 'world: Schedule a meeting' },
  { id: 'smb', theme: 'dark', route: '#/files', localStorage: MY, setup: async (page) => { await settle(page); await page.eval((id) => openMount(id), CONNECTORS[1].id); await sleep(1000); }, caption: 'world: Windows share' },
  { id: 'status', theme: 'light', route: '#/home', setup: async (page) => { await settle(page); await page.click('#status-pill'); await sleep(600); }, caption: 'world: status popover' },
];
