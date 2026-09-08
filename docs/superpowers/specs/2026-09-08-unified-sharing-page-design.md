# Unified Sharing Page Design

**Date:** 2026-09-08  
**Status:** Design approved; awaiting written-spec review  
**Scope:** Merge `/shared-with-me` and `/shares` into one professional sharing workspace.

## Goal

Create one clear destination named **Sharing** (`Berbagi`) for two related jobs:

1. Review invitations and open folders shared by other users.
2. Manage public file links created by the current user.

The result must reduce navigation duplication, preserve shared-folder access rules, reuse the repository design system, and meet WCAG 2.2 AA expectations without changing database schemas or API contracts.

## Information Architecture

`/shares` becomes the canonical sharing page. It exposes two URL-addressable views:

- `/shares?view=received` — **Shared with me**: pending invitations and accepted folders.
- `/shares?view=links` — **My links**: public links and their access history.

A pure resolver accepts only `received` and `links`; missing or invalid values render `received` without mirroring URL state through an effect. The switch is a labelled segmented navigation made from real links. It uses `aria-current="page"`, updates browser history naturally, supports deep links, and does not apply tab roles without the complete ARIA tabs keyboard contract.

Legacy and detail routes behave as follows:

- `/shared-with-me` server-redirects to `/shares?view=received`.
- `/invitations` server-redirects to `/shares?view=received`; its duplicate invitation UI is retired.
- `/shared-with-me/[folderId]` remains unchanged as the protected shared-folder browser route.
- Shared-folder root, back, and successful leave actions return to `/shares?view=received`; detail breadcrumbs continue to use `/shared-with-me/[folderId]`.

The desktop sidebar contains one `/shares?view=received` entry labelled **Sharing**. The mobile bottom navigation keeps one Sharing item. It is active when the pathname is `/shares` or begins with `/shared-with-me/`, so query changes and detail routes preserve location feedback. Shell page titles use the same unified label in both contexts. Share-link onboarding deep-links to `/shares?view=links`.

## Page Structure and Visual Direction

The page follows the approved mockup and the existing `.shr-*` visual language in `app/globals.css`:

1. **Header:** restrained collaboration kicker, “Sharing” heading, concise supporting copy.
2. **Summary:** three read-only figures for accepted folders, pending invitations, and active links. A link is active only when it is neither expired nor access-limit exhausted. Loading or failed values use an em dash rather than a misleading zero.
3. **Segmented navigation:** “Shared with me” and “My links.” The received badge communicates pending invitations; the links badge communicates total managed-link count.
4. **View content:** only the selected view is visually mounted. All three top-level queries start when the hub mounts, regardless of selected view, so the summary remains truthful; a failed collection does not block either successful collection.

Use repository semantic tokens only (`--surface`, `--foreground`, `--accent`, `--*-ink`, border and status tokens). Do not introduce raw component hex values, new fonts, emoji icons, animated decoration, glass-heavy effects, or layout-shifting hover transforms. Lucide remains the sole icon family.

Motion uses the repository's reduced-motion mechanism, including `MotionConfig reducedMotion="user"` where Framer Motion remains. With reduced motion, view changes and disclosures are immediate and convey the same state without animation.

## Shared With Me View

Pending invitations remain the highest-priority section and appear only when invitations exist. Each row shows folder, inviter, date, access level, and explicit Accept/Decline actions. Only the row being mutated becomes busy; unrelated invitations remain usable.

Accepted folders appear in a responsive card grid. Cards show folder name, owner, shared date, and a consistent icon-plus-text role chip. The entire card opens `/shared-with-me/[folderId]`. Search matches folder or owner, and sorting supports recent, name, and owner. Controls appear only when useful.

Independent invitation and folder failures render scoped retry callouts. One failed request must not hide successful data from the other request. Empty, no-results, loading, and mutation-error states each explain their cause and provide one relevant recovery action.

## My Links View

Each public-link row shows file name, permission, creation date, expiry, access usage, and a derived textual status. Status precedence is: **expired**, then **access limit reached**, then **active**. Missing expiry or maximum access means that constraint is unlimited. The core actions are:

- **Copy link** — a labelled action that builds the existing `/shared/[token]` URL and reports clipboard success or failure through `notify()`.
- **Access history** — an accessible disclosure button with `aria-expanded` and `aria-controls`; at most one matching detail region is open.
- **Revoke link** — destructive confirmation, row-local busy state, success/error notification, and query invalidation. Cancel performs no mutation.

Access history remains lazy: `/api/shares/[id]/access-logs` runs only when a row is expanded. Each expansion starts with five events; “Show all” reveals the remaining events returned by the existing API, while collapsing resets that row to five for its next opening. Device, browser, OS, IP, location, and timestamp use a compact reading order. When coordinates exist, a text “Open map” external link includes an accessible external-destination label and safe `rel` attributes. The current third-party static-map image is removed to avoid layout failure, unnecessary network transfer, and location disclosure during passive page rendering.

