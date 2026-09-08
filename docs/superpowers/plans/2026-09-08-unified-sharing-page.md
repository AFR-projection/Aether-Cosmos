# Unified Sharing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge received folder sharing and managed public links into one polished, accessible `/shares` workspace while preserving protected shared-folder routing and APIs.

**Architecture:** Keep App Router route files thin and place pure contracts plus focused client components under `src/features/shares`. The hub starts all three top-level React Query requests concurrently, resolves the selected URL view without effect-driven state, and delegates received folders, public links, and lazy access history to isolated components. Shared navigation helpers keep sidebar, mobile navigation, and shell titles consistent.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, TanStack React Query 5, Framer Motion 12, Lucide React, repository i18n and dialog/notification primitives, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-unified-sharing-page-design.md`

## Global Constraints

- `/shares?view=received` and `/shares?view=links` are the only canonical hub views; missing or invalid values resolve to `received`.
- `/shared-with-me` and `/invitations` server-redirect to `/shares?view=received`; `/shared-with-me/[folderId]` remains unchanged and protected.
- Do not change database schemas, API contracts, or shared-folder permission behavior.
- Keep React Query cache keys `invitations`, `shared-with-me`, `shares`, and `access-logs`.
- Use repository semantic CSS tokens, Lucide icons, shared `notify()`, and shared dialog primitives; do not add dependencies, raw component hex values, emoji icons, or passive third-party map images.
- Meet WCAG 2.2 AA semantics, visible focus, 44×44 coarse-pointer targets, reduced motion, 200% zoom, and 375 px reflow requirements.
- Keep derived data out of effect-driven state to satisfy React Compiler lint.
- Update English, Indonesian, and Simplified Chinese together with identical key structure.
- Preserve every unrelated working-tree modification. Do not reset, stage, commit, push, deploy, or run database migrations.

---

### Task 1: Pure Sharing Contracts

**Files:**
- Create: `src/features/shares/domain/sharing-view.ts`
- Create: `src/features/shares/domain/sharing-view.test.ts`
- Create: `src/features/shares/domain/public-link-status.ts`
- Create: `src/features/shares/domain/public-link-status.test.ts`
- Create: `src/shell/layouts/navigation-route.ts`
- Create: `src/shell/layouts/navigation-route.test.ts`

**Interfaces:**
- Produces: `type SharingView = "received" | "links"`, `resolveSharingView(value: string | string[] | null | undefined): SharingView`, and canonical href constants.
- Produces: `derivePublicLinkStatus(share, now): "expired" | "limit-reached" | "active"` and `isPublicLinkActive(share, now): boolean`.
- Produces: `isSharingPath(pathname: string): boolean`, `isNavigationPathActive(pathname: string, href: string): boolean`, and `getShellTitleKey(pathname: string): TranslationKey | null`.

- [ ] **Step 1: Write failing resolver and route tests**

Cover missing, invalid, array, `received`, and `links` values; canonical hrefs; `/shares`; `/shared-with-me/[folderId]`; unrelated paths; and exact shell-title keys.

- [ ] **Step 2: Run resolver and route tests to verify failure**

Run: `npx vitest run src/features/shares/domain/sharing-view.test.ts src/shell/layouts/navigation-route.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement view and navigation contracts**

Use pure functions only. Parse arrays as invalid input and expose canonical constants so redirects and navigation do not duplicate strings.

- [ ] **Step 4: Write failing link-status tests**

Cover expiry equality, past/future expiry, exhausted equality, unlimited null constraints, precedence when both conditions apply, and active counts.

- [ ] **Step 5: Run status tests to verify failure**

Run: `npx vitest run src/features/shares/domain/public-link-status.test.ts`
Expected: FAIL because the status module does not exist.

- [ ] **Step 6: Implement minimal status derivation**

Treat `expiresAt <= now` as expired, then compare non-null `maxAccessCount`, then return active.

- [ ] **Step 7: Run all Task 1 tests**

Run: `npx vitest run src/features/shares/domain/sharing-view.test.ts src/features/shares/domain/public-link-status.test.ts src/shell/layouts/navigation-route.test.ts`
Expected: PASS.

### Task 2: Unified Query Hub and Received View

**Files:**
- Create: `src/features/shares/presentation/sharing-types.ts`
- Create: `src/features/shares/presentation/sharing-hub.tsx`
- Create: `src/features/shares/presentation/received-shares-view.tsx`
- Modify: `app/shares/page.tsx`

**Interfaces:**
- Consumes: `resolveSharingView`, canonical hrefs, `apiFetch`, `notify`, i18n, existing cache keys.
- Produces: `SharingHub({ initialView }: { initialView: SharingView })`, three independently recoverable top-level queries, and `ReceivedSharesView` props containing query states plus one invitation response callback.

- [ ] **Step 1: Define shared API view-model types**

Move exact invitation, shared-folder, public-link, and access-log shapes into `sharing-types.ts`; do not alter API field names.

- [ ] **Step 2: Make `/shares` a thin server route**

Await `searchParams`, resolve `view`, and render `SharingHub`. Do not mirror URL state in client state or effects.

- [ ] **Step 3: Build the hub queries and summary**

Start `invitations`, `shared-with-me`, and `shares` queries unconditionally. Throw on unsuccessful API responses. Derive accepted, pending, and active-link totals; render `—` for loading/failed totals. Add one `h1`, kicker, supporting copy, and real segmented `<Link>` navigation with `aria-current="page"`.

- [ ] **Step 4: Extract the mature received-sharing UI**

Port folder/owner search, recent/name/owner sorting, invitation rows, role chips, cards, MotionConfig, and scoped states from the old route. Receive query data/status and mutation callback from the hub instead of fetching duplicate collections.

- [ ] **Step 5: Preserve row-local invitation mutations**

Track the current invitation ID through mutation variables, disable only that row, notify on failure/success, and invalidate `invitations` plus `shared-with-me` after success.

- [ ] **Step 6: Verify TypeScript for the new hub**

Run: `npx tsc --noEmit`
Expected: no errors in new Sharing files; fix any introduced errors before proceeding.

### Task 3: Managed Public Links and Access History

**Files:**
- Create: `src/features/shares/presentation/public-links-view.tsx`
- Create: `src/features/shares/presentation/access-history-panel.tsx`
- Modify: `src/features/shares/presentation/sharing-hub.tsx`

**Interfaces:**
- Consumes: public links query result, `derivePublicLinkStatus`, shared dialogs, `notify`, `apiFetch`, and `['access-logs', shareId]`.
- Produces: one-open-row disclosure behavior, row-local revoke state, accessible history regions, and lazy log queries.

- [ ] **Step 1: Build public-link filtering and sorting**

Add user-owned search/sort state, status/permission/date/access metadata, and distinct loading, query-error, true-empty, and no-results states. Keep derived arrays memoized only from stable query data and user inputs.

- [ ] **Step 2: Implement copy feedback**

Build `${window.location.origin}/shared/${token}`, call the Clipboard API, and use `notify()` for both success and failure without page-local timer state.

- [ ] **Step 3: Implement confirmed row-local revoke**

Use `useDialogs().askConfirm` with destructive styling. Block repeat submission only for the selected share; cancel must not call DELETE. On success invalidate `shares`, close history only if the revoked row is open, and notify. Keep failures recoverable.

- [ ] **Step 4: Implement owned disclosure state**

Store one expanded share ID. Buttons expose `aria-expanded`, `aria-controls`, and localized accessible names. Collapsing closes the region and resets that row’s visible limit.

- [ ] **Step 5: Implement lazy access history**

Enable `['access-logs', shareId]` only while its matching panel is expanded, throw on unsuccessful API responses, start at five events, add “Show all”, and provide inline retry without hiding row actions.

- [ ] **Step 6: Replace static maps with safe links**

Render compact textual device/browser/OS/IP/location/timestamp details. If finite coordinates exist, render a labelled external OpenStreetMap link with `target="_blank"` and `rel="noopener noreferrer"`; never load a third-party image passively.

- [ ] **Step 7: Run focused static validation**

Run: `npx tsc --noEmit`
Expected: PASS.

### Task 4: Legacy Routes and Unified Shell Navigation

**Files:**
- Modify: `app/shared-with-me/page.tsx`
- Modify: `app/invitations/page.tsx`
- Modify: `src/shell/layouts/sidebar.tsx`
- Modify: `src/shell/layouts/bottom-nav.tsx`
- Modify: `src/shell/layouts/client-shell.tsx`
- Modify: `src/shell/compositions/onboarding-checklist.tsx`
- Modify: `src/features/files/presentation/components/folders/leave-shared-folder-button.tsx`
- Modify: `src/features/files/presentation/components/files/file-browser.tsx`

**Interfaces:**
- Consumes: canonical received/links href constants and shared navigation-route helpers.
- Produces: one shell destination and consistent returns to `/shares?view=received` while preserving all `/shared-with-me/[folderId]` detail links.

- [ ] **Step 1: Replace duplicate roots with server redirects**

Both route files call `redirect(SHARING_RECEIVED_HREF)` and contain no client query UI.

- [ ] **Step 2: Consolidate desktop and mobile navigation**

Remove the duplicate received-shares sidebar item; point the sole Sharing entry to the received URL; use the shared active helper for `/shares` and shared-folder details; remove unused imports.

- [ ] **Step 3: Centralize shell title resolution**

Use `getShellTitleKey` in `client-shell.tsx` so `/shares` and `/shared-with-me/[folderId]` show the neutral Sharing label.

- [ ] **Step 4: Update entry and return links**

Deep-link onboarding to `SHARING_LINKS_HREF`; change successful leave and shared-root back links to `SHARING_RECEIVED_HREF`; leave breadcrumbs, folder tree, and nested folder links under `/shared-with-me/[id]`.

- [ ] **Step 5: Run route-helper and permission regression tests**

Run: `npx vitest run src/shell/layouts/navigation-route.test.ts tests/shared-folder-route-gates.test.ts`
Expected: PASS.

### Task 5: Visual System, Localization, and Local Artifact Exclusion

**Files:**
- Modify: `app/globals.css`
- Modify: `src/shared/lib/i18n/messages/en.ts`
- Modify: `src/shared/lib/i18n/messages/id.ts`
- Modify: `src/shared/lib/i18n/messages/zh-CN.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing `.shr-*` namespace, semantic color tokens, translation-key typing.
- Produces: responsive hub, public-link/history styles, and structurally identical locale dictionaries.

- [ ] **Step 1: Extend `.shr-*` styles**

Add three summary tiles, segmented links, managed-link rows, status chips, action groups, disclosure panels, history events, and scoped state styles. Use semantic tokens/color-mix only, `data-*` variants where cascade strength is needed, visible focus, and no layout-shifting transform.

- [ ] **Step 2: Add responsive and reduced-motion rules**

At existing breakpoints, make segmented controls and actions full-width as appropriate, prevent horizontal overflow, keep 44×44 coarse-pointer targets, and remove nonessential transitions under reduced motion.

- [ ] **Step 3: Update all locale dictionaries surgically**

Add neutral Sharing navigation/title, hub/view/summary copy, link filters/statuses/errors, revoke confirmation, disclosure, history, map, and accessible action labels to English, Indonesian, and Simplified Chinese with identical key structure.

- [ ] **Step 4: Ignore the local visual companion directory**

Append `.superpowers/` under local agent/editor settings without deleting the existing artifact.

- [ ] **Step 5: Validate localization and contrast**

Run: `npm run check:i18n`
Expected: PASS.

Run: `npm run lint:contrast`
Expected: PASS.

### Task 6: Automated and Browser Validation

**Files:**
- Modify only files implicated by failures introduced by this feature.

**Interfaces:**
- Consumes: completed unified Sharing feature.
- Produces: verified implementation and a truthful validation report.

- [ ] **Step 1: Run targeted tests**

Run: `npx vitest run src/features/shares/domain/sharing-view.test.ts src/features/shares/domain/public-link-status.test.ts src/shell/layouts/navigation-route.test.ts tests/shared-folder-route-gates.test.ts`
Expected: PASS.

- [ ] **Step 2: Run ESLint**

Run: `npm run lint`
Expected: PASS; fix feature-caused React Compiler, accessibility, or import issues.

- [ ] **Step 3: Run TypeScript**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run all unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Re-run repository policy checks**

Run: `npm run check:i18n`
Expected: PASS.

Run: `npm run lint:contrast`
Expected: PASS.

- [ ] **Step 6: Run the production build**

Run: `npm run build`
Expected: PASS, including App Router server/client boundaries.

- [ ] **Step 7: Run available accessibility/browser checks**

Run: `npm run test:a11y`
Expected: PASS when authenticated fixtures and browser dependencies are available. If unavailable, record the exact blocker rather than claiming success.

- [ ] **Step 8: Perform manual browser verification when the app can run**

Check both URL views, redirects, row-local invitation response, copy, history, retry, revoke/cancel, empty/error states, keyboard order/focus, reduced motion, light/dark themes, 200% zoom, and 375/768/1024/1440 px. Record any environment limitation explicitly.

- [ ] **Step 9: Inspect the final scoped diff**

Confirm no unrelated changes were reset, staged, reformatted, committed, or pushed; report validation results and any pre-existing unrelated failures separately.
