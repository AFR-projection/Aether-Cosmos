export async function register() {
  // Node-only: the scheduler touches the database and the Edge runtime copy of
  // this module must not pull those imports in.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ warmAdminSettings }, { startCleanupScheduler }] = await Promise.all([
    import("@/lib/admin-settings"),
    import("@/lib/system/cleanup-scheduler"),
  ]);

  warmAdminSettings();
  startCleanupScheduler();
}