The links query throws on an unsuccessful API response instead of converting failures into an empty list. Loading, query failure, true empty state, no-results state, access-log failure, clipboard failure, and revoke failure are visually and semantically distinct. Query failure offers retry; no-results offers search reset; access-log failure stays inside the expanded row and offers retry without hiding link actions.

## Component Boundaries

Keep the route thin and split responsibilities under the existing shares feature:

- `SharingHub` — URL view resolution, all top-level queries/counts, page header, and segmented navigation.
- `ReceivedSharesView` — filtering/sorting and rendering of invitations and accepted folders; receives query results and mutation callbacks rather than refetching collections.
- `PublicLinksView` — link search/sort, copy/revoke actions, disclosure ownership, and public-link rows; receives the links query result.
- `AccessHistoryPanel` — lazy access-log query and progressive disclosure for one expanded share.
- Small shared role/status primitives — icon-plus-text semantics only.

Pure view-resolution and status-derivation helpers stay independent of React so they can be unit tested. The exact feature folder and filenames follow existing repository conventions discovered during implementation; these responsibility boundaries are mandatory, not the proposed component names. Existing APIs remain authoritative; no aggregate endpoint, database migration, or permission change is introduced.

## Data and State Flow

React Query retains the existing cache keys: `invitations`, `shared-with-me`, `shares`, and `access-logs`. The three top-level collections load independently and concurrently on hub mount so the summary is accurate and each panel can recover independently. Access logs use `['access-logs', shareId]` and stay disabled until that share is expanded. Switching views never changes cache identity or duplicates collection requests.

Invitation mutations target one invitation ID at a time and disable only that row's Accept/Decline controls. A successful accept or decline invalidates `invitations` and `shared-with-me`; failures keep the row present and notify the user. Link revocation similarly targets one share ID. Success invalidates `shares` and closes history only if that share is currently expanded. Copying never mutates server state.

Notifications use the shared `notify()` system rather than page-local timers. Destructive revocation uses the shared dialog primitive rather than `window.confirm`. Repeated action submission is blocked while the matching row is pending, but unrelated rows and the other view remain usable.

Derived arrays, counts, link statuses, active view, and disclosure visibility are computed directly or memoized from stable query data; data is not copied into state through effects. Local state is limited to user-owned inputs such as search, sort, expanded share ID, and per-row pending action. This preserves React Compiler lint compliance.

## Responsive and Accessibility Contract

- Desktop: header and summaries share one row; cards use auto-fill columns; link actions stay aligned at row end.
- Tablet: summary and tools wrap intentionally; folder grid becomes two columns.
- Mobile (375 px baseline): summary tiles remain readable, segmented controls fill the width, toolbars stack, cards become one column, and row actions become full-width without horizontal scrolling.
- Coarse-pointer targets are at least 44×44 px; keyboard focus is always visible.
- Page has one `h1`; sections use ordered headings; segmented links expose the current page; disclosure controls expose expanded state; icon-only fallback actions have localized accessible names.
- Status, role, active view, error, and selected state never rely on color alone.
- Fetch regions use `aria-busy`; inline failures use `role="alert"`; non-urgent counts and results use `role="status"` only when an update needs announcement. Notifications are announced by the existing system without duplicate live regions.
- Layout remains usable at 200% zoom and honors safe-area/mobile shell offsets.

## Localization

Update English, Indonesian, and Simplified Chinese together. Add one neutral Sharing navigation/title label and copy for both views, statuses, errors, confirmations, search/sort controls, and accessible action names. Reuse existing permission and common action keys where semantics are identical; do not create near-duplicate wording.

## Validation

Implementation is complete only after:

1. Unit tests cover URL view resolution (missing, invalid, `received`, and `links`), public-link status precedence and boundary times, navigation active matching, and redirect target constants/helpers where redirect pages depend on them.
2. Component tests cover independent query failures, row-local mutation busy state, disclosure ownership, the five-event history limit, and accessible current/expanded/error semantics.
3. Existing shared-folder permission, invitation, share, and access-log API tests remain green.
4. `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run check:i18n`, and `npm run lint:contrast` pass.
5. `npm run build` passes, catching App Router issues not visible to TypeScript alone.
6. Browser verification covers both views, redirects, invitation response, copy/history/revoke flows, query failures, empty states, light/dark themes, keyboard navigation, 200% zoom, reduced motion, and widths 375/768/1024/1440 px. Run the relevant Playwright accessibility suite when its authenticated fixtures are available; otherwise document the manual keyboard and axe checks performed.
7. `.superpowers/` is added to `.gitignore` so the local visual-companion artifact cannot enter source control.
8. No unrelated local changes are overwritten, staged, committed, or pushed.

## Out of Scope

No schema migration, new sharing model, folder-permission change, public-link creation flow, bulk actions, analytics redesign, or admin-sharing redesign. Public links continue to be created from the file browser.