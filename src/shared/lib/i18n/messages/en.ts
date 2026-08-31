/**
 * English is the source of truth, for the keys and for the type.
 * `TranslationKey` is derived from this object, so a typo in a `t()` call is a
 * compile error rather than a runtime blank.
 *
 * No `as const`: values must widen to `string` so `id` and `zh-CN` can supply
 * different text for the same key.
 *
 * A plural key is an object with `one` and `other`. `id` and `zh-CN` supply
 * `other` alone, which is linguistically correct rather than incomplete.
 */

export const en = {
  common: {
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    delete: "Delete",
    rename: "Rename",
    remove: "Remove",
    retry: "Retry",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
    done: "Done",
    search: "Search",
    loading: "Loading…",
    saving: "Saving…",
    yes: "Yes",
    no: "No",
    more: "More",
    copy: "Copy",
    copied: "Copied",
    download: "Download",
    refresh: "Refresh",
    name: "Name",
    actions: "Actions",
    on: "On",
    off: "Off",
    closeDialog: "Close dialog",
    somethingWentWrong: "Something went wrong",
    /** Access-level wording, shared by every folder-permission surface. */
    canEdit: "Can edit",
    viewOnly: "View only",
    /** Item-kind wording, shared by the dashboard, the recycle bin and the browser. */
    note: "Note",
    file: "File",
    folder: "Folder",
    /**
     * The strength meter, shared by the password forms and the upload-encryption
     * passphrase. One interpolated sentence rather than a bolded level inside a
     * label, so the punctuation between them belongs to each language.
     */
    passwordStrength: {
      summary: "Strength: {level}",
      veryWeak: "Very weak",
      weak: "Weak",
      fair: "Fair",
      strong: "Strong",
      veryStrong: "Very strong",
      unknown: "Unknown",
    },
    /**
     * How long ago something happened, in the compact form a timestamp column
     * has room for. Shared: the recycle bin ages a deletion with it and the
     * activity centre ages an event with it, and neither reading is specific to
     * its own surface. `{count}` is already locale-formatted by the caller.
     */
    relative: {
      now: "Now",
      yesterday: "Yesterday",
      /** The admin log is the one surface fresh enough to need seconds. */
      seconds: "{count}s ago",
      minutes: "{count}m ago",
      hours: "{count}h ago",
      days: "{count}d ago",
      weeks: "{count}w ago",
      months: "{count}mo ago",
    },
    /** A plural leaf: an object keyed by Intl plural category. */
    itemCount: { one: "{count} item", other: "{count} items" },
    selectedCount: { one: "{count} selected", other: "{count} selected" },
  },

  nav: {
    dashboard: "Dashboard",
    files: "Files",
    brain: "Second Brain",
    favorites: "Favorites",
    sharedWithMe: "Shared with me",
    shared: "Shared",
    recycleBin: "Recycle Bin",
    settings: "Settings",
    admin: "Admin",
    logout: "Sign out",
    quickSearch: "Quick search...",
    storageUsed: "Storage used",
    toggleTheme: "Toggle theme",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
    sidebarLandmark: "Sidebar",
    navigationMenu: "Navigation menu",
    openNavigationMenu: "Open navigation menu",
    skipToContent: "Skip to main content",
    closeNavigationMenu: "Close navigation menu",
    mainNavigation: "Main navigation",
    menu: "Menu",
    moreMenu: "More menu",
    searchFiles: "Search files",
  },

  quickActions: {
    title: "Create new",
    upload: "Upload files",
    uploadHint: "Pick files from this device",
    note: "New note",
    noteHint: "Write something down quickly",
    folder: "New folder",
    folderHint: "Create an empty folder",
  },

  palette: {
    placeholder: "Search files or navigate...",
    sectionNavigation: "Navigation",
    noResults: "No results found",
    noResultsHint: "Try a different search term",
    hintClose: "close",
    hintNavigate: "navigate",
    hintSelect: "select",
    dashboardHint: "Overview & stats",
    filesHint: "Browse and manage files",
    favoritesHint: "Starred items",
    brainHint: "Memories, projects & agents",
    newMemory: "New memory",
    newMemoryHint: "Write something worth keeping",
    graph: "Knowledge graph",
    graphHint: "Entities and relationships",
    agents: "Brain agents",
    agentsHint: "Connect or revoke an MCP agent",
  },

  impersonation: {
    notice: "You are impersonating a user.",
    end: "End impersonation",
  },

  notify: {
    newLoginTitle: "New login detected",
    newLoginBody: "New login detected from a new device or location.",
  },

  /**
   * The feedback layer above every page: the live-connection pill, the overlay
   * that takes over when the server is unreachable, and the two toasts the
   * browser's own online/offline events raise. It belongs to no route, so it has
   * a namespace of its own.
   */
  system: {
    connection: {
      connecting: "Connecting",
      live: "Live",
      reconnecting: "Reconnecting",
      offline: "Offline",
    },
    offline: {
      /** The overlay heading, and the title of the toast the browser event raises. */
      title: "You’re offline",
      toastNote: "Some actions will retry when connection returns.",
      body: "We can’t reach the server right now.",
      reassure: "Your local work has not been lost.",
      checking: "Checking…",
      /**
       * Kept as a label rather than a sentence with the time interpolated: the
       * time itself stays inside a `<time datetime>` element next to it.
       */
      lastCheckedLabel: "Last checked:",
      backTitle: "Back online",
      backNote: "Reconnecting to live updates…",
    },
  },

  language: {
    label: "Language",
    note: "Applies to the whole interface, on this browser.",
    selectorLabel: "Select language",
  },

  auth: {
    /** Shared by every sign-in screen. */
    continue: "Continue",
    required: "Required",
    emailPlaceholder: "you@example.com",
    passwordLabel: "Password",
    backToSignIn: "Back to sign in",
    stepPassword: "Sign in",
    stepStepCode: "2-step code",
    stepAuthenticator: "Authenticator",
    stepperLabel: "Sign-in progress",
    eyebrow: "ACCESS / 0{step}",
    secureWorkspace: "SECURE WORKSPACE",
    encryptedWorkspace: "Encrypted workspace",
    privateByDefault: "Private by default",
    privateByDefaultNote: "Every layer has a purpose.",
    login: {
      title: "Welcome back",
      description: "Sign in to open your private workspace.",
      visualKicker: "STORAGE / CONTROLLED ACCESS",
      visualTitleTop: "Your files.",
      visualTitleEm: "In their right place.",
      visualDescription:
        "A quiet, dependable home for the things you need to keep close — with every layer of access made deliberate.",
      footer: "Your space stays yours",
      identifier: "Username or email",
      passwordPlaceholder: "Enter your password",
      showPassword: "Show password",
      hidePassword: "Hide password",
      submit: "Continue to workspace",
      submitting: "Checking access…",
      submittingAnnounce: "Signing you in",
      newTo: "New to {app}?",
      createAccount: "Create an account",
      inviteOnly: "Access is invitation-only for this workspace.",
      failed: "Sign-in failed",
      registrationDisabled: "Public registration is currently disabled",
    },
    stepCode: {
      title: "Second layer",
      description: "Enter your personal security code to continue.",
      descriptionExact: "Enter your {length}-digit security code to continue.",
      visualKicker: "STORAGE / SECOND SIGNAL",
      visualTitleTop: "One more",
      visualTitleEm: "quiet signal.",
      visualDescription:
        "A second layer keeps the path to your workspace deliberate, even when your password is known.",
      submit: "Verify security code",
      submitting: "Verifying code…",
      incorrect: "Incorrect code",
    },
    setup: {
      titleChoose: "Create your code",
      titleConfirm: "Confirm your code",
      descriptionChoose: "Choose a code you can remember, but others cannot guess.",
      descriptionConfirm: "Enter it one more time so we know it is yours.",
      visualKicker: "STORAGE / PERSONAL KEY",
      visualTitleTop: "Make access",
      visualTitleEm: "uniquely yours.",
      visualDescription:
        "This code becomes a private signal between you and your workspace. Keep it memorable, never predictable.",
      noteChoose: "A code worth remembering",
      noteConfirm: "One last check",
      ruleDigits: "{min}–{max} digits, numbers only",
      ruleAvoid: "Avoid repeats, sequences, and important dates",
      labelNew: "New code",
      labelConfirm: "Confirm code",
      submit: "Set secure code",
      submitting: "Saving code…",
      mismatch: "Codes do not match. Please enter the same code again.",
      failed: "Setup failed",
      changeCode: "Change code",
    },
    authenticator: {
      description: "Confirm with the code from your trusted device.",
      recoveryTitle: "Recovery code",
      recoveryDescription: "Use one of your saved backup codes.",
      visualKicker: "STORAGE / VERIFIED PRESENCE",
      visualTitleTop: "Known device.",
      visualTitleEm: "Clear signal.",
      visualDescription:
        "The final check connects your account to a device you already trust, keeping the handoff private and intentional.",
      gridLabel: "Six digit authenticator code",
      digitLabel: "Authenticator digit {index} of 6",
      submit: "Verify authenticator",
      submitting: "Verifying device…",
      invalid: "Invalid code",
      backupLabel: "Backup code",
      backupHint: "One-time use",
      backupPlaceholder: "xxxx-xxxx-xxxx",
      useRecovery: "Use recovery code",
      useAuthenticator: "Use authenticator code",
      verifying: "Verifying code…",
      startOver: "Start over",
    },
    numpad: {
      label: "Security code",
      groupLabel: "2-Step Code entry",
      keypadLabel: "Security code keypad",
      deleteLast: "Delete last digit",
      progressExact: "{filled} of {total} digits entered",
      progressRange: "{filled} digits entered — {min} to {max} allowed",
      shapeExact: "{length}-digit code",
      shapeRange: "{min}–{max} digits",
      shuffled: "· keypad shuffled",
    },
    register: {
      title: "Create account",
      subtitle: "Join {app}",
      username: "Username",
      usernameHint: "Letters, numbers, dot, underscore, hyphen. No spaces.",
      email: "Email Address",
      emailHint: "We'll send a 6-digit code here to verify your account.",
      haveAccount: "Already have an account?",
      signIn: "Sign in",
      usernameInvalid:
        "Username may only contain letters, numbers, dot, underscore, and hyphen (no spaces)",
      emailInvalid: "Please enter a valid email address",
      failed: "Registration failed",
    },
    passwordRule: {
      minLength: "At least {min} characters (12+ recommended)",
      mix: "At least 3 of: lowercase, uppercase, number, special character",
      notCommon: "Not a common or predictable password",
    },
    /**
     * The forced-reset screen at `/change-password`, which an administrator can
     * push a user into. Separate from `settings.password.*`: this one explains why
     * the user is here, and the current password is optional because an admin
     * reset may have invalidated the one they know.
     */
    changePassword: {
      title: "Change your password",
      description: "An administrator requires you to set a new password before continuing.",
      current: "Current password (if known)",
      new: "New password",
      confirm: "Confirm new password",
      submit: "Update password",
      mismatch: "Passwords do not match",
      failed: "Failed to update password",
    },
    verify: {
      title: "Verify your email",
      sentTo: "We sent a 6-digit code to",
      resent: "New code sent. It can take a minute — remember to check Spam too.",
      codeLabel: "Verification code",
      expired: "This code has expired — tap Resend to get a new one.",
      expiresIn: "Code expires in {clock}",
      submit: "Verify",
      noCode: "Didn't get the code?",
      resend: "Resend",
      resendIn: "Resend in {seconds}s",
      failed: "Verification failed",
      resendFailed: "Failed to resend code",
      stillNothing: "Still nothing in your inbox?",
      helpTitle: "Can't find the code?",
      /* The emphasis inside these steps was dropped on purpose: a bolded word in
         the middle of a sentence cannot survive translation without splitting the
         sentence into fragments that reorder badly in Chinese and Indonesian. */
      help1:
        "Check your Spam and Promotions folders — automated verification codes often get filtered there.",
      openGmailSpam: "Open Gmail Spam folder",
      help2: "Make sure {email} is correct.",
      help2Action: "Wrong address? Start over.",
      help3: "Wait a minute or two — email can be delayed — then tap Resend above.",
      notSpamTip:
        "Found it in Spam? Open the email and tap “Not spam” so future codes reach your inbox.",
    },
  },

  securityAlert: {
    ipTitle: "Security Alert",
    revokedTitle: "Signed out remotely",
    expiredTitle: "Session expired",
    ipReason: "Your session was revoked because your IP address changed.",
    previousIp: "Previous IP:",
    currentIp: "Current IP:",
    unknownIp: "unknown",
    signInAgain: "Please sign in again to continue.",
    revokedBody:
      "This device was signed out from another session or by an administrator. Please sign in again.",
    expiredBody: "Your session has expired due to inactivity. Please sign in again.",
    dismiss: "Dismiss",
  },

  errorPages: {
    goToDashboard: "Go to Dashboard",
    accessDeniedTitle: "Access Denied",
    accessDeniedBody: "You don't have permission to access this resource.",
    forbiddenCode: "Error: 403 Forbidden",
    needAccess: "Need access? Contact an administrator.",
    notFoundTitle: "Page not found",
    notFoundBody: "The page you are looking for does not exist or has been moved.",
    unexpectedBody: "An unexpected error occurred. Please try again.",
    tryAgain: "Try again",
    /**
     * The maintenance screen. `maintenanceBody` is only the fallback: when the
     * admin has written a notice, that prose is shown as authored — it is
     * operator content, in whatever language it was typed, and paraphrasing it
     * would be worse than showing it verbatim.
     */
    maintenanceTitle: "Under maintenance",
    maintenanceBody: "System is under maintenance. Please check back later.",
    backToSignIn: "Back to sign in",
  },

  oauth: {
    title: "Authorize connection",
    defaultApp: "An external application",
    intro:
      "{app} wants to connect to your {product} account. Choose what it can do, then allow access.",
    warning:
      "This gives an external app direct access to your data with the permissions you check below. Only allow apps you trust — you can revoke this anytime from the Connection page. Never approve a request you didn't start yourself.",
    permissionsRequested: "Permissions requested",
    sensitive: "sensitive",
    always: "always",
    adminHidden:
      "This app also requested admin permissions, which were hidden because your account isn't a master account. They will not be granted.",
    redirectsTo: "Redirects to:",
    allow: "Allow access",
    invalidRequest: "Invalid OAuth request. Missing client_id, redirect_uri, or PKCE challenge.",
    failed: "Authorization failed",
    afterNote:
      "After allowing access, you'll be redirected back to the connector app. OAuth tokens are used for API access — your sk_ API keys are never shared with the app.",
    scope: {
      read: { label: "Read", description: "List files, folders, search, and metadata" },
      upload: { label: "Upload", description: "Upload new files to your storage" },
      download: { label: "Download", description: "Download your files and archives" },
      write: { label: "Write", description: "Rename, move, favorite, and edit notes" },
      delete: { label: "Delete", description: "Move files to trash or delete permanently" },
      full: {
        label: "Full storage access",
        description: "All storage permissions (excludes admin)",
      },
      supreme: { label: "Supreme", description: "Unrestricted platform + admin control" },
      admin: { label: "Admin (all)", description: "Full admin panel API access" },
      adminUsers: { label: "Manage users", description: "Create, update, suspend, delete users" },
      adminSettings: {
        label: "Platform settings",
        description: "Change platform configuration",
      },
      adminStats: { label: "Statistics", description: "Read dashboard statistics" },
      adminMonitoring: { label: "Monitoring", description: "System health and monitoring" },
      adminShares: {
        label: "All shares",
        description: "Manage every shared link platform-wide",
      },
      adminEmail: {
        label: "Email",
        description: "Gmail sender management for OTP + notifications",
      },
    },
  },

  dashboard: {
    kicker: "Workspace overview",
    title: "Your storage, in focus.",
    subtitle: "Everything important—capacity, recent work, and activity—in one calm view.",
    refreshing: "Refreshing",
    autoRefresh: "Auto-refreshes every 30s",
    openFiles: "Open files",
    liveCapacity: "Live capacity",
    storageOverview: "Storage overview",
    /** `{state}` is one of the four capacity sentences below. */
    storageState: "{state}. Your workspace updates automatically as files change.",
    usedOf: "used of {total}",
    unlimited: "unlimited storage",
    available: "Available",
    threshold: "Threshold",
    noticeCritical: "Storage is at or over the configured warning threshold.",
    noticeWarning: "You are getting closer to the configured storage threshold.",
    capacityLabel: "{percent} percent of storage capacity used",
    inUse: "in use",
    quotaNotConfigured: "Quota not configured",
    capacityAttention: "Capacity needs attention",
    capacityApproaching: "Approaching capacity threshold",
    capacityHealthy: "Capacity is healthy",
    inventory: "Workspace inventory",
    metricFiles: "Files",
    metricFilesNote: "Across your workspace",
    metricFolders: "Folders",
    metricFoldersNote: "Organized spaces",
    metricCapacity: "Capacity",
    metricCapacityNote: "Current use",
    recentFiles: "Recent files",
    viewAll: "View all",
    noRecentFiles: "No recent files",
    noRecentFilesBody: "Files you upload appear here.",
    goToFiles: "Go to files",
    activityStream: "Activity stream",
    noActivity: "No activity",
    noActivityBody: "Uploads, downloads, and changes show here.",
    adminSignal: "Admin signal",
    systemPulse: "System pulse",
    systemPulseBody: "A quick view of the whole {app} workspace.",
    signalUsers: "Users",
    signalFiles: "Files",
    signalStored: "Stored",
    openAdmin: "Open admin",
    loading: "Loading dashboard",
    errorTitle: "Dashboard is taking a moment.",
    errorBody:
      "We could not load your latest workspace overview. Your files are safe—try refreshing the view.",
    /**
     * Keyed by the `action` column on the activity row. An action with no entry
     * here falls back to its own de-underscored name, which is a technical token
     * rather than prose, so it reads the same in every locale.
     */
    action: {
      upload: "Uploaded a file",
      download: "Downloaded a file",
      delete: "Moved a file to recycle bin",
      login: "Signed in to the workspace",
      create: "Created a new item",
      restore: "Restored a file",
    },
  },

  shares: {
    title: "Shared Links",
    subtitle: "Manage your shared file links and track who accessed them",
    empty: "No shared links",
    emptyHint: "Share files from the file browser",
    /** The wire value is `view` / `edit`; this is only how the badge reads. */
    permission: {
      view: "View",
      edit: "Edit",
    },
    sharedOn: "Shared {date}",
    expiresOn: "Expires {date}",
    viewCount: { one: "{count} view", other: "{count} views" },
    viewCountCapped: { one: "{count} / {max} view", other: "{count} / {max} views" },
    copyLink: "Copy Link",
    copied: "Copied!",
    linkCopied: "Link copied!",
    copyFailed: "Failed to copy link",
    deleteShare: "Delete share",
    deleteFailed: "Failed to delete share",
    deleted: "Share deleted",
    connectionFailed: "Connection failed",
    accessHistory: "Access history",
    viewAccessHistory: "View access history",
    accessCount: { one: "{count} access", other: "{count} accesses" },
    noAccessData: "No access data",
    noAccessDataHint: "Opens show here",
    showAll: "Show all {count} accesses",
    unknownDevice: "Unknown device",
    unknown: "Unknown",
    location: "Location",
    isp: "ISP",
    timezone: "Timezone",
    mapAlt: "Map",
    /**
     * The recipient's side of a link — the standalone `/shared/[token]` page. The
     * expiry row reuses `expiresOn` above, so a link's own page and the owner's
     * list describe the same limit with the same sentence.
     */
    public: {
      /**
       * Both the hover title on the counter and its screen-reader gloss: the
       * digits alone read as "12 slash 20" and mean nothing on their own.
       */
      viewsUsed: "Views used",
      expiryTitle: "When this link stops working",
      loading: "Loading shared file…",
      loadFailed: "Failed to load shared file",
      noPreview: "This file type can’t be previewed here.",
    },
  },

  sharedWithMe: {
    kicker: "Collaboration",
    title: "Shared with me",
    intro:
      "Folders other people have given you access to. Invitations arrive here first — accept one and the folder joins the list below.",
    tallyFolders: "Folders",
    tallyPending: "Pending",
    pendingTitle: "Pending invitations",
    pendingSub: "Accept to add the folder, decline to remove it.",
    /** `{reason}` is the server's own sentence, or the generic one below. */
    respondError: "{reason} Nothing changed — try again.",
    respondFailed: "Could not respond to that invitation.",
    sharedFolders: "Shared folders",
    searchPlaceholder: "Folder or owner…",
    searchLabel: "Search shared folders",
    sortLabel: "Sort shared folders",
    sortRecent: "Recently shared",
    sortName: "Folder name",
    sortOwner: "Owner",
    loadingFolders: "Loading shared folders",
    loadError: "Could not load your shared folders",
    loadErrorHint: "The list is still there — this was a problem fetching it.",
    emptyTitle: "Nothing shared with you",
    emptyBody:
      "When a teammate shares a folder, the invitation shows up above. Accepted folders then live here.",
    openMyFiles: "Open my files",
    noMatch: "No folder matches “{query}”",
    noMatchHint: "Try the owner’s name, or clear the search to see all {count}.",
    clearSearch: "Clear search",
    /** The inviter's name is not emphasised inline: the clause reorders in id and zh-CN. */
    from: "From {user}",
    accept: "Accept",
    decline: "Decline",
    acceptLabel: "Accept invitation to {folder}",
    declineLabel: "Decline invitation to {folder}",
    ownedBy: "Owned by",
    sharedOn: "shared",
    /**
     * A member's counterpart to deleting a folder. The folder name is the owner's
     * own text, so it is interpolated rather than written into the sentence.
     */
    leave: {
      label: "Leave",
      action: "Leave shared folder",
      confirmTitle: "Leave shared folder?",
      confirmBody:
        "“{folder}” will disappear from your list. The owner’s files aren’t deleted, and you can be invited again later.",
      confirmAction: "Leave folder",
      leaving: "Leaving…",
      failed: "Couldn’t leave the folder",
      failedHint: "Please try again in a moment.",
      done: "Left the folder",
      doneNote: "{folder} is no longer in your list.",
    },
  },

  /**
   * The standalone `/invitations` route. `sharedWithMe` lists the same pending
   * invitations inline, so the Accept and Decline wording is reused from there —
   * only this page's own header and empty state live here.
   */
  invitations: {
    title: "Folder invitations",
    intro: "Pending invitations from other users.",
    loadFailed: "Could not load invitations.",
    emptyTitle: "No pending invitations",
    emptyBody: "Invitations from other users show here.",
    /** One clause rather than a bolded name inline: the order changes per language. */
    invitedBy: "Invited by {user}",
  },

  recycleBin: {
    title: "Recycle Bin",
    subtitle: "Restore deleted files or permanently remove them",
    searchPlaceholder: "Search deleted files...",
    clear: "Clear",
    emptyTrash: "Empty Trash",
    empty: "Recycle bin is empty",
    emptyHint: "Deleted files and folders show here",
    /**
     * Group headings. The grouping itself is keyed off a stable id
     * (`today`, `week`, …) that never changes with the language, because the
     * same value is the key of the expanded-groups set.
     */
    group: {
      today: "Today",
      yesterday: "Yesterday",
      week: "This Week",
      month: "This Month",
      older: "Older",
    },
    /** Relative deletion age now lives in `common.relative`: the activity
     *  timeline needs the same words, and neither surface owns them. */
    restore: "Restore",
    restored: "“{name}” restored",
    restoreFailed: "Failed to restore",
    permanentlyDeleted: "“{name}” permanently deleted",
    deleteFailed: "Failed to delete",
    connectionFailed: "Connection failed",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    /** The narrow-screen label for Delete, where the full word does not fit. */
    deleteShort: "Del",
    batchRestored: { one: "{count} item restored", other: "{count} items restored" },
    batchDeleted: {
      one: "{count} item permanently deleted",
      other: "{count} items permanently deleted",
    },
    restoreFilesFailed: "Failed to restore files",
    restoreFoldersFailed: "Failed to restore folders",
    deleteFilesFailed: "Failed to delete files",
    deleteFoldersFailed: "Failed to delete folders",
    batchRestoreFailed: "Batch restore failed",
    batchDeleteFailed: "Batch delete failed",
    emptied: "Recycle bin emptied",
    emptyFailed: "Failed to empty trash",
    confirmDeleteTitle: "Delete permanently?",
    confirmDeleteBody:
      "This action cannot be undone. The file will be permanently removed from storage.",
    confirmDeleteAction: "Delete Forever",
    confirmEmptyTitle: "Empty Recycle Bin?",
    confirmEmptyBody: {
      one: "{count} item will be permanently deleted. This action cannot be undone.",
      other: "{count} items will be permanently deleted. This action cannot be undone.",
    },
    confirmEmptyAction: "Empty Forever",
  },

  files: {
    /** The name of the root of a viewer's own tree, used wherever it is shown. */
    myFiles: "My Files",
    breadcrumb: {
      pathLabel: "Folder path",
      overflow: {
        one: "Show {count} more folder in this path",
        other: "Show {count} more folders in this path",
      },
      overflowMenu: "Folders in this path",
    },
    versions: {
      title: "Versions",
      /** "v" is a version token, not a word: it stays outside the sentence. */
      versionLabel: "v{version}",
      current: "v{version} current",
      loading: "Loading version history…",
      loadFailed: "The version history could not be loaded.",
      none: "No previous versions. Versions appear when this file is replaced.",
      restoreConfirmTitle: "Restore version {version}?",
      restoreConfirmBody: "Current content will be kept as a new version.",
      restoreAction: "Restore",
      restoreLabel: "Restore version {version}",
      restoreFailed: "That version could not be restored.",
    },
    move: {
      title: { one: "Move {count} item", other: "Move {count} items" },
      description: "Open a folder to go deeper, then move into the folder you are viewing.",
      /** The destination name is interpolated, never bolded inside the clause. */
      alreadyIn: "Already in {folder}",
      into: "Into {folder}",
      confirm: "Move here",
      pathLabel: "Destination path",
      loading: "Loading folders…",
      loadFailed: "Could not load folders",
      noSubfolders: "No subfolders in “{folder}”",
      noSubfoldersBlocked:
        "The items are already here — go up a level to pick a different folder.",
      noSubfoldersHint:
        "This is as deep as it goes — use Move here to drop the items in this folder.",
      sourceTitle: "The items are already in this folder",
      sourceBadge: "Current",
    },
    bulkRename: {
      title: { one: "Bulk rename {count} file", other: "Bulk rename {count} files" },
      description: "Extensions are always preserved.",
      submitCount: { one: "Rename {count} file", other: "Rename {count} files" },
      find: "Find",
      findPlaceholder: "text to replace",
      replace: "Replace with",
      replacePlaceholder: "new text",
      prefix: "Prefix",
      prefixPlaceholder: "e.g. 2026_",
      startNumber: "Start number",
      startNumberHint: "Enable numbering to use this",
      numbering: "Append sequential numbers",
      /** `{token}` is the literal "{n}" marker, passed in so it can move freely. */
      numberingHint: "(or place {token} inside the prefix)",
      previewLabel: "Rename preview",
      previewSummary: "Preview · {changed} of {total} will change",
      /** The separating space stays in JSX, where it cannot be trimmed away. */
      previewSkipped: "· {count} skipped, name would be empty",
      srSkipped: "(skipped, name would be empty)",
      srUnchanged: "(unchanged)",
    },
    encrypt: {
      title: "Encrypt uploads",
      description:
        "End-to-end AES-256, encrypted in your browser before it leaves this device.",
      submit: "Enable encryption",
      passphrase: "Passphrase",
      passphrasePlaceholder: "At least 8 characters",
      tooShort: "Use at least 8 characters.",
      showPassphrase: "Show passphrase",
      hidePassphrase: "Hide passphrase",
      confirm: "Confirm passphrase",
      confirmPlaceholder: "Re-enter to confirm",
      mismatch: "Passphrases don’t match.",
      match: "Passphrases match",
      generate: "Generate strong",
      /** One sentence: the emphasis cannot survive a clause that reorders. */
      warning:
        "Your passphrase never leaves this device. We cannot recover it. If you lose it, the encrypted files are gone forever.",
      acknowledge: "I’ve saved my passphrase somewhere safe.",
    },
    /**
     * The other half of that story: the dialog that asks for the passphrase back
     * before an encrypted file can be downloaded. The words for the act itself —
     * `preview.passphrase`, `preview.showPassphrase`, `preview.hidePassphrase`,
     * `preview.decrypting` and `preview.unlockFailed` — are the preview's already,
     * and a failure with a code is rendered from `errors.code.*`.
     */
    decrypt: {
      title: "Encrypted download",
      /** The name sits inside the sentence, so each language places it itself. */
      description: "Enter the passphrase to decrypt and save {name}.",
      passphrasePlaceholder: "Your encryption passphrase",
      hint: "Processed in your browser — it is never sent to the server.",
      submit: "Decrypt and download",
      /** The reassurance a failure needs and an error message cannot carry. */
      untouched: "Nothing was written to disk — try the passphrase again.",
    },
    share: {
      title: "Create share link",
      readyTitle: "Share link ready",
      readyDescription: "Anyone with this link can open the file — no account needed.",
      create: "Create link",
      creating: "Creating…",
      createFailed: "Could not create the share link.",
      copyLink: "Copy link",
      linkLabel: "Share link",
      openInNewTab: "Open link in a new tab",
      another: "Create another link with different settings",
      permission: "Permission",
      viewOnlyNote: "This file type can only be shared for viewing.",
      expires: "Link expires",
      /** One chip per preset: no locale can shorten “24 hours” automatically. */
      preset: {
        min1: "1 min",
        min5: "5 min",
        min30: "30 min",
        hour1: "1 hour",
        hours24: "24 hours",
        days7: "7 days",
        never: "Never",
      },
      /** How a chosen lifetime reads back, in the section value and the badge. */
      duration: {
        never: "Never expires",
        minutes: { one: "{count} min", other: "{count} min" },
        hours: { one: "{count} hour", other: "{count} hours" },
        days: { one: "{count} day", other: "{count} days" },
      },
      limit: "Open limit",
      opens: { one: "{count} open", other: "{count} opens" },
      unlimitedOpens: "Unlimited opens",
      unlimited: "Unlimited",
      custom: "Custom",
      customLabel: "Custom open limit",
      customHint: "Leave empty for unlimited opens.",
      /**
       * One sentence with three interpolated values. The original lowercased the
       * lifetime and the limit at render, and `toLowerCase` is not a safe
       * transform for translated text — each language writes its own sentence.
       */
      summary: "Anyone with the link gets {access} access · {duration} · {limit}",
      accessEdit: "edit",
      accessReadOnly: "read-only",
    },
    tree: {
      paneLabel: "Folder tree",
      /** The pane heading and the tree's own name are the same word by design. */
      folders: "Folders",
      hide: "Hide folder tree",
      show: "Show folder tree",
      resize: "Resize folder tree",
      empty: "No folders here.",
      truncated: "Only the first folders are listed. Close a branch to see more.",
    },
    upload: {
      panelLabel: "Upload progress",
      /** Keyed by the queue's own status value, which never changes with language. */
      status: {
        queued: "Waiting",
        preparing: "Preparing",
        uploading: "Uploading",
        verifying: "Verifying",
        done: "Uploaded",
        error: "Failed",
        cancelled: "Canceled",
        resumeRequiresFile: "Needs the file again",
      },
      retryItem: "Retry {name}",
      removeItem: "Remove {name} from the queue",
      /** Shown when the queue reports a failure it has no code for. */
      failed: "The upload failed.",
      itemProgress: "Uploading {name}",
      overallProgress: "Overall upload progress",
      activeCount: { one: "Uploading {count} file", other: "Uploading {count} files" },
      finishedWithFailures: {
        one: "Finished · {count} failed",
        other: "Finished · {count} failed",
      },
      allFinished: "All uploads finished",
      waiting: "Waiting in queue",
      idleTitle: "Uploads",
      fileTally: "{completed}/{total} files",
      pause: "Pause uploads",
      resume: "Resume uploads",
      keepOpen: "Keep this panel open",
      letClose: "Let this panel close on its own",
      dismiss: "Dismiss upload panel",
      nothingUploading: "Nothing is uploading right now.",
      retryFailed: { one: "Retry {count} failed", other: "Retry {count} failed" },
      /**
       * Time remaining. “left” belongs inside the sentence: the callers used to
       * append it to an English helper that already said “remaining”.
       */
      etaAlmostDone: "Almost done",
      etaSeconds: "{count}s left",
      etaMinutes: "{minutes}m {seconds}s left",
      etaHours: "{hours}h {minutes}m left",
    },
    /**
     * The download rows the activity centre draws beside the upload ones, plus
     * the floating widget that keeps the transfer history of its own. Words that
     * already exist elsewhere are not repeated here: a row's state comes from
     * `activity.status.*`, the panel's heading from `activity.filter.downloads`,
     * the live dot from `activity.liveBadge`, and a failure from `errors.code.*`
     * — the store records a code, never prose.
     */
    download: {
      cancel: "Cancel the download of {name}",
      itemProgress: "Downloading {name}",
      preparing: "Preparing the download",
      /** The store's own toasts, raised from a transfer event rather than a render. */
      startedTitle: "Download started",
      doneTitle: "Download complete",
      /** The summary beside the panel heading, and the same text in the toggle's name. */
      activeSummary: { one: "{count} in progress", other: "{count} in progress" },
      recentSummary: { one: "{count} recent", other: "{count} recent" },
      toggle: "Downloads — {summary}",
      clearFinished: "Clear finished downloads",
      closePanel: "Close downloads panel",
      /**
       * What the progress bar says out loud. A bare "72" is not an answer, and a
       * streamed ZIP has no total to take a percentage of.
       */
      percentDone: "{count} percent",
      sizeUnknown: "Size unknown",
      /** Transfer rate. The number and its unit arrive already formatted. */
      speed: "{size}/s",
    },
    /**
     * The activity timeline, shared by the page and the activity centre.
     * `type` and `status` are reached through `activityTypeKey` /
     * `activityStatusKey`, so the store's own union values stay the lookup key.
     */
    activity: {
      kicker: "File Activity Center",
      title: "File Activity",
      intro: "Monitor uploads, downloads, and every change made to your files in real time.",
      liveBadge: "Live",
      period: "Period",
      dateLabel: "Filter activity by date",
      date: {
        any: "Any date",
        today: "Today",
        last7: "Last 7 days",
        last30: "Last 30 days",
      },
      clearHistory: "Clear history",
      confirmClearTitle: "Clear the activity history?",
      confirmClearBody:
        "Every event below is removed from the timeline. The files themselves are not touched.",
      searchLabel: "Search activity",
      searchPlaceholder: "Search files or activity details",
      typeLabel: "Filter by type",
      statusLabel: "Filter by status",
      sortLabel: "Sort the timeline",
      sortNewest: "Newest first",
      sortOldest: "Oldest first",
      filter: {
        all: "All",
        allStatuses: "All statuses",
        success: "Success",
        /**
         * The panel's own chip row. `Moved`, `Deleted` and `Failed` are not here:
         * those chips reuse `type.move`, `type.delete` and `status.failed`, which
         * already say the same thing. Only the three that have no equivalent
         * elsewhere are spelled out — and they are spelled out rather than
         * title-cased at render, because "Uploads" is a plural noun, not a
         * capitalised filter id.
         */
        active: "Active",
        uploads: "Uploads",
        downloads: "Downloads",
        groupLabel: "Filter activity",
      },
      /** The panel that drops in from the header, as opposed to the full page. */
      panel: {
        title: "Activity Center",
        close: "Close the Activity Center",
        searchPlaceholder: "Search activity…",
        clearSearch: "Clear the search",
        /**
         * Only "Earlier" is new. The other section headings are words this
         * namespace already owns — `status.uploading`, `status.downloading`,
         * `date.today` and `common.relative.yesterday` — and a second copy of
         * each would only be a second thing to keep in step.
         */
        earlier: "Earlier",
        /** Two reasons for an empty list, so the copy can say something true. */
        emptyFiltered: "Nothing matches that filter",
        emptyFilteredHint: "Try a different filter, or clear the search.",
        empty: "No activity",
        emptyHint: "Uploads, downloads, and file actions appear here.",
        historyCount: { one: "{count} item in history", other: "{count} items in history" },
        confirmClearBody:
          "Finished uploads, downloads, and file actions are removed from this list. The files themselves are not touched.",
        viewAll: "View all activity",
        removeItem: "Remove {name} from the history",
        /** The trigger in the header, whose name carries the badge's meaning. */
        triggerRunning: "Activity Center — {count} running",
        triggerFailed: "Activity Center — {count} failed",
      },
      /** The draggable window the desktop opens when popups are blocked. */
      window: {
        label: "File Activity Center floating window",
        minimize: "Minimize the activity window",
        restore: "Restore the activity window",
        maximize: "Maximize the activity window",
        close: "Close the activity window",
        overallProgress: "Overall progress",
        transferProgress: "Overall transfer progress",
        noTransfers: "No transfers are running right now.",
        failedCount: "{count} failed",
        processingCount: "{count} processing",
        synced: "Synced from the transfer engine",
      },
      eventCount: { one: "{count} event", other: "{count} events" },
      timeline: "Timeline",
      emptyTitle: "No matching activity",
      emptyHint: "Try another filter or search term.",
      /** Screen-reader only, so the sentence stop belongs to the language. */
      srStatus: "{status}.",
      /**
       * Same job for the panel's rows, which name the action rather than its
       * state: the visible text there is the event's own detail line, and the
       * icon that says "this was a rename" is decorative.
       */
      srType: "{type}.",
      transfers: {
        title: "Live transfers",
        subtitle: "Connected to the local transfer engine",
        fileCount: { one: "{count} file", other: "{count} files" },
        completedCount: "{count} completed",
        activeCount: "{count} active",
        queuedCount: "{count} queued",
      },
      type: {
        upload: "Upload",
        download: "Download",
        move: "Moved",
        copy: "Copied",
        rename: "Renamed",
        delete: "Deleted",
        restore: "Restored",
        createFolder: "Folder created",
        /** A type the stored history carries but this build no longer knows. */
        generic: "Activity",
      },
      status: {
        queued: "Queued",
        preparing: "Preparing",
        processing: "Processing",
        uploading: "Uploading",
        downloading: "Downloading",
        verifying: "Verifying",
        retrying: "Retrying",
        paused: "Paused",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
      },
    },
    /** The full-screen viewer. */
    preview: {
      /**
       * One whole sentence per lazy-loaded viewer rather than "Loading {kind}…":
       * the label used to be lowercased at render, and `toLowerCase` is not a
       * safe transform for translated text.
       */
      loading: {
        image: "Loading image…",
        video: "Loading video…",
        audio: "Loading audio…",
        pdf: "Loading PDF…",
        code: "Loading code…",
        table: "Loading table…",
        spreadsheet: "Loading spreadsheet…",
        document: "Loading document…",
        presentation: "Loading presentation…",
        svg: "Loading SVG…",
        archive: "Loading archive…",
        editor: "Loading editor…",
        trimmer: "Loading trimmer…",
      },
      /**
       * The badge on the header, reached through `previewKindKey`. Format names
       * (PDF, CSV, Excel) are read as themselves in all three languages.
       */
      kind: {
        image: "Image",
        video: "Video",
        audio: "Audio",
        pdf: "PDF",
        code: "Code",
        csv: "CSV",
        spreadsheet: "Excel",
        document: "Word",
        presentation: "PowerPoint",
        svg: "SVG",
        archive: "Archive",
        file: "File",
      },
      encryptedTitle: "This file is encrypted",
      encryptedBody:
        "Enter the passphrase you set when uploading it. Decryption happens in this browser — the passphrase is never sent anywhere.",
      passphrase: "Passphrase",
      showPassphrase: "Show passphrase",
      hidePassphrase: "Hide passphrase",
      decrypting: "Decrypting…",
      unlock: "Unlock",
      noMeta: "This file has no usable encryption metadata.",
      fetchFailed: "The encrypted file could not be fetched.",
      unlockFailed: "That passphrase did not unlock this file.",
      unsupportedTitle: "No preview for this file type",
      noteHint: "Open this note in the editor to read it.",
      /** `{kind}` is the badge word, so the clause order is each language's own. */
      unsupportedBody: "{kind} files cannot be shown inline. Download it to open it locally.",
      /** Screen-reader only: the lock icon beside the name says this visually. */
      srEncrypted: "Encrypted.",
      editImage: "Edit this image",
      trimClip: "Trim this clip",
      downloadFile: "Download file",
      share: "Share this file",
      details: "File details",
      hideDetails: "Hide file details",
      fullscreen: "Fill the screen",
      exitFullscreen: "Exit full screen",
      close: "Close preview",
      unsavedEditor: "This edit hasn't been saved. Leaving the editor discards it.",
      unsavedClose: "This file has unsaved changes. Closing the preview discards them.",
      keepEditing: "Keep editing",
      discardEdit: "Discard the edit",
      discardClose: "Discard and close",
      rowType: "Type",
      rowPreview: "Preview",
      rowSize: "Size",
      rowCreated: "Created",
      rowEncryption: "Encryption",
      shortcuts: {
        open: "Keyboard shortcuts",
        hide: "Hide keyboard shortcuts",
        heading: "Keyboard",
        /** The key names stay as printed on the keyboard. */
        close: "Close the preview",
        play: "Play or pause media",
        seek: "Seek media, or change PDF page",
        zoom: "Zoom an image",
        toggle: "Show or hide this list",
      },
    },
    /**
     * The individual viewers behind `preview`: what each one says when it cannot
     * read its file, and the controls it draws over one it can. Kept apart from
     * `preview` because that namespace is the frame — the header, the details
     * rail, the shortcut list — while this is the content inside it.
     *
     * Wording that already exists is reused rather than restated: a spinner's
     * sentence comes from `preview.loading.*`, a download from `common.download`,
     * a retry from `errorPages.tryAgain`, a cleared search from
     * `browser.clearSearch` and a paused player from `activity.status.paused`.
     */
    viewer: {
      /** Every viewer's headline for "the bytes arrived but could not be read". */
      unavailable: "Preview unavailable",
      /** And for "the file is readable and holds nothing". */
      nothingToShow: "Nothing to show",
      /**
       * Why a fetch for preview bytes failed, from `use-preview-source`. The hook
       * records WHICH case it hit and the sentence is chosen at render, so a
       * document that failed before the language changed still explains itself in
       * the language being read now.
       */
      load: {
        gone: "This file is no longer in storage.",
        forbidden: "You don’t have access to this file.",
        /** `{status}` is an HTTP status code, printed as itself. */
        http: "This file couldn’t be loaded (HTTP {status}).",
        generic: "This preview couldn’t be loaded.",
      },
      /** Rows and columns, counted once and read by both table viewers. */
      rows: { one: "{count} row", other: "{count} rows" },
      columns: { one: "{count} column", other: "{count} columns" },
      /** The badge admitting the table on screen stops short of the file's end. */
      truncatedRows: "First {count} rows",
      pdf: {
        openNewTab: "Open in a new tab",
        /** The `<iframe>`'s accessible name. */
        frameTitle: "PDF preview of {name}",
      },
      docx: {
        failed: "This document could not be read.",
        /**
         * `{reason}` is the sentence above; the advice follows it. One key rather
         * than two strings concatenated at render, so the join between them
         * belongs to each language.
         */
        hint: "{reason} Only .docx is supported — older .doc files need converting first.",
        converting: "Converting document…",
        empty: "This document has no text content — download it to open in Word.",
      },
      pptx: {
        failed: "This presentation could not be rendered in the browser.",
        rendering: "Rendering slides…",
      },
      csv: {
        failed: "This spreadsheet could not be loaded.",
        emptyTitle: "No rows to show",
        emptyHint: "Every row in this file is empty.",
        copy: "Copy table as tab-separated text",
        /** A header cell the file left blank. */
        columnN: "Column {n}",
        /** The table's summary for a screen reader; `{rows}` and `{columns}` arrive counted. */
        caption: "{name} — {rows}, {columns}",
      },
      sheet: {
        failed: "This spreadsheet format is not supported, or the file is damaged.",
        /** The sheet's name is the author's, so it is quoted rather than translated. */
        emptySheet: "The sheet “{name}” has no rows.",
        noSheets: "This workbook contains no readable sheets.",
        tabs: "Sheets",
        caption: "{name} — sheet {sheet}, {rows}, {columns}",
      },
      image: {
        failedTitle: "Image could not be displayed",
        failedHint: "The file may be corrupt, or its format is not supported by this browser.",
        zoomOut: "Zoom out",
        zoomIn: "Zoom in",
        /** The current magnification, spoken. */
        zoomLevel: "Zoom {count} percent",
        rotate: "Rotate 90 degrees",
        reset: "Reset view",
        openFullSize: "Open full size in a new tab",
        /** Pixel dimensions. `px` is a unit and stays as written. */
        dimensions: "{width} × {height} px",
        readingDimensions: "Reading dimensions…",
      },
      /** The audio and video players, which share every control but their headline. */
      media: {
        audioFailed: "Audio cannot be played",
        videoFailed: "Video cannot be played",
        codecHint:
          "This browser may not support the file’s codec. Downloading and playing it locally usually works.",
        playing: "Playing",
        play: "Play",
        pause: "Pause",
        seek: "Seek",
        /** Where the playhead is. Both timecodes arrive as digits. */
        position: "{current} of {total}",
        back10: "Back 10 seconds",
        forward10: "Forward 10 seconds",
        mute: "Mute",
        unmute: "Unmute",
        volume: "Volume",
      },
      text: {
        loading: "Loading file content…",
        failed: "This file’s contents could not be loaded.",
        lines: { one: "{count} line", other: "{count} lines" },
        /** Inside a badge beside the line count, so the English stays lowercase. */
        truncated: "truncated",
        edit: "Edit",
        editAria: "Edit {name}",
        closeEditor: "Close editor",
        saved: "Saved",
        unsaved: "Unsaved",
        enableWrap: "Enable word wrap",
        disableWrap: "Disable word wrap",
        copyContents: "Copy contents",
        /** The three clauses of the size notice, each said only when it applies. */
        sizeNotice: "This file is {size}.",
        showingFirst: "Showing the first {size}.",
        readOnlyOver: "Files over {size} are read-only here — download it to edit it locally.",
        unsavedChanges: "This file has unsaved changes.",
        discardChanges: "Discard changes",
        tooLarge:
          "This edit is {size} — larger than the {limit} that can be saved from the browser. Trim it, or download the file to edit it locally.",
        saveFailed: "The file couldn’t be saved.",
        saveFailedNetwork: "The file couldn’t be saved. Check your connection and try again.",
      },
      archive: {
        cannotList: "Archive cannot be listed",
        listFailed: "The archive listing could not be read.",
        emptyTitle: "This archive is empty",
        emptyHint: "There are no files or folders inside it.",
        search: "Search inside this archive",
        noMatch: "No entry matches that name.",
        matches: { one: "{count} matching file", other: "{count} matching files" },
        /** The footer's tally of what is inside. */
        fileCount: { one: "{count} file", other: "{count} files" },
        folderCount: { one: "{count} folder", other: "{count} folders" },
        uncompressed: "{size} uncompressed",
        onDisk: "{size} on disk",
        smaller: "{count}% smaller",
        previewEntry: "Preview {name}",
        noPreviewEntry: "{name} — no preview available",
        noPreviewHint: "This file type cannot be previewed inside the archive",
        back: "Back to archive contents",
        downloadEntry: "Download {name}",
        extracting: "Extracting entry…",
        entryFailed: "This entry could not be read out of the archive.",
        entryUnavailable: "Entry cannot be previewed",
        entryEmpty: "This entry is empty.",
      },
    },
    /**
     * The file-type badge, reached through `fileTypeKey`, keyed by the categories
     * `getMimeCategory` returns.
     *
     * Deliberately separate from `files.preview.kind.*`: that names the viewer a
     * file opens in (Excel, Word), this names the kind of thing it is (Sheet,
     * Slides). Where the two happen to read the same in English they still
     * translate independently, so `check:i18n` notes the overlap rather than
     * treating it as a redundant key.
     */
    type: {
      image: "Image",
      video: "Video",
      audio: "Audio",
      pdf: "PDF",
      document: "Document",
      spreadsheet: "Sheet",
      presentation: "Slides",
      archive: "Archive",
      text: "Text",
      file: "File",
    },
    /**
     * The listing itself — grid cards, list rows, the column header and the
     * per-file action menu. Shared by every surface that draws `FileGrid`:
     * My Files, a shared folder, favourites and the recycle bin.
     */
    list: {
      selectAll: "Select all files",
      deselectAll: "Deselect all files",
      colSize: "Size",
      colModified: "Modified",
      colType: "Type",
      /**
       * The sort button's accessible name. The state is spelled out in the label
       * because the row is a CSS grid, not a `<table>`, so there is no cell to
       * carry `aria-sort`. `{column}` is the already-translated column word: the
       * English used to lowercase it at render, which no translation survives.
       */
      sortedAscending: "{column} — sorted ascending. Activate to reverse.",
      sortedDescending: "{column} — sorted descending. Activate to reverse.",
      sortBy: "Sort by {column}",
      loadMore: "Load more",
      loadingMore: "Loading more…",
      /** Both the sr-only badge text and the menu item — one word, one key. */
      favorite: "Favorite",
      unfavorite: "Unfavorite",
      encrypted: "Encrypted",
      encryptedAes: "Encrypted with AES-256",
      selectFile: "Select {name}",
      openFile: "Open {name}",
      moreActions: "More actions",
      moreActionsFor: "More actions for {name}",
      actionsFor: "Actions for {name}",
      share: "Share",
      cut: "Cut",
      moveTo: "Move to…",
      duplicate: "Duplicate",
      trash: "Move to trash",
      deletePermanently: "Delete permanently",
      /**
       * Why the listing is empty, so the copy can say something true. A
       * zero-result search is not an empty folder, and uploading is not the way
       * out of one.
       */
      empty: {
        noFiles: "No files",
        noFilesHint:
          "Drop files anywhere on this page to upload, or use Upload in the toolbar.",
        readOnlyHint: "This folder is empty.",
        searchTitle: "No files match your search",
        searchHint: "Nothing found for “{query}”. Try fewer words, or clear the search.",
        filterTitle: "Nothing of this type here",
        filterHint: "Pick All to see everything in this folder again.",
        reset: "Clear search and filters",
      },
    },

    /**
     * The Favorites page header above the listing. The heading itself reuses
     * `nav.favorites`, so the sidebar entry and the page it opens can never drift.
     */
    favorites: {
      subtitle: "Your starred files and folders",
    },

    /**
     * The folder tiles above the listing. Rename and the two delete actions say
     * exactly what the file rows say, so they come from `common.rename` and
     * `files.list.*`; only the two folder-only actions live here.
     */
    folderCard: {
      actions: "Folder actions",
      download: "Download folder",
    },

    /**
     * Managing who else can open a folder. The role words come from
     * `common.viewOnly` / `common.canEdit`, which every permission surface shares.
     */
    folderShare: {
      /** The dialog's heading, and the item in the folder card's action menu. */
      title: "Share folder",
      username: "Username",
      usernamePlaceholder: "Who should get access?",
      access: "Access",
      send: "Send invitation",
      /**
       * Said by us rather than echoed from the route's English `message`: the
       * response's `updated` flag already says which of the two happened.
       */
      sent: "Invitation sent — they will get a notification.",
      resent: "Invitation updated — they will get a notification.",
      inviteFailed: "Invite failed",
      peopleWithAccess: "People with access",
      loadingMembers: "Loading members…",
      loadMembersFailed: "Failed to load members",
      emptyManage: "No other members. Invite someone by username above.",
      empty: "Nobody else has access to this folder.",
      /** The icon-only button's name, then the confirmation it opens. */
      removeMember: "Remove {user}",
      removeTitle: "Remove {user}?",
      removeBody: "They lose access to this folder and everything inside it.",
      removeFailed: "Remove failed",
      removed: "{user} no longer has access.",
    },

    /**
     * The listing shell around the grid: header identity, toolbar, type chips,
     * batch dock, and every message the browser raises on its own. One component
     * serves My Files, a folder, favorites and a shared folder, so its words are
     * shared across all four.
     */
    browser: {
      /** The heading when a shared folder's own name has not loaded yet. */
      sharedFolder: "Shared folder",
      loadingFolder: "Loading folder",
      fileCount: { one: "{count} file", other: "{count} files" },
      /** `{count}` is the total, and drives the plural; `{shown}` is the subset. */
      fileCountFiltered: {
        one: "{shown} of {count} file",
        other: "{shown} of {count} files",
      },
      folderCount: { one: "{count} folder", other: "{count} folders" },
      /**
       * The whole clause is emphasised, not just the query inside it: every
       * language puts the term where its own grammar wants it, so there is no
       * position to split the sentence at.
       */
      resultsFor: "results for “{query}”",
      /**
       * The two section headings above the listing, shown only when both kinds
       * are on screen at once. Separate from `files.tree.folders`, which names
       * the navigation pane rather than a group of cards inside the listing.
       */
      foldersSection: "Folders",
      filesSection: "Files",
      dropTitle: "Drop files or folders to upload",
      dropHint: "Files and folder structures will be preserved",
      searchPlaceholder: "Search files… (/)",
      clearSearch: "Clear search",
      upload: "Upload",
      newMenu: "New",
      newItem: "New item",
      createMenu: "Create",
      uploadFolder: "Upload folder",
      untitledFolder: "Untitled folder",
      /**
       * Translated even though it is stored: it is the name the user reads in
       * the listing a moment later, and they can rename it like any other note.
       */
      untitledNote: "Untitled Note",
      /**
       * `{timestamp}` is a sortable, filename-safe stamp built by the caller
       * rather than a locale-formatted date: this string is stored as a folder
       * name and later becomes a path inside a downloaded archive, where a
       * locale separator like `:` would not survive every filesystem.
       */
      uploadFallbackName: "Upload {timestamp}",
      encryptOn: "Encrypting uploads — click to turn off",
      encryptOff: "Encrypt uploads on this device",
      /**
       * The visible label once the mode is on. Deliberately not `common.on`: it
       * describes what will happen to the files, not the state of a switch.
       */
      encryptedLabel: "Encrypted",
      pasteMove: { one: "Paste {count} item (move)", other: "Paste {count} items (move)" },
      pasteCopy: { one: "Paste {count} item (copy)", other: "Paste {count} items (copy)" },
      pasteHere: "Paste here",
      thisFolder: "this folder",
      sort: "Sort",
      sortMenu: "Sort files",
      ascending: "Ascending",
      descending: "Descending",
      /** `{column}` is the already-translated sort column, `{direction}` below. */
      sortState: "Sort files. Current: {column}, {direction}",
      directionAscending: "ascending",
      directionDescending: "descending",
      /** The one sort label the column headers do not already own. */
      sortLastModified: "Last modified",
      gridView: "Grid view",
      gridViewHint: "Grid view (G)",
      listView: "List view",
      listViewHint: "List view (L)",
      filterLabel: "Filter by file type",
      /** Keyed by the filter's own id, which never changes with the language. */
      filter: {
        all: "All",
        images: "Images",
        videos: "Videos",
        audio: "Audio",
        documents: "Documents",
        archives: "Archives",
      },
      move: "Move",
      clearSelection: "Clear selection",
      clearSelectionHint: "Clear selection (Esc)",

      /** Why an action was refused, by what the viewer tried to do. */
      refuse: {
        purge: "Only the folder owner can restore or permanently delete these files.",
        flag: "Favorites and public share links can only be set by the file's owner.",
        viewOnly: "You have view-only access to this folder, so you can't change what's in it.",
        noPermission: "You don't have permission to change what's in this folder.",
      },

      confirm: {
        purgeTitle: "Delete permanently?",
        purgeBody: "“{name}” will be erased forever. This cannot be undone.",
        purgeAction: "Delete forever",
        deleteFolderTitle: "Delete folder?",
        deleteFolderBody: "“{name}” and everything inside it will be moved to the recycle bin.",
        deleteFolderAction: "Delete folder",
        purgeBatchTitle: {
          one: "Permanently delete {count} file?",
          other: "Permanently delete {count} files?",
        },
        purgeBatchBody: "This cannot be undone — the files are erased from storage.",
        trashBatchTitle: { one: "Delete {count} file?", other: "Delete {count} files?" },
        trashBatchBody: "They'll be moved to the recycle bin — you can restore them later.",
      },

      prompt: {
        renameFileTitle: "Rename file",
        fileName: "File name",
        newFolderTitle: "New folder",
        renameFolderTitle: "Rename folder",
        folderName: "Folder name",
        create: "Create",
      },

      notify: {
        uploadErrorsTitle: "Upload finished with errors",
        uploadErrorsBody: {
          one: "{count} file failed. Open Activity for details.",
          other: "{count} files failed. Open Activity for details.",
        },
        uploadDoneTitle: "Upload completed",
        uploadDoneBody: {
          one: "{count} file uploaded successfully.",
          other: "{count} files uploaded successfully.",
        },
        uploadFailedTitle: "Upload failed",
        transferFailed: "Transfer failed",
        /**
         * The name and the reason, in whichever order the language wants them.
         * Shared by the upload queue and the download store — the shape is the
         * same and a second copy would only drift.
         */
        transferFailedBody: "{name} — {reason}",
        readyToPaste: "{label} ready to paste",
        readyToMove: "{label} ready to move",
        pastedTitle: "Pasted",
        pastedBody: "into {destination}",
      },

      /**
       * Failures the browser reports itself. A failure that arrives from a route
       * with a code is rendered from `errors.code.*` instead; these are the ones
       * raised locally, where there is no code to key off.
       */
      error: {
        search: "Failed to search files",
        load: "Failed to load files",
        loadMore: "Failed to load more files",
        restore: "Failed to restore",
        purge: "Failed to delete permanently",
        delete: "Failed to delete",
        deleteBatch: "Delete failed",
        rename: "Failed to rename",
        renameBatch: {
          one: "{count} file could not be renamed",
          other: "{count} files could not be renamed",
        },
        copyBatch: {
          one: "{count} file could not be copied",
          other: "{count} files could not be copied",
        },
        favoriteBatch: "Favorite failed",
        createFolder: "Failed to create folder",
        createFolders: "Failed to create folders",
        createSubfolders: "Failed to create subfolders",
        folderTree: "Couldn't create the folders for this upload",
        unresolvedFolders: {
          one: "Couldn't create {count} folder — upload cancelled so nothing lands in the wrong place.",
          other:
            "Couldn't create {count} folders — upload cancelled so nothing lands in the wrong place.",
        },
        readFolder: "Failed to read folder",
        move: "Failed to move",
        moveFiles: "Failed to move files",
        moveFolder: "Failed to move folder",
        download: "Download failed",
        encryptedZip: {
          one: "{count} encrypted file can't go into a ZIP. Download it on its own so you can enter the passphrase.",
          other:
            "{count} encrypted files can't go into a ZIP. Download them one at a time so you can enter the passphrase.",
        },
      },
    },
    /**
     * The image editor and the trimmer: two panels that *propose* a change to a file
     * rather than making one, plus the refusals `src/features/files/domain/services/media-edit.ts` hands back.
     *
     * Those refusals arrive as keys rather than sentences — that module also runs in
     * the edit route and in the worker, and neither of those knows which language the
     * reader chose. The panel resolves the key at render, which also means a refusal
     * produced before a language switch reads in the language on screen afterwards.
     */
    edit: {
      /** Both panels offer it: put the draft back to what the file already is. */
      reset: "Reset",
      stillLoading: "Wait for the image to finish loading.",
      nothingToSave:
        "Nothing to save yet — rotate, flip, crop, resize, convert or compress first.",
      /** `{max}` is a pixel ceiling from `edit-limits`, so the number is the server's. */
      size: {
        whole: "Width and height must be whole numbers, at least 1 pixel each.",
        tooWide: "Keep both sides at or under {max} px.",
        tooManyPixels: "That comes to more than {max} megapixels — reduce the size.",
      },
      /** Why a trim window cannot be sent. `{seconds}` is the shortest clip allowed. */
      trim: {
        noWindow: "Set a start and an end point on the timeline.",
        tooShort: "Keep the clip at least {seconds} seconds long.",
        tooLong: "This clip is longer than the trimmer can handle.",
        startPastEnd: "The start point is past the end of the clip.",
        wholeClip: "That keeps the whole clip — move a handle to cut something.",
      },
      /** What each conversion target costs. The format names read as themselves. */
      format: {
        jpeg: "Smallest, lossy, no transparency.",
        png: "Lossless with transparency; larger files.",
        webp: "Smaller than JPEG at the same quality.",
        avif: "Smallest of the four; slowest to encode.",
      },
      /** The image panel: a stage with a crop overlay, and a rail of proposals. */
      image: {
        loadFailed:
          "This image couldn’t be loaded for editing. Close the editor and try the preview again.",
        rotateFlip: "Rotate & flip",
        left: "Left",
        right: "Right",
        mirror: "Mirror",
        flip: "Flip",
        crop: "Crop",
        /** The unlocked crop, the only aspect chip that is a word rather than a ratio. */
        aspectFree: "Free",
        clearCrop: "Clear",
        cropHint:
          "Drag inside the frame to move the crop, or a grip to resize it. With an aspect locked only the corners move.",
        /**
         * The whole crop rectangle read out, because a screen reader cannot see it.
         * Every number is a percentage of the frame.
         */
        cropRegion:
          "Crop region, {width}% wide and {height}% tall, {x}% from the left and {y}% from the top. Arrow keys move it, Alt with an arrow resizes it, Shift moves further.",
        resize: "Resize",
        /** Both the chip that turns a resize off and the label for "unchanged". */
        original: "Original",
        preset: "Longest edge {px} px",
        presetTooLarge: "Larger than the current crop",
        longestEdge: "Longest output edge in pixels",
        outputPixels: "{width} by {height} pixels",
        outputWaiting: "waiting for the image",
        format: "Format",
        /** The current format when the editor cannot name it — a TIFF, a HEIC. */
        formatOther: "Other",
        keepFormat: "Keep",
        alreadyFormat: "Already this format",
        /** `{note}` is one of `format.*`; `{extension}` includes its dot. */
        convertNote: "{note} The file is renamed to end in {extension}.",
        keptAsIs: "Kept as it is. Pick a format to re-encode the image into it.",
        compress: "Compress",
        recompress: "Re-compress the image",
        quality: "Encoder quality",
        qualityValue: "quality {value} of 100",
        qualityPng:
          "Quality {value}. PNG is lossless — compressing it quantises the image to a palette, which can shift colours.",
        qualityLossy: "Quality {value}. Lower means a smaller file and more visible artefacts.",
        source: "Source",
        output: "Output",
        writtenAs: "Written as",
        saveFailed: "The edit couldn't be saved.",
        sendFailed: "The edit couldn't be sent. Check your connection and try again.",
        savedTitle: "Image saved",
        savedBody: "{name} now measures {width} × {height}. The previous version was kept.",
        copyTitle: "Copy saved",
        copyBody: "{name} — the original is untouched.",
        /** Stands in for the copy's name when the server did not report one. */
        copyFallbackName: "A copy",
        saveAsCopy: "Save as copy",
        footnote:
          "Saving overwrites the file and keeps the previous bytes as a version. A copy leaves the original alone.",
      },
      /**
       * The trimmer. A request here means *queued* — the worker does the remux — so the
       * wording says queued rather than done, and never claims the file has changed yet.
       */
      clip: {
        loadFailed:
          "This file couldn’t be loaded for trimming. Close the editor and try the preview again.",
        waiting: "Waiting for the clip to load.",
        heading: "Trim",
        noContainer:
          "A trim copies the streams into the same kind of container, and this format has none to copy into. Convert it first, then trim the copy.",
        start: "Start",
        end: "End",
        setHere: "Set here",
        /** `{label}` is `start` or `end`; `{time}` is a timecode, not translated. */
        handleAt: "{label} at {time}",
        playSelection: "Play selection",
        clipLength: "Clip length",
        keeping: "Keeping",
        queueFailed: "The trim couldn't be queued.",
        sendFailed: "The trim couldn't be sent. Check your connection and try again.",
        queuedTitle: "Trim queued",
        queuedBody: "{name} is being cut to {length}. The previous version is kept.",
        running:
          "The cut is running in the background. Reopen the preview in a moment to see the result.",
        submit: "Trim",
        footnote:
          "The streams are copied rather than re-encoded, so the quality is untouched but each mark lands on the nearest keyframe at or before it — the result can be a fraction of a second wider than the handles. Shortest clip {seconds}s. The file is replaced and the previous version kept.",
        /** Extracting the soundtrack writes a new file and leaves this one alone. */
        audio: {
          heading: "Audio track",
          extract: "Extract audio",
          queued: "Audio queued",
          running: "Being extracted in the background. Refresh the folder in a moment to see it.",
          hint: "Saves the soundtrack as a new MP3 beside this video and leaves the video alone. A video with no audio track produces nothing.",
          failed: "The audio couldn't be extracted.",
          sendFailed: "The request couldn't be sent. Check your connection and try again.",
          queuedTitle: "Extracting audio",
          queuedBody: "The soundtrack of {name} lands as a new file in this folder.",
        },
      },
    },

    /**
     * The note editor, its formatting toolbar, its "/" block menu and the read-only
     * or editable view a share link opens.
     *
     * Nothing here autosaves, so the save state is wording rather than decoration:
     * the status line is the only account the author gets of whether their work
     * reached the server, and it is announced as well as drawn.
     */
    note: {
      placeholder: "Start writing… or type '/' for blocks",
      loadFailed: "Couldn’t load this note.",
      loadFailedNetwork: "Couldn’t load this note. Check your connection.",
      /** Follows whichever load failure happened: the note is never overwritten blind. */
      editingLocked: "Editing is locked so the original can’t be overwritten.",
      saveFailed: "Couldn’t save.",
      saveFailedNetwork: "Couldn’t save. Check your connection.",
      /** The dot beside the note's name — reinforcement, never the only signal. */
      unsavedChanges: "Unsaved changes",
      outline: "Outline",
      outlineToggle: "Toggle outline",
      outlineRegion: "Note outline",
      noHeadings: "No headings",
      /** Stands in for a heading with no text of its own in the outline. */
      untitledHeading: "Untitled",
      export: "Export",
      exportNote: "Export note",
      exportFormat: "Export format",
      /** The extension in each label is the file's, so it stays as written. */
      exportMarkdown: "Markdown (.md)",
      exportText: "Plain text (.txt)",
      exportPdf: "PDF (print)",
      closeTitle: "Close (Esc)",
      closeNote: "Close note",
      /** `{time}` is the local clock time the draft was written. */
      draftFound:
        "Unsaved local changes from {time} were found in this browser. Restore them?",
      restore: "Restore",
      discard: "Discard",
      /** The footer count. Two separate leaves so each language pluralises its own noun. */
      words: {
        one: "{count} word",
        other: "{count} words",
      },
      characters: {
        one: "{count} character",
        other: "{count} characters",
      },
      /** `{shortcut}` is ⌘S or Ctrl+S, picked from the platform rather than translated. */
      unsavedPress: "Unsaved · press {shortcut}",
      savedAt: "Saved at {time}",
      noChanges: "No changes",
      loadingNote: "Loading note…",
      /** Sits after a `/` key cap, the same shape as the command palette's hints. */
      blocksHint: "for blocks",
      confirmTitle: "You have unsaved changes",
      confirmBody:
        "This note is only stored once you save it. Your last edits are still kept in this browser as a draft, but they haven’t reached the server.",
      saveAndClose: "Save & close",
      discardChanges: "Discard changes",
      /** The Save control doubles as the save-state readout. */
      saved: "Saved",
      retrySave: "Retry save",
      locked: "Locked",
      lockedTitle: "This note is still loading, so it can’t be saved",
      saveShortcut: "Save ({shortcut})",
      /** The chip on a shared note, which says which of the two kinds of link this is. */
      editable: "Editable",
      readOnly: "Read-only",
      /**
       * The formatting bar. Every entry is both the `title` and the `aria-label` of
       * one control, so it has to read as a name rather than as an instruction. The
       * key combinations in brackets are the browser's own and stay as typed.
       */
      toolbar: {
        label: "Formatting",
        undo: "Undo (Ctrl+Z)",
        redo: "Redo (Ctrl+Y)",
        bold: "Bold (Ctrl+B)",
        italic: "Italic (Ctrl+I)",
        underline: "Underline (Ctrl+U)",
        strikethrough: "Strikethrough",
        inlineCode: "Inline code",
        link: "Link",
        removeLink: "Remove link",
        blockquote: "Blockquote",
        highlightGroup: "Highlight color",
        textGroup: "Text color",
        /** `{color}` is one of `color.*`; the swatch itself is the hex being written. */
        highlightSwatch: "Highlight {color}",
        textSwatch: "Text {color}",
        textSwatchLabel: "Text color {color}",
        resetTextColor: "Reset text color",
        addLink: "Add link",
        editLink: "Edit link",
        linkLabel: "URL",
        linkApply: "Apply",
        /** TipTap refuses `javascript:` and friends silently, which reads as a dead button. */
        linkRefused: "Link not added",
        linkRefusedBody: "That address uses a scheme this editor will not link to.",
        /** Colour names, lowercase because they sit inside "Highlight {color}". */
        color: {
          yellow: "yellow",
          green: "green",
          blue: "blue",
          pink: "pink",
          purple: "purple",
          red: "red",
          orange: "orange",
        },
      },
      /**
       * The "/" menu. One name and one line of description per block, shared with the
       * toolbar where the same block has a button. The invisible search aliases stay in
       * English in `slash-command.ts`: one spelling to remember, in any language.
       */
      block: {
        heading: "Blocks",
        noMatch: "No matching block",
        text: "Text",
        textDesc: "Plain paragraph",
        heading1: "Heading 1",
        heading1Desc: "Large section title",
        heading2: "Heading 2",
        heading2Desc: "Subsection title",
        heading3: "Heading 3",
        heading3Desc: "Smallest title",
        bulletList: "Bullet list",
        bulletListDesc: "Unordered list",
        numberedList: "Numbered list",
        numberedListDesc: "Ordered list",
        todoList: "To-do list",
        todoListDesc: "Task checklist",
        quote: "Quote",
        quoteDesc: "Quoted passage",
        codeBlock: "Code block",
        codeBlockDesc: "Preformatted code",
        divider: "Divider",
        dividerDesc: "Horizontal rule",
      },
    },

    /**
     * The paged PDF renderer. Kept for the canvas-based alternative to the iframe
     * viewer the app actually shows, and translated with everything else so wiring it
     * up is never a language regression.
     */
    pdf: {
      previousPage: "Previous page",
      nextPage: "Next page",
      /** `{total}` is a "?" until the document reports its length. */
      pageOf: "Page {page} of {total}",
      loadFailed: "Couldn’t load this PDF.",
    },
  },

  settings: {
    kicker: "Account settings",
    title: "Settings",
    intro:
      "Security, appearance and the devices signed in to this account. Choose a section to open it — the others stay out of the way.",
    navLabel: "Settings sections",
    group: {
      security: "Security",
      account: "Account",
      system: "System",
    },
    section: {
      password: {
        title: "Password",
        description: "Change the password you sign in with.",
      },
      stepCode: {
        title: "2-Step Code",
        description: "A numeric code asked for after your password.",
      },
      twoFactor: {
        title: "Two-factor app",
        description: "Authenticator codes and one-time recovery codes.",
      },
      profile: {
        title: "Profile",
        description: "Account details and how much storage you have used.",
      },
      appearance: {
        title: "Appearance",
        description: "Theme, language, and how much visual effect to load.",
      },
      devices: {
        title: "Devices",
        description: "Where this account is signed in, and how to sign it out.",
      },
      about: {
        title: "About",
      },
    },
    noEmail: "No email on file",
    /** Said of any account setting that has never been given a value. */
    notSet: "Not set",
    /**
     * Shared by the two security sections below, which both open by naming the
     * state they are about to let you change. The colon is part of the value so
     * each language keeps its own spacing and punctuation around it.
     */
    statusLabel: "Status:",
    /** Re-proving the account, asked for by both the 2FA and 2-Step Code forms. */
    accountPassword: "Account password",
    /**
     * The password form in Settings. Distinct from `auth.changePassword.*`: there
     * the current password is optional because an administrator forced the reset,
     * here it is the proof the account is yours — so the reveal toggles have to
     * name which of the three fields they belong to.
     */
    password: {
      current: "Current password",
      showCurrent: "Show current password",
      hideCurrent: "Hide current password",
      showNew: "Show new password",
      hideNew: "Hide new password",
      showConfirm: "Show confirm password",
      hideConfirm: "Hide confirm password",
      submit: "Change password",
      failed: "Failed to change password",
      /**
       * Said by this build rather than echoed from the API: the route already
       * decides between the two outcomes and the client knows which it got, so
       * the sentence can be translated instead of arriving as English prose.
       */
      updated: "Password updated. You can continue using the app.",
      updatedSignOut: "Password changed successfully. Please sign in again.",
    },
    twoFactor: {
      enabled: "Enabled",
      disabled: "Disabled",
      recoveryNotice: "Save these recovery codes now — they won't be shown again.",
      setUp: "Set up authenticator",
      setupHint:
        "Add this account in Google Authenticator / Authy using the secret below, then enter a code.",
      copySecret: "Copy secret",
      openLink: "Open otpauth link",
      codePlaceholder: "6-digit code",
      confirmEnable: "Confirm & enable",
      /** Both the heading of the section and the button that carries it out. */
      disable: "Disable 2FA",
      currentCode: "Current authenticator code",
      startFailed: "Failed to start setup",
      disableFailed: "Failed to disable",
    },
    /**
     * The 2-Step Code section. `2-Step Code` is a product name and stays English
     * in every locale; only the words around it move. The rule list reuses
     * `auth.setup.rule*` so this screen and the sign-in enrolment screen can never
     * state the policy differently.
     */
    stepCode: {
      active: "Active",
      digitCount: { one: "{count} digit", other: "{count} digits" },
      requiredByAdmin: "Required by admin",
      mustChange: "Must be changed",
      hint: "Entered on a numpad after your password, before your authenticator code.",
      lastChanged: "Last changed {date}",
      change: "Change 2-Step Code",
      set: "Set 2-Step Code",
      update: "Update code",
      save: "Set code",
      currentCode: "Current 2-Step Code",
      newCodePlaceholder: "New code ({min}–{max} digits)",
      confirmCode: "Confirm new code",
      showCode: "Show code",
      hideCode: "Hide code",
      removeTitle: "Remove your 2-Step Code?",
      removeNote: "Sign-in will drop back to password and authenticator only.",
      removeSubmit: "Remove code",
      loadFailed: "Failed to load status",
      saveFailed: "Failed to save code",
      removeFailed: "Failed to remove code",
      updated: "2-Step Code updated",
      saved: "2-Step Code set",
      removed: "2-Step Code removed",
    },
    /**
     * The devices list. Everything the browser knows about a session is data, not
     * prose — the device label, the IP and the city come back from the API and are
     * shown as they arrive; only the words around them live here.
     */
    devices: {
      protectionTitle: "Session protection",
      protectionNote:
        "Idle timeout, IP binding in production, encrypted cookies, and remote sign-out. New logins notify you by email.",
      activeDevices: "Active devices",
      sessionCount: { one: "{count} session", other: "{count} sessions" },
      otherCount: { one: "{count} other", other: "{count} other" },
      thisDevice: "This device",
      locationUnavailable: "Location unavailable",
      /** Both take an already-formatted age, so the sentence can reorder freely. */
      lastActive: "Active {when}",
      signedIn: "Signed in {when}",
      signOutThisDevice: "Sign out this device",
      revokeSession: "Revoke session",
      noSessions: "No active sessions",
      confirmOthersTitle: "Sign out other devices?",
      confirmOthersNote:
        "All other browsers and phones will be signed out immediately. This device stays signed in.",
      confirmAllTitle: "Sign out everywhere?",
      confirmAllNote: "You will be signed out on every device, including this one.",
      signOutOthers: "Sign out other devices",
      signOutAll: "Sign out all sessions",
      loadFailed: "Failed to load sessions",
      revokeFailed: "Could not revoke session",
      signedOutDevice: "Device signed out",
      othersSignedOutTitle: "Other devices signed out",
      othersSignedOutNote: "Only this browser remains signed in.",
      signOutOthersFailed: "Could not sign out other devices",
    },
    profile: {
      username: "Username",
      email: "Email",
      role: "Role",
      storage: "Storage",
      storageUsed: "Storage used",
      used: "{size} used",
      total: "{size} total",
      noQuota: "No quota set",
    },
    appearance: {
      theme: "Theme",
      light: "Light",
      dark: "Dark",
      system: "System",
    },
    lite: {
      title: "Lite mode",
      note: "Drops heavy visual effects and loads smaller thumbnails to keep things smooth on slower devices and connections.",
      auto: "Auto",
      autoHint: "Follow device & network",
      onHint: "Always lightweight",
      offHint: "Always full effects",
      currentlyOn: "Currently on for this device.",
      currentlyOff: "Currently off for this device.",
    },
    about: {
      appVersion: "App version",
      release: "Release",
    },
  },

  /**
   * Second Brain. Two conventions are load-bearing here:
   *
   * - No dots inside a leaf name. `resolve()` splits a key on ".", so the audit
   *   operation `memory.create` is keyed `operation.memoryCreate` and mapped from
   *   the wire value in `src/features/brain/domain/ui-constants.ts`.
   * - Memory types, entity types and project statuses are keyed for *display only*.
   *   The value sent to the API is always the raw enum, never the translation.
   */
  brain: {
    kicker: "Second Brain",
    nav: {
      label: "Second Brain sections",
      overview: "Overview",
      memories: "Memories",
      projects: "Projects",
      graph: "Graph",
      agents: "Agents",
      activity: "Activity",
      settings: "Settings",
      popOutHint: "Double-click to open the graph in its own window",
      popupBlocked: "Allow pop-ups for this site to open the graph window",
    },
    selector: {
      choose: "Choose a brain",
      archived: "archived",
      default: "default",
      current: "current",
      manage: "Manage brains",
    },
    by: {
      agent: "agent",
      you: "you",
      agentSuffix: "(agent)",
    },
    none: "none",
    memoryType: {
      fact: "Fact",
      preference: "Preference",
      decision: "Decision",
      instruction: "Instruction",
      project: "Project",
      person: "Person",
      concept: "Concept",
      experience: "Experience",
      procedure: "Procedure",
      event: "Event",
      observation: "Observation",
      conversation: "Conversation",
      knowledge: "Knowledge",
    },
    entityType: {
      person: "Person",
      project: "Project",
      organization: "Organization",
      technology: "Technology",
      location: "Location",
      concept: "Concept",
      product: "Product",
      agent: "Agent",
      document: "Document",
      other: "Other",
    },
    projectStatus: {
      active: "Active",
      paused: "Paused",
      done: "Done",
      archived: "Archived",
    },
    scope: {
      readLabel: "Read",
      readDesc: "Read memories, tags, entities and recall context",
      searchLabel: "Search",
      searchDesc: "Full-text search across memories",
      writeLabel: "Write",
      writeDesc: "Create and update memories, entities and relationships",
      linkLabel: "Link",
      linkDesc: "Connect memories to each other and to entities (backlinks)",
      deleteLabel: "Delete",
      deleteDesc: "Soft-delete memories and remove graph nodes",
      exportLabel: "Export",
      exportDesc: "Bulk-export the whole brain",
      importLabel: "Import",
      importDesc: "Bulk-import an .afrbrain archive into this brain",
      consolidateLabel: "Consolidate",
      consolidateDesc: "Merge duplicate memories and resolve flagged conflicts",
    },
    operation: {
      memoryCreate: "Created a memory",
      memoryUpdate: "Updated a memory",
      memoryDelete: "Deleted a memory",
      memoryRestore: "Restored a memory version",
      memorySearch: "Searched the brain",
      memoryRecall: "Recalled context",
      entityUpsert: "Recorded an entity",
      entityUpdate: "Updated an entity",
      entityDelete: "Deleted an entity",
      relationshipUpsert: "Linked two entities",
      relationshipDelete: "Removed a link",
      projectCreate: "Created a project",
      projectUpdate: "Updated a project",
      projectDelete: "Deleted a project",
      brainUpdate: "Changed brain settings",
      brainExport: "Exported the brain",
      agentCreate: "Connected an agent",
      agentRevoke: "Revoked an agent",
      agentScopes: "Changed agent permissions",
      agentAccessRevoke: "Removed an agent from this brain",
    },
    overview: {
      title: "Overview",
      description: "Your permanent memory. Agents come and go; what is stored here stays yours.",
      newMemory: "New memory",
      loadingBrains: "Loading brains",
      brainsFailed: "Could not load your brains.",
      brainFailed: "Could not load this brain.",
      memories: "Memories",
      memoriesHint: "live, not archived",
      archived: "Archived",
      archivedHint: "kept, out of the way",
      projects: "Projects",
      projectsHint: "threads of work",
      agents: "Agents",
      agentsHint: "with access to this brain",
      recentlyUpdated: "Recently updated",
      viewAll: "View all",
      emptyTitle: "This brain is empty",
      emptyBody: "Write your first memory, or connect an agent and let it remember for you.",
      writeMemory: "Write a memory",
      agentActivity: "Agent activity",
      fullLog: "Full log",
      noActivity: "No activity. Writes and agent reads appear here.",
      connectTitle: "Connect an agent",
      connectBody:
        "Give OpenClaw, Hermes, or any MCP client scoped access to this brain. Keys are shown once and can be revoked at any time.",
      manageAgents: "Manage agents",
    },
    memories: {
      title: "Memories",
      description: "Everything this brain knows. Search it, or write something worth keeping.",
      newMemory: "New memory",
      saveMemory: "Save memory",
      saved: "Memory saved",
      saveFailed: "Could not save memory",
      searchPlaceholder: "Search memories…",
      searchLabel: "Search memories",
      filterType: "Type",
      filterProject: "Project",
      filterTag: "Tag",
      allTypes: "All types",
      allProjects: "All projects",
      allTags: "All tags",
      archivedOnly: "Archived only",
      loading: "Loading memories",
      loadFailed: "Could not load memories.",
      truncated: "Showing the first {count}. Narrow the filters to find more.",
      emptyFilteredTitle: "Nothing matches those filters",
      emptyFilteredBody: "Try a different search term, or clear the filters.",
      emptyTitle: "No memories",
      emptyBody: "Write something this brain should remember permanently.",
      clearFilters: "Clear filters",
      writeMemory: "Write a memory",
    },
    memory: {
      fallbackTitle: "Memory",
      loading: "Loading memory",
      loadFailed: "This memory could not be loaded. It may have been deleted.",
      archived: "Memory archived",
      unarchived: "Memory restored",
      updateFailed: "Could not update memory",
      deleteTitle: "Delete this memory?",
      deleteBody:
        "It is soft-deleted and stops appearing everywhere, including for agents. Archiving keeps it searchable instead.",
      deleted: "Memory deleted",
      deleteFailed: "Could not delete memory",
      restoreTitle: "Restore version {version}?",
      restoreBody: "The current text is saved as a new version first, so nothing is lost either way.",
      restored: "Restored version {version}",
      restoreFailed: "Could not restore version",
      editTitle: "Edit memory",
      edit: "Edit",
      restore: "Restore",
      saveChanges: "Save changes",
      updated: "Memory updated",
      content: "Content",
      versionHistory: "Version history",
      noReason: "no reason given",
      noVersions: "No earlier versions. Every edit to the title, content or summary saves one.",
      details: "Details",
      detailType: "Type",
      detailScores: "Scores",
      detailProject: "Project",
      detailTags: "Tags",
      detailSource: "Source",
      detailVersion: "Version",
      detailCreated: "Created",
      detailUpdated: "Updated",
      lifecycle: "Lifecycle",
      lifecycleBody:
        "Archiving keeps a memory recoverable and out of recall. Deleting hides it from everything, including agents.",
      unarchive: "Unarchive",
      archive: "Archive",
    },
    card: {
      importanceShort: "imp",
      confidenceShort: "conf",
      /* The label is one of the two abbreviations above; percent is already localised. */
      scoreTitle: "{label}: {percent}%",
      scoreAria: "{label} {percent} percent",
    },
    form: {
      title: "Title",
      titlePlaceholder: "Production deployment requires Redis",
      content: "Content",
      contentPlaceholder: "What should be remembered, and why it matters.",
      type: "Type",
      project: "Project",
      noProject: "No project",
      summary: "Summary",
      optional: "(optional)",
      summaryPlaceholder: "One line an agent can read instead of the full content",
      importance: "Importance",
      importanceHint: "How aggressively should this be recalled?",
      confidence: "Confidence",
      confidenceHint: "How sure are we this is true?",
      tags: "Tags",
      tagsHint: "(comma separated)",
      tagsPlaceholder: "deployment, redis",
      reason: "Why are you changing this?",
      reasonHint: "(saved with the version)",
      reasonPlaceholder: "Corrected after checking the deploy script",
    },
    projects: {
      title: "Projects",
      description:
        "Group memories by the work they belong to. Agents can narrow recall to one project.",
      newProject: "New project",
      namePlaceholder: "Project name",
      nameLabel: "Project name",
      descriptionPlaceholder: "What is this project about? (optional)",
      descriptionLabel: "Project description",
      create: "Create",
      created: "Project created",
      createFailed: "Could not create project",
      loading: "Loading projects",
      loadFailed: "Could not load projects.",
      deleteTitle: 'Delete "{name}"?',
      deleteBody: {
        one: "Its {count} memory is kept — it stops belonging to a project.",
        other: "Its {count} memories are kept — they stop belonging to a project.",
      },
      deleteConfirm: "Delete project",
      deleted: "Project deleted",
      deleteFailed: "Could not delete project",
      updateFailed: "Could not update project",
      memoryCount: {
        one: "{count} memory",
        other: "{count} memories",
      },
      meta: "{memories} · updated {date}",
      openMemories: "Open memories",
      statusOf: "Status of {name}",
      deleteLabel: "Delete {name}",
      emptyTitle: "No projects",
      emptyBody:
        "A project groups the memories of one piece of work, so an agent can load that context.",
      createFirst: "Create a project",
    },
    activity: {
      title: "Activity",
      description: "Every write, and every agent read, against this brain. Append-only.",
      loading: "Loading activity",
      loadFailed: "Could not load the activity log.",
      emptyTitle: "No activity recorded",
      emptyBody:
        "Once you or an agent writes to this brain, it shows up here — append-only, newest first.",
    },
    settings: {
      title: "Settings",
      description: "Rename, archive, export, or add another brain.",
      loading: "Loading brain",
      updated: "Brain updated",
      updateFailed: "Could not update brain",
      archivedNotice: "Brain archived — it is now read-only",
      reactivated: "Brain reactivated",
      statusChangeFailed: "Could not change status",
      exported: "Brain exported",
      exportFailed: "Export failed",
      created: 'Created "{name}"',
      createFailed: "Could not create brain",
      thisBrain: "This brain",
      name: "Name",
      descriptionLabel: "Description",
      descriptionPlaceholder: "What is this brain for?",
      /* Lowercase on purpose: these render inside a chip beside "default". */
      statusActive: "active",
      statusArchived: "archived",
      /* Same chip row, same lowercase treatment. */
      defaultChip: "default",
      currentChip: "current",
      createdOn: "Created {date}",
      exportTitle: "Export",
      exportBody:
        "Downloads this brain as JSON: memories with their tags and provenance, projects, and the knowledge graph. No credentials are included.",
      exportNote: "Export only. Use this for backups; import is not available.",
      exportAction: "Export brain",
      statusTitle: "Status",
      statusActiveBody:
        "Archiving makes this brain read-only. Nothing is deleted, and agents can still recall from it.",
      statusArchivedBody:
        "This brain is archived and read-only. Reactivate it to allow writes again.",
      archiveAction: "Archive brain",
      reactivateAction: "Reactivate brain",
      yourBrains: "Your brains ({count})",
      switch: "Switch",
      newBrainPlaceholder: "New brain name",
      add: "Add",
    },
    embedding: {
      title: "Semantic Search (OpenRouter)",
      loading: "Loading provider settings…",
      loadFailed: "Could not load embedding settings",
      /* Shown as its own line under the failure above. */
      masterOnly:
        "This is a server-wide setting — a master account is required to view or change it.",
      cost:
        "Server-wide setting. Enabling this sends memory text and search queries to OpenRouter to be embedded ({dimensions}-d vectors). It adds a per-token cost; leave it off to keep retrieval lexical + graph only.",
      apiKey: "OpenRouter API key",
      apiKeyConfigured: "•••••••• (configured — leave blank to keep)",
      model: "Embedding model",
      enable: "Enable semantic retrieval",
      test: "Test",
      saved: "Embedding settings saved",
      saveFailed: "Could not save embedding settings",
      savedReembed:
        "Saved — model changed ({dimensions}-d). Cleared {cleared} old vectors; run brain:backfill-embed to re-embed.",
      testOk: "Model OK — {dimensions}-d vectors",
      testFailed: "Embedding test failed",
    },
    agents: {
      title: "Agents",
      description:
        "Give an external agent scoped access to this brain. The brain outlives the agent.",
      connectAction: "Connect agent",
      clipboardBlocked: "Clipboard blocked by the browser",
      syncTitle: "Refreshes every {seconds}s",
      syncFailed: "Sync failed",
      syncing: "Syncing",
      syncLive: "Live",
      lastUpdated: "last updated {age}",
      fleetStatus: "Fleet status",
      liveFleet: "Live fleet",
      fleetBody:
        "Presence is read from the audit trail — an agent counts as connected once it calls this brain. Last {count} events.",
      connected: "Connected",
      connectedHint: "called in the last 2 minutes",
      idle: "Idle",
      idleHint: "quiet for under 30 minutes",
      roster: "Agents",
      rosterHint: "with access to this brain",
      calls: "Agent calls",
      callsHint: "in the window shown below",
      fleetTicks: "Agent calls per hour over the last 24 hours. {count} calls in total.",
      axisStart: "24h ago",
      axisEnd: "now",
      keyFor: "Key for {name}",
      keyOnce:
        "This is the only time the key is shown. Only its hash is stored — if you lose it, mint a new agent.",
      copyKey: "Copy key",
      hide: "Hide",
      reveal: "Reveal",
      keySaved: "I have saved it",
      created: "Agent created — copy its key now",
      createFailed: "Could not create agent",
      revoked: "Access revoked",
      revokeFailed: "Could not revoke access",
      revokeEverywhereTitle: "Revoke {name} everywhere?",
      revokeEverywhereBody:
        "Its API key is deleted and every brain grant it holds is dropped. This cannot be undone.",
      revokeEverywhere: "Revoke everywhere",
      removeAccessTitle: "Remove {name} from this brain?",
      removeAccessBody:
        "It loses access to this brain. Its key keeps working for any other brain it was granted.",
      removeAccess: "Remove access",
      connectTitle: "Connect an agent",
      namePlaceholder: "Agent name (OpenClaw, Hermes, …)",
      nameLabel: "Agent name",
      permissions: "Permissions",
      riskyOff: "Delete and Export are off by default on purpose.",
      createAgent: "Create agent",
      loading: "Loading agents",
      loadFailed: "Could not load agents.",
      addedOn: "Added {date}",
      lastActivity: "{operation} · {date}",
      agentTicks: "{name}: {count} calls in the last two hours",
      callsWindow: {
        one: "{count} call · 2h",
        other: "{count} calls · 2h",
      },
      removeFromBrain: "Remove from brain",
      emptyTitle: "No agents connected",
      emptyBody:
        "Create an agent to give OpenClaw, Hermes, or any MCP client scoped access to this brain. Once it calls in, it appears here live.",
      mcpTitle: "MCP connection",
      mcpBody:
        "Point any MCP client at this endpoint with the agent key as a Bearer token. Stateless — no session id to manage.",
      endpoint: "Endpoint",
      copyUrl: "Copy URL",
      snippet: "Set-up snippet",
      snippetFormat: "Snippet format",
      clientConfig: "Client config",
      copyConfig: "Copy config",
      copyCommand: "Copy command",
      authentication: "Authentication",
    },
    presence: {
      live: "Connected",
      idle: "Idle",
      dormant: "Dormant",
      never: "Never connected",
      revoked: "Revoked",
      /* Compact age, shown beside the tier word. A bare unit suffix, no "ago". */
      ageSeconds: "{count}s",
      ageMinutes: "{count}m",
      ageHours: "{count}h",
      ageDays: "{count}d",
      /* Spoken form of the same age, for screen readers. */
      spokenSeconds: {
        one: "{count} second ago",
        other: "{count} seconds ago",
      },
      spokenMinutes: {
        one: "{count} minute ago",
        other: "{count} minutes ago",
      },
      spokenHours: {
        one: "{count} hour ago",
        other: "{count} hours ago",
      },
      spokenDays: {
        one: "{count} day ago",
        other: "{count} days ago",
      },
    },
    graph: {
      title: "Graph",
      description:
        "Every entity and memory in this brain as a force-directed graph. Drag to pan, scroll to zoom, drag a node to move it.",
      noBrainTitle: "No brain selected",
      noBrainBody: "Create or pick a brain to see its knowledge graph.",
      loading: "Loading graph",
      loadFailed: "Could not load the graph.",
      fullscreenRefused: "This browser refused fullscreen",
      noLink: "No link for this node",
      clipboardUnavailable: "Clipboard unavailable in this browser",
      linkCopied: "Link copied",
      copyFailed: "Could not copy the link",
      hideControls: "Hide controls",
      showControls: "Show controls",
      localBadge: "Local · {label} · {hops}",
      hops: {
        one: "{count} hop",
        other: "{count} hops",
      },
      emptyModel: "This brain has no entities or memories to graph.",
      emptyPickNode: "Pick a node to centre the local graph on, or switch back to Global.",
      emptyFilter: "No node matches the current filter.",
      localGraph: "Local graph",
      localOn: "Showing only what connects to the focused node.",
      localOff: "Showing the whole brain.",
      local: "Local",
      global: "Global",
      centreLabel: "Centre:",
      selectNode: "select a node",
      depth: "Depth",
      recentreHint: "Double-click or right-click a node to recentre.",
      filters: "Filters",
      clear: "Clear",
      filterNodes: "Filter nodes",
      /* The five query tokens are syntax, so they stay as typed in every language. */
      filterHint: "Prefix with type: kind: tag: project:, or - to exclude.",
      nodesHidden: {
        one: "{count} node hidden",
        other: "{count} nodes hidden",
      },
      restore: "Restore",
      relationships: "Relationships",
      tierLinks: "Links · {count}",
      tierSemantic: "Semantic · {count}",
      tierContext: "Context · {count}",
      tiersBody:
        "Links are relationships you stored. Semantic edges come from wording the two notes share; context edges from a shared tag, entity or project. Thicker and brighter means stronger. Switching a tier off hides its edges only — the notes stay, as orphans.",
      allTiersOff: "Every tier is off, so no edges are drawn.",
      showAll: "Show all",
      groups: "Groups",
      addGroup: "Add",
      noGroups: "No groups. Every node uses the neutral colour.",
      groupColour: "Colour for group {index}",
      groupQuery: "Query for group {index}",
      groupRemove: "Remove group {index}",
      groupsMax: "Maximum of {count} groups reached.",
      forces: "Forces",
      reset: "Reset",
      centerForce: "Center force",
      repelForce: "Repel force",
      linkForce: "Link force",
      linkDistance: "Link distance",
      /* Slider read-outs. The unit and the "×" stay put; only the number is localised. */
      pixels: "{value} px",
      multiplier: "{value}x",
      display: "Display",
      entities: "Entities",
      memories: "Memories",
      orphans: "Orphans",
      labels: "Labels",
      arrows: "Arrows",
      animate: "Animate",
      replay: "Replay",
      textFade: "Text fade threshold",
      fadeAlways: "always",
      fadeZoom: "zoom ≥ {value}x",
      nodeSize: "Node size",
      linkThickness: "Link thickness",
      visible: "Visible",
      visibleValue: "{nodes} nodes · {links} links",
      hiddenByFilters: "Hidden by filters",
      loaded: "Loaded",
      physics: "Physics",
      workerThread: "worker thread",
      mainThread: "main thread",
      truncated:
        "Snapshot truncated at the server limit — narrow the filter or lower the node limit to see a complete subgraph.",
      /* The canvas label doubles as the keyboard help, so it spells out every key. */
      canvasLabel:
        "Knowledge graph. Drag to pan, scroll or pinch to zoom, arrow keys to move, plus and minus to zoom, zero to fit. Double-click a node to centre the local graph on it; right-click or long-press for its actions.",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fit: "Fit graph to view",
      fullscreen: "Fullscreen",
      exitFullscreen: "Exit fullscreen",
      popOut: "Open graph in a separate window",
      actionsFor: "Actions for {label}",
      openMemory: "Open memory",
      refitLocal: "Refit local graph",
      localFromHere: "Local graph from here",
      centreOnNode: "Centre on node",
      copyLink: "Copy link",
      hideNode: "Hide node",
      selectedNode: "Selected node",
      closeDetail: "Close detail",
      detailProject: "Project",
      detailImportance: "Importance",
      detailConnections: "Connections",
      detailUpdated: "Updated",
      connectedHeading: "Connected",
      noConnections: "No visible connections.",
      neighbourTitle: "{tier} · strength {percent}%",
      moreNotListed: "+{count} more not listed",
      entityDegree: "Entity — {count} visible links",
      /*
       * How a derived edge is described in the connection list. A stored edge names
       * itself (its own link_type), so only these five signals are keyed.
       */
      relation: {
        explicit: "link",
        semantic: "wording",
        tag: "tag",
        entity: "entity",
        project: "project",
      },
      workspaceTitle: "Graph workspace",
      docTitle: "{name} · Graph",
      noBrainWorkspace:
        "No brain to graph. Open the graph from the app and use the pop-out button.",
      loadingWorkspace: "Loading graph…",
    },
    /*
     * Memory links. `verb` is display-only: the value posted to the API is always
     * the raw snake_case verb, and a custom verb the operator invents falls back to
     * its own text with the underscores spaced out.
     */
    links: {
      title: "Links",
      add: "Add link",
      loading: "Loading links",
      loadFailed: "Links could not be loaded.",
      removeAria: "Remove {type} link to {label}",
      removeTitle: "Remove the “{type}” link?",
      removeBody:
        "Only the connection goes away — both memories stay exactly as they are, and you can link them again at any time.",
      removeConfirm: "Remove link",
      removed: "Link removed",
      removeFailed: "Could not remove the link",
      relatedTo: "Related to",
      relatedToHint: "Connections this memory declares.",
      relatedToEmpty:
        "No links. Use Add link to connect a related memory or an entity from the graph.",
      referencedBy: "Referenced by",
      referencedByHint: "Memories that point at this one.",
      referencedByEmpty: "No other memory references this.",
      targetGroup: "What to link to",
      targetMemory: "Another memory",
      targetEntity: "An entity",
      findMemory: "Find a memory",
      findEntity: "Find an entity",
      searchMemories: "Search titles and content",
      searchEntities: "Search names",
      clearSelection: "Clear selection",
      searching: "Searching…",
      noMemoryMatch:
        "No other memory matches. Everything found is already linked, or try different words.",
      noEntityMatch: "No entity matches. Entities come from the knowledge graph.",
      linkType: "Link type",
      custom: "Custom…",
      customType: "Custom link type",
      customPlaceholder: "e.g., supersedes, mentions, implements",
      customInvalid: "Use lowercase letters, digits, _ or - (max 64).",
      linking: "Linking…",
      linkTo: "Link to “{label}”",
      linkToNothing: "Link to selected item",
      linked: "Linked to “{label}”",
      createFailed: "Could not create the link",
      verb: {
        relatesTo: "relates to",
        supersedes: "supersedes",
        supportedBy: "supported by",
        contradicts: "contradicts",
        dependsOn: "depends on",
        mentions: "mentions",
      },
    },
  },

  /**
   * The master console. Every screen behind /admin lives here: the tab rail, the
   * shared `.adm-*` primitives, the audit-event registry, and one sub-namespace
   * per page. Operator-facing, but an operator reads their own language too.
   */
  admin: {
    nav: {
      sections: "Admin sections",
      overview: "Overview",
      users: "Users",
      shares: "Shares",
      email: "Email",
      logs: "Logs",
      settings: "Settings",
    },
    /**
     * Defaults baked into the shared primitives, plus the toolbar vocabulary every
     * console screen repeats. Kept here rather than duplicated per page: three
     * screens all say "Clear selection", and they should say it identically.
     */
    ui: {
      live: "Live",
      searchPlaceholder: "Search…",
      clearSelection: "Clear selection",
      clearFilters: "Clear filters",
      matching: "Matching “{query}”",
    },
    /**
     * The audit registry's copy, keyed the same way the stored `action` column is.
     * `src/features/admin/domain/services/audit-actions.ts` holds the icon, the tone and the group; the two
     * readable strings live here so the log reads in the operator's language.
     */
    audit: {
      action: {
        login: "Login",
        logout: "Logout",
        sessionRevoked: "Session revoked",
        upload: "Upload",
        download: "Download",
        delete: "Delete",
        restore: "Restore",
        share: "Share",
        edit: "Edit",
        rename: "Rename",
        move: "Move",
        copy: "Copy",
        favorite: "Favorite",
        createFolder: "Create folder",
        deleteFolder: "Delete folder",
        createUser: "Create user",
        updateUser: "Update user",
        deleteUser: "Delete user",
        suspendUser: "Suspend user",
        impersonate: "Impersonate",
        accountLock: "Account lock",
        ipRateLimit: "IP rate limit",
        passwordChange: "Password change",
        /** Never rendered: `auditActionLabel` humanises the raw key instead. */
        unknown: "Activity",
      },
      description: {
        login: "User logged in",
        logout: "User logged out",
        sessionRevoked: "A session was revoked",
        upload: "File uploaded",
        download: "File downloaded",
        delete: "File deleted",
        restore: "File restored from trash",
        share: "File shared by link",
        edit: "File metadata edited",
        rename: "File renamed",
        move: "File moved",
        copy: "File copied",
        favorite: "File favorited",
        createFolder: "Folder created",
        deleteFolder: "Folder deleted",
        createUser: "New user created",
        updateUser: "User updated",
        deleteUser: "User deleted",
        suspendUser: "User suspended",
        impersonate: "Admin impersonated a user",
        accountLock: "Account locked after failed logins",
        ipRateLimit: "An IP hit the login rate limit",
        passwordChange: "Password was changed",
        /** An action this build no longer knows about, replayed from history. */
        unknown: "Recorded activity",
      },
      group: {
        session: "Sessions",
        security: "Security",
        files: "Files",
        folders: "Folders",
        users: "Users",
      },
    },
    /** One user's login layers, as a master sees them: read plus recover only. */
    security: {
      loadFailed: "Failed to load security status",
      unavailable: "Could not load security status.",
      actionFailed: "Action failed",
      layerPassword: "Password",
      layerAuthenticator: "Authenticator",
      locked: "Locked",
      mustChange: "Must change",
      notSet: "Not set",
      enabled: "Enabled",
      failedAttempts: "{count} failed",
      failedOfMax: "{count}/{max} failed",
      lockedUntil: "Locked until {time}",
      alsoSignOut: "Also sign this user out of all devices",
      unlock: "Unlock",
      requireChange: "Require change",
      clearCode: "Clear code",
      footnote:
        "Clearing removes the code so the user chooses a new one at next sign-in. Codes are hashed — no administrator can view or set one.",
    },
    /** Every public link in the system, and the bulk revoke over them. */
    shares: {
      kicker: "Shares",
      title: "Share links",
      lede: "Every public link across every account, newest first. Select the ones that should stop working and revoke them in one pass.",
      /** One reading of each status, shared by the filter, the tiles and the row chip. */
      statusAll: "All",
      statusActive: "Active",
      statusExpired: "Expired",
      metricLinks: "Links",
      metricLinksHint: "In this view",
      metricActiveHint: "Reachable right now",
      metricExpiredHint: "Already refusing access",
      opens: "Opens",
      metricOpensHint: "Total across all links",
      revokeTitle: {
        one: "Revoke {count} share link?",
        other: "Revoke {count} share links?",
      },
      revokeMessage:
        "Anyone holding these links will immediately lose access. This cannot be undone.",
      revokeConfirm: "Revoke links",
      revokeFailed: "Failed to revoke shares",
      revoked: {
        one: "{count} share link revoked",
        other: "{count} share links revoked",
      },
      revokeCount: "Revoke {count}",
      searchLabel: "Search shares",
      searchPlaceholder: "Owner, file name, or token…",
      statusFilterLabel: "Share status",
      panelTitle: { one: "{count} share", other: "{count} shares" },
      emptyTitle: "No share links",
      emptyBody:
        "When a user shares a file by link it appears here, along with how many times it has been opened.",
      noMatchTitle: "Nothing matches that filter",
      noMatchBody: "Try a different owner, file name, or token — or widen the status filter.",
      selectAll: "Select all shares",
      deselectAll: "Deselect all shares",
      selectOne: "Select share for {name}",
      colFile: "File",
      colOwner: "Owner",
      colStatus: "Status",
      colCreated: "Created",
      colLink: "Link",
      expires: "Expires {date}",
      linkCopied: "Link copied",
      copyLink: "Copy share link",
      openLink: "Open link",
      openLinkFor: "Open share link for {name} in a new tab",
    },
    /** The audit trail: the toolbar above it, and the sentence each row reads as. */
    logs: {
      kicker: "Audit trail",
      title: "Activity logs",
      lede: "Every privileged action, newest first. Pick an area, then narrow to a single kind of event — the raw payload is one click away on any row.",
      polling: "Polling 10s",
      pause: "Pause",
      auto: "Auto",
      export: "Export",
      metricEvents: "Events",
      metricEventsHintAll: "Latest 200",
      metricEventsHintArea: "In this area",
      metricActors: "Actors",
      metricActorsHint: "Distinct accounts",
      metricAddresses: "Addresses",
      metricAddressesHint: "Distinct IPs",
      metricKinds: "Event kinds",
      metricKindsHint: "Different actions seen",
      searchLabel: "Search logs",
      searchPlaceholder: "User, email, or IP…",
      areaLabel: "Log area",
      areaAll: "All",
      clearActionFilter: "Clear the action filter",
      panelTitle: { one: "{count} event", other: "{count} events" },
      filteredTo: "Filtered to {action}",
      allAreas: "All areas",
      emptyTitle: "No logs",
      emptyBody:
        "Sign-ins, uploads, shares and account changes all land here the moment they happen.",
      noneInAreaTitle: "Nothing in this area",
      noneInAreaBody:
        "Widen the area segment or clear the action chip to see the rest of the trail.",
      /** Column headings in the exported CSV — read in a spreadsheet, so translated. */
      csvTimestamp: "Timestamp",
      csvAction: "Action",
      csvUser: "User",
      csvEmail: "Email",
      csvRole: "Role",
      csvResource: "Resource",
      csvDetails: "Details",
      when: "When",
      account: "Account",
      resource: "Resource",
      meaning: "Meaning",
      /**
       * The connectives in a row's one-line summary. The values around them are
       * data — a file name, a MIME type, a role — and stay as the server sent them.
       */
      unknown: "Unknown",
      unknownType: "unknown type",
      via: "via",
      asRole: "as",
      inFolder: "in /{folder}",
      target: "Target:",
    },

    /**
     * The landing screen: eight headline numbers, four service tiles, two charts
     * and two feeds. Nothing here is editable, so almost every string is a label —
     * and a label is exactly what a reader needs in their own language.
     */
    overview: {
      title: "System overview",
      lede:
        "What the platform is doing right now — accounts, storage, traffic, and the services behind them. Every figure refreshes on its own every 15 seconds.",
      /** The poll interval is part of the promise, so it is in the badge. */
      live: "Live · 15s",

      /* Headline metrics. */
      files: "Files",
      storageUsed: "Storage used",
      storageUsedHint: "{percent}% of {total} allocated",
      shareLinks: "Share links",
      shareLinksHint: "Public links in circulation",
      logins: "Logins",
      uploads: "Uploads",
      downloads: "Downloads",
      sessions: "Sessions",
      sessionsHint: "Signed in right now",
      last7Days: "Last 7 days",
      /**
       * Hint fragments joined with " · " at the call site. Split rather than one
       * sentence because each half counts a different thing, and a language that
       * inflects the noun needs the number next to it.
       */
      hintActive: "{count} active",
      hintSuspended: "{count} suspended",
      hintNotes: { one: "{count} note", other: "{count} notes" },
      hintFolders: { one: "{count} folder", other: "{count} folders" },

      /* Storage pool. */
      poolTitle: "Storage pool",
      poolSub: "Bytes stored against the total quota handed out to accounts",
      figUsed: "Used",
      figFree: "Free",
      figUtilisation: "Utilisation",

      /* Upload growth chart. */
      growthTitle: "Upload growth",
      growthSub: "Files added per day over the last 30 days",
      growthEmptyTitle: "No uploads in the last 30 days",
      growthEmptyBody: "The curve draws itself as soon as files start arriving.",
      uploadCount: { one: "{count} upload", other: "{count} uploads" },

      /* Storage-by-type pie. */
      mixTitle: "Storage by type",
      mixSub: "Where the bytes actually sit",
      mixEmptyTitle: "No files",
      mixEmptyBody: "Uploads split the pool by file category here.",
      /**
       * The slice names. The stats endpoint labels each group in English; this is a
       * closed set of six, so the chart translates it on the way in rather than the
       * API changing shape. Plural because a slice is a group of files, not one.
       */
      category: {
        images: "Images",
        videos: "Videos",
        audio: "Audio",
        documents: "Documents",
        archives: "Archives",
        other: "Other",
      },

      /* Heaviest accounts. */
      topTitle: "Heaviest accounts",
      topSub: "Ranked by bytes stored, not by file count",
      allUsers: "All users",
      topEmptyTitle: "No accounts",
      topEmptyBody: "Accounts that store data rank here by bytes used.",

      /* Latest events. */
      eventsTitle: "Latest events",
      eventsSub: "The eight most recent entries in the audit log",
      fullLog: "Full log",
      eventsEmptyBody: "Sign-ins, uploads and administrative changes land here.",

      /* Activity breakdown. */
      breakdownTitle: "Activity breakdown",
      breakdownSub: "Every logged action type over the last 7 days",

      /* System health. */
      healthTitle: "System health",
      healthEnv: "Environment: {env}",
      healthOk: "All systems operational",
      healthDown: { one: "{count} service down", other: "{count} services down" },
      svcDatabase: "Database",
      svcCache: "Cache",
      svcCacheNote: "Jobs run in-process",
      svcWeb: "Web server",
      svcMemory: "Memory",
      svcConnected: "Connected",
      svcDisabled: "Disabled",
      svcDown: "Down",
      svcUp: "Up {duration}",
      /** The runtime's own name and version number, never translated. */
      svcNode: "Node {version}",
      svcHeap: "Heap {size}",
      /**
       * Uptime in the two coarsest units that still say something. The letters are
       * unit abbreviations, so a translator changes them only where the language
       * actually uses different ones.
       */
      uptimeDays: "{days}d {hours}h",
      uptimeHours: "{hours}h {minutes}m",
      uptimeMinutes: "{minutes}m",
    },

    /**
     * The account roster: eight tiles that double as filters, a create form, a bulk
     * bar, the table, and the edit sheet. Almost every action name is also an
     * accessible label somewhere, so the name carries `{name}` rather than being
     * assembled from a verb and a noun at the call site.
     */
    users: {
      kicker: "Accounts",
      title: "Users",
      lede:
        "Everyone with a login, online first. The tiles below are the filter — tap one to narrow the table, tap it again to clear it.",
      addUser: "Add user",

      /* The realtime channel's own state, distinct from the browser being offline. */
      linkOffline: "Realtime offline",
      linkConnecting: "Connecting…",
      linkReconnecting: "Reconnecting…",

      /* Filter tiles. */
      metricTotal: "Total",
      metricTotalHint: "{used} of {total} allocated",
      metricOnline: "Online now",
      metricOnlineHint: "Seen in the last 3 minutes",
      metricUnverifiedHint: "Waiting on an email code",
      metricSuspendedHint: "Blocked from signing in",

      /* Verification state, said once and read by the tile, the chip and the filter. */
      verifyActive: "Active",
      verifyUnverified: "Unverified",
      verifySuspended: "Suspended",

      /* Presence, from a live session down to one that never happened. */
      presenceLive: "Online",
      presenceIdle: "Recently here",
      presenceDormant: "Away",
      presenceNever: "Never signed in",
      deviceCount: { one: "{count} device", other: "{count} devices" },

      /* Sort order. */
      sortLabel: "Sort users",
      sortOnline: "Online first",
      sortRecent: "Newest",
      sortStorage: "Storage used",
      /** A–Z is an alphabet range, so a translator adjusts it to their own script. */
      sortName: "Name (A–Z)",

      /* Create form. */
      newTitle: "New account",
      usernamePlaceholder: "jane.doe",
      emailPlaceholder: "jane@example.com",
      newSub: "The user signs in immediately; no email is sent.",
      username: "Username",
      email: "Email",
      emailHint: "Optional — needed for password resets.",
      password: "Password",
      storageQuota: "Storage quota",
      gigabytes: "Gigabytes.",
      createUser: "Create user",
      createFailed: "Failed to create user",
      created: "User created successfully",

      /* Bulk bar. */
      activate: "Activate",
      suspend: "Suspend",
      bulkActivateTitle: { one: "Activate {count} user?", other: "Activate {count} users?" },
      bulkSuspendTitle: { one: "Suspend {count} user?", other: "Suspend {count} users?" },
      bulkDeleteTitle: { one: "Delete {count} user?", other: "Delete {count} users?" },
      bulkActivateMessage:
        "The selected users will be activated (and any pending accounts verified).",
      bulkSuspendMessage:
        "The selected users will be signed out and blocked from logging in until reactivated.",
      bulkDeleteMessage:
        "This permanently deletes the selected users and all their files. This cannot be undone.",
      bulkActivated: { one: "{count} user activated", other: "{count} users activated" },
      bulkSuspended: { one: "{count} user suspended", other: "{count} users suspended" },
      bulkDeleted: { one: "{count} user deleted", other: "{count} users deleted" },
      bulkPartial: "{done} succeeded, {failed} failed",
      /** Written into the audit trail, so it is authored in the operator's language. */
      bulkSuspendReason: "Bulk suspended by administrator",

      /* Search and panel. */
      searchLabel: "Search users",
      searchPlaceholder: "Username or email…",
      panelTitle: { one: "{count} user", other: "{count} users" },
      updatedAgo: "Updated {seconds}s ago",
      emptyTitle: "No accounts",
      emptyBody: "Accounts show here with quota, presence, and session count.",
      noMatchTitle: "Nothing matches that filter",
      noMatchBody: "Try a different name or email, or clear the tile filter above.",

      /* Table. */
      selectAll: "Select all users",
      deselectAll: "Deselect all users",
      selectOne: "Select {name}",
      masterExcluded: "Master accounts are excluded from bulk actions",
      colUser: "User",
      colStatus: "Status",
      colPresence: "Presence",
      colStorage: "Storage",
      mustReset: "Must reset password",
      joined: "Joined {date}",

      /* Row actions — every one of these is also its button's accessible name. */
      verifyAction: "Verify and activate {name}",
      resendAction: "Resend the verification code to {name}",
      openDetail: "Open {name}’s detail page",
      editAction: "Edit {name}",
      impersonateAction: "Sign in as {name}",
      suspendAction: "Suspend {name}",
      reactivateAction: "Reactivate {name}",
      deleteAction: "Delete {name}",

      /* Single-account confirmations. */
      suspendTitle: "Suspend {name}?",
      suspendMessage:
        "The user will be signed out and blocked from logging in until reactivated.",
      suspendConfirm: "Suspend user",
      reasonLabel: "Reason (shown to the user on login)",
      reasonPlaceholder: "Policy violation",
      defaultSuspendReason: "Suspended by administrator",
      deleteTitle: "Delete {name}?",
      deleteMessage:
        "This permanently deletes the user and all their files. This cannot be undone.",
      deleteConfirm: "Delete permanently",

      /* Outcomes. */
      userSuspended: "User suspended",
      userActivated: "User activated",
      statusFailed: "Failed to update status",
      deleted: "User deleted",
      deleteFailed: "Failed to delete user",
      verified: "{name} verified & activated",
      verifyFailed: "Failed to verify user",
      noEmail: "This user has no email on file",
      codeResent: "Verification code resent to {email}",
      resendFailed: "Failed to resend code",
      updated: "User updated successfully",
      updateFailed: "Failed to update user",
      impersonateFailed: "Failed to impersonate",

      /* Edit sheet. */
      closeEditor: "Close editor",
      noEmailOnFile: "no email on file",
      emailOptional: "Email (optional)",
      emailClearHint: "Clearing this removes the account’s only password-reset route.",
      newPassword: "New password",
      passwordKeep: "Leave blank to keep the current one",
      quotas: "Quotas",
      storageGB: "Storage (GB)",
      bandwidthGB: "Bandwidth / month (0 = unlimited)",
      forceReset: "Force password reset",
      forceResetHint: "The next sign-in stops at a change-password screen.",
      forceResetSwitch: "Force password reset on next login",
      loginSecurity: "Login security",
      saveChanges: "Save changes",
    },
    /**
     * One account, in full: quota, files, sessions and the edit form. Separate from
     * `admin.users` because it is a different screen with a different vocabulary —
     * this one talks about *this* person, not about the roster.
     */
    userDetail: {
      noEmail: "No email",
      /** Reads on the status pill; the role beside it stays the raw enum value. */
      statusActive: "Active",
      statusSuspended: "Suspended",
      cancelEdit: "Cancel edit",
      editUser: "Edit user",

      /* The three tiles across the top. The big number sits above each of these. */
      ofQuotaUsed: "of {total} used",
      statFiles: { one: "file", other: "files" },
      statFolders: { one: "{count} folder", other: "{count} folders" },
      statActivity: { one: "activity log", other: "activity logs" },

      /* Storage card. */
      storageTitle: "Storage usage",
      byFileType: "By file type",
      typeFiles: { one: "{count} file", other: "{count} files" },

      /* Files card. */
      filesTitle: "Files ({count})",
      moreFiles: { one: "+ {count} more file", other: "+ {count} more files" },

      /* Activity card. */
      activityTitle: "Recent activity",

      /* Sessions card. */
      sessionsTitle: "Active sessions ({count})",
      revokeAll: "Revoke all",
      revokeAllConfirm: "Sign out all devices for {name}?",
      revokeAllDone: "All sessions revoked",
      revokeOne: "Revoke session",
      revokeOneDone: "Session revoked",
      revokeFailed: "Failed",
      unknownDevice: "Unknown device",
      /** `IP` is the protocol name and stays as it is in every locale. */
      unknownIp: "Unknown IP",
      activeAgo: "Active {ago}",
      expires: "Expires {date}",
      noSessions: "No active sessions",

      /* Edit form. */
      editTitle: "Edit {name}",
      editOwnTitle: "Edit your account",
      username: "Username",
      email: "Email",
      emailOptional: "Email (optional)",
      quotaGB: "Storage quota (GB)",
      bandwidthGB: "Bandwidth (GB, 0 = unlimited)",
      password: "Password",
      passwordKeep: "Leave blank to keep current password",
      passwordShort: "Use at least 8 characters.",
      forceReset: "Force password reset on next login",
      updateFailed: "Failed to update user",

      twoFactorTitle: "Two-factor authentication",
    },
    settings: {
      kicker: "Configuration",
      title: "Settings",
      lede: "Stored in the database and picked up by the running app within about 30 seconds — no redeploy. Unsaved fields are marked, and nothing is written until you save.",
      usersChip: "{count} users",
      maintenanceChip: "Maintenance mode",
      unsavedChip: "{count} unsaved",
      allSavedChip: "All saved",
      searchLabel: "Search settings",
      searchPlaceholder: "Quota, session, cooldown…",
      clearSearch: "Clear the settings search",
      saveSuccess: "Settings saved — changes take effect within ~30 seconds",
      saveFailed: "Failed to save settings",
      loadFailed: "Settings could not be loaded",
      loadFailedBody: "The request came back empty. Reload the page — if it keeps happening the settings table may be unreachable.",
      retry: "Retry",
      noMatchTitle: "No setting matches that",
      noMatchBody: "Try a shorter word — the search looks at setting names, their descriptions and the section titles.",
      sectionUnsaved: "{title} — has unsaved changes",
      unsavedCount: { one: "{count} unsaved change", other: "{count} unsaved changes" },
      unsavedHint: "Nothing is written until you save",
      discard: "Discard",
      saveChanges: "Save changes",

      // Sections
      sectionGeneral: "General",
      sectionGeneralDesc: "Core platform settings and maintenance controls",
      sectionStorage: "Storage",
      sectionStorageDesc: "Quotas, upload ceilings and signed-URL lifetimes",
      sectionSecurity: "Security",
      sectionSecurityDesc: "Session lifetime, binding and the second factor",
      sectionLimits: "Access Limits",
      sectionLimitsDesc: "Request throttling and failed-login lockout",
      sectionSharing: "Sharing",
      sectionSharingDesc: "Public link policy and expiry ceilings",
      sectionFiles: "Files",
      sectionFilesDesc: "File policies, expiration and cleanup rules",
      sectionRetention: "Retention",
      sectionRetentionDesc: "Activity log retention",
      sectionEmail: "Email Delivery",
      sectionEmailDesc: "Smart Gmail sender router — limits, failover and cooldown",

      // General
      registrationLabel: "Allow Registration",
      registrationDesc: "Show public Sign up page and allow self-service accounts",
      allowedDomainsLabel: "Allowed Email Domains",
      allowedDomainsDesc: "Restrict sign-ups to these domains and their subdomains. Empty means any address is accepted. Existing accounts are never affected.",
      allowedDomainsPlaceholder: "example.com",
      maintenanceModeLabel: "Maintenance Mode",
      maintenanceModeDesc: "Block all user access except admins",
      maintenanceMessageLabel: "Maintenance Message",
      maintenanceMessageDesc: "Message shown to users during maintenance",
      maintenanceMessagePlaceholder: "System is under maintenance...",

      // Storage
      defaultQuotaLabel: "Default Quota",
      defaultQuotaDesc: "Storage quota for new users",
      maxUploadLabel: "Max Upload Size",
      maxUploadDesc: "Maximum file size per upload. This is the only ceiling — there is no env override.",
      warningThresholdLabel: "Warning Threshold",
      warningThresholdDesc: "Notify users when storage exceeds this percentage",
      defaultBandwidthLabel: "Default Bandwidth Quota",
      defaultBandwidthDesc: "Download allowance for new accounts on a rolling 30-day window. 0 means unmetered, which is what every account got before this was configurable.",
      uploadUrlLifetimeLabel: "Upload URL Lifetime",
      uploadUrlLifetimeDesc: "How long a signed upload URL stays valid. Long enough for a slow connection to finish a large part, short enough that a leaked URL goes stale.",
      downloadUrlLifetimeLabel: "Download URL Lifetime",
      downloadUrlLifetimeDesc: "How long a signed download URL stays valid. Anyone holding the URL can fetch the file until it expires, so keep it short.",

      // Security
      sessionDurationLabel: "Session Duration",
      sessionDurationDesc: "How long a session stays valid before the user must sign in again",
      sessionDurationPresets: "Presets",
      sessionDurationCustom: "Custom",
      sessionDurationMode: "Session duration input mode",
      sessionDurationHours: "Session duration in hours",
      sessionDurationReadout: "Users are signed out {duration} after signing in, however active they have been.",
      idleTimeoutLabel: "Idle Timeout",
      idleTimeoutDesc: "Sign a user out after this long with no activity. 0 disables it, which is the default — whichever of this and Session Duration is shorter is the one that ends the session.",
      ipBindingLabel: "IP Binding",
      ipBindingDesc: "Revoke a session when the client IP changes. Stops a stolen cookie being replayed elsewhere, but signs out anyone on a shifting mobile or VPN address.",
      ipBindingAuto: "Auto (production only)",
      ipBindingOn: "Always on",
      ipBindingOff: "Always off",
      maxSessionsLabel: "Max Sessions",
      maxSessionsDesc: "Concurrent sessions per user — the oldest is signed out when exceeded",
      stepCodeRequiredLabel: "Require 2-Step Code",
      stepCodeRequiredDesc: "Every user must set a numpad code entered after their password. Users without one are prompted to create it at next sign-in and cannot remove it.",

      // Limits
      rateLimitLabel: "Rate Limit",
      rateLimitDesc: "API requests per minute per user. Upload endpoints get 5× this value.",
      loginAttemptsLabel: "Failed Logins per Account",
      loginAttemptsDesc: "Wrong passwords before the account itself is locked for the window below. The floor is 3: a lower value locks an account on the first typo, which turns the lockout into a denial-of-service anyone can trigger with a username.",
      loginIpAttemptsLabel: "Failed Logins per IP",
      loginIpAttemptsDesc: "Failed attempts from one IP address before it is throttled. Keep this well above the per-account number so a shared office address is not locked out by one forgetful person.",
      lockoutWindowLabel: "Lockout Window",
      lockoutWindowDesc: "How long a locked account or throttled IP has to wait. This is also the window the failed attempts are counted over, and the number quoted to the user in the message they see.",

      // Sharing
      publicSharingLabel: "Allow Public Links",
      publicSharingDesc: "Let owners mint links that anyone with the URL can open. Turning this off stops new links being created; links that already exist keep working.",
      defaultExpiryLabel: "Default Link Expiry",
      defaultExpiryDesc: "Expiry applied when the person sharing does not pick one. 0 means such a link never expires.",
      maxExpiryLabel: "Maximum Link Expiry",
      maxExpiryDesc: "Longest expiry anyone may ask for — a longer request is capped to this. 0 removes the ceiling entirely.",

      // Files
      maxLifetimeLabel: "Max File Lifetime",
      maxLifetimeDesc: "Auto-delete files after this many days (0 = unlimited)",
      autoDeleteTrashLabel: "Auto Delete Trash",
      autoDeleteTrashDesc: "Automatically empty trash after this many days",
      blockedExtensionsLabel: "Blocked Extensions",
      blockedExtensionsDesc: "File extensions blocked from upload",
      blockedExtensionsPlaceholder: ".exe",
      allowedMimeLabel: "Allowed MIME Types",
      allowedMimeDesc: "Restrict by MIME type (*/* for all)",
      allowedMimePlaceholder: "image/*",

      // Retention
      logRetentionLabel: "Log Retention",
      logRetentionDesc: "How long to keep activity logs",

      // Email
      emailDailyLimitLabel: "Daily Limit per Sender",
      emailDailyLimitDesc: "Default max emails a Gmail sender may send per day before the router rotates to another. Gmail's own cap is ~500/day.",
      emailFailureThresholdLabel: "Failure Threshold",
      emailFailureThresholdDesc: "Consecutive send failures before a sender is rested (put on cooldown)",
      emailCooldownLabel: "Cooldown Duration",
      emailCooldownDesc: "How long a sender rests after hitting the failure threshold, then it's retried automatically",

      // Tags input
      tagRemove: "Remove {tag}",
      tagAdd: "Add {placeholder}…",
      tagAddGeneric: "Add value…",
      tagAddButton: "Add",

      // Session duration formatting
      durationMinutes: { one: "{count} minute", other: "{count} minutes" },
      durationHours: { one: "{count} hour", other: "{count} hours" },
      durationDays: { one: "{count} day", other: "{count} days" },
      durationWeeks: { one: "{count} week", other: "{count} weeks" },
      durationMonths: { one: "{count} month", other: "{count} months" },

      // Session duration presets
      preset30min: "30 min",
      preset1hour: "1 hour",
      preset4hours: "4 hours",
      preset8hours: "8 hours",
      preset8hoursSub: "work day",
      preset1day: "1 day",
      preset3days: "3 days",
      preset1week: "1 week",
      preset1weekSub: "default",
      preset2weeks: "2 weeks",
      preset1month: "1 month",
      preset3months: "3 months",
      preset1year: "1 year",

      // Session duration notes
      sessionNoteNoIdle: "Sessions expire {duration} after sign-in. No idle timeout is active — a session stays alive even while the user is away, until that duration runs out or they sign out. Set Idle Timeout below to also end quiet sessions early.",
      sessionNoteIdleWins: "Idle Timeout is set to {idle}. That is shorter than the {duration} session duration, so in practice inactive users are signed out after {idle} and the duration above only caps sessions that stay busy. Set the idle timeout to 0 to let Session Duration decide on its own.",
      sessionNoteIdleLoses: "Idle Timeout is set to {idle}. That is longer than the {duration} session duration, so the duration is always reached first and the idle timeout never gets a chance to fire.",

      // IP binding note
      ipBindingNoteProd: "This deployment is running in production, so auto currently means IP binding is on.",
      ipBindingNoteDev: "This deployment is running in development, so auto currently means IP binding is off.",

      // Share expiry note
      shareNoteNeverExpires: "New links never expire unless the person sharing picks an expiry, and they may pick any length. Set a maximum to put a ceiling on that.",
      shareNoteWithMax: "A link created without a chosen expiry lasts {effective}",
      shareNoteCapped: " — the maximum, because the default is longer than it or unset",
      shareNoteMaxCeiling: "Nobody can ask for more than {max}.",
      shareNoteNoCeiling: "There is no ceiling, so a link can still be created with any expiry.",

      // Cleanup status
      cleanupNone: "No cleanup has run. The first sweep happens within 20 minutes of server start.",
      cleanupLast: "Last cleanup {ago} via {source}.",
      cleanupSourceWorker: "the background worker",
      cleanupSourceApp: "the app scheduler",
      cleanupStats: "{trash} trash files · {folders} folders · {expired} expired · {logs} logs",
      cleanupError: "Last run failed: {error}",

      // Units
      unitGB: "GB",
      unitMB: "MB",
      unitPercent: "%",
      unitMinutes: "minutes",
      unitSeconds: "seconds",
      unitHours: "hours",
      unitSessions: "sessions",
      unitReqMin: "req/min",
      unitAttempts: "attempts",
      unitDays: "days",
      unitEmailsDay: "emails/day",
      unitFailures: "failures",
    },
    email: {
      kicker: "Email gateway", title: "Outbound mail", lede: "Gmail senders that deliver one-time codes and security notices. The router picks whichever verified sender still has headroom today.", polling: "Polling every 10s",
      addSender: "Add sender", readyNow: "Ready now", configured: "of {count} configured", checking: "Checking…", verified: "Verified", accepted: "Gmail accepted the login", resting: "Resting", cooldownHint: "In cooldown after failures", sentToday: "Sent today", noActive: "No active sender",
      senders: "Senders ({count})", senderOrder: "Ordered by priority — the router walks this list top-down.", emptyTitle: "No sender configured", emptyBody: "Without a verified Gmail sender the app cannot deliver one-time codes, so sign-in and 2FA fail. Add one to bring the gateway up.",
      removeTitle: "Remove {name}?", removeLast: "This is the last verified sender. Removing it will stop OTP and security emails from going out until another one is added.", removeBody: "Its stored app password is deleted with it. Mail already sent is unaffected.", remove: "Remove sender",
      addFailed: "Failed to add sender", gmailRejected: "Gmail rejected the login", verifyFailed: "Verification failed", statusVerified: "Verified", statusFailed: "Login failed", statusUnverified: "Not verified", inactive: "Inactive", sendsAs: "sends as “{name}”", dailyUsage: "Daily usage", cooling: "Resting ~{count}m", limitReached: "Daily limit reached", recentFailures: { one: "{count} recent failure", other: "{count} recent failures" }, lastUsed: "last used {date}", retest: "Re-test this sender", test: "Test", removeNamed: "Remove {name}",
      gatewayStatus: "Gateway status", gatewayHealthy: "Gateway healthy", gatewayAttention: "Gateway needs attention", healthyBody: "At least one verified sender has headroom, so outbound mail is going out.", attentionBody: "Mail may be delayed or failing. The reasons are listed below.", eligible: "{count} eligible", gatewaySummary: "{active} active · {verified} verified · daily cap {limit} per sender by default.", problemNone: "No Gmail sender configured yet. Add one to start sending OTP and notifications.", problemUnverified: "No sender is verified. Check each sender's App Password (16 chars, 2-Step Verification enabled) and re-run Test.", problemUnavailable: "Every verified sender is on cooldown or at its daily limit right now. Add another sender or raise the daily limit.",
      addTitle: "Add a Gmail sender", addSubtitle: "Saved only if Gmail accepts the login.", close: "Close", displayName: "Display name", displayHint: "How this sender is labelled in the console.", displayPlaceholder: "e.g. Main sender", gmailAddress: "Gmail address", appPassword: "App password", appPasswordHint: "Stored encrypted. It is never shown again after saving.", appPasswordPlaceholder: "16-character app password", showPassword: "Show app password", hidePassword: "Hide app password", fromName: "From name", fromHint: "What recipients see in their inbox.", appPasswordHelp: "Getting an app password: turn on 2-Step Verification for the Google account, then open Google Account → Security → App passwords, create one for “Mail”, and paste the 16-character code above.", cancel: "Cancel", verifySave: "Verify & save",
      activityTitle: "Recent email activity", activitySub: "Live tail from this server process — last 100 events, cleared on restart.", refresh: "Refresh", noEvents: "No email events. Sends, verifications, and OTP events show here.", activityLabel: "Recent email activity",
    },
    // ADMIN-NEXT
  },

  onboarding: {
    title: "Set up your workspace",
    body: "Four short steps make storage, sharing, security, and your Second Brain ready for daily use.",
    doneTitle: "Your workspace is ready",
    doneBody: "You have visited every core area. You can dismiss this guide whenever you are comfortable.",
    dismiss: "Dismiss onboarding guide",
    progress: "{count} of {total} steps completed",
    completed: "Completed",
    filesTitle: "Add your first files",
    filesBody: "Create a folder and upload something you can find again.",
    shareTitle: "Review sharing",
    shareBody: "See active links and understand who can open them.",
    securityTitle: "Secure your account",
    securityBody: "Review sessions, password, 2-Step Code, and authenticator settings.",
    brainTitle: "Meet Second Brain",
    brainBody: "Create a brain and save a useful memory with provenance.",
  },

  errors: {
    network: "Check your connection and try again.",
    unexpected: "Something went wrong. Try again.",
    requestFailed: "The request couldn't be sent. Check your connection and try again.",
    /** The request never reached the route — raised by the client, not by it. */
    connectionFailed: "Connection failed",
    required: "This field is required.",
    /**
     * Keyed by the stable code on ApiResult, never by the message text.
     * Text copied verbatim from the route so behaviour is unchanged for `en`.
     * A code absent here falls through to the server's raw English string.
     */
    code: {
      "2FA_EXPIRED": "Session expired. Please sign in again.",
      "2FA_INVALID": "Invalid authentication code",
      ACTIVITY_SCOPE_NOT_FOUND: "Activity scope not found",
      ALREADY_VERIFIED: "This account is already verified. Please sign in with your password.",
      ARCHIVE_BUILD_FAILED: "The archive couldn't be built",
      ARCHIVE_DOWNLOAD_FAILED: "Archive download failed",
      ARCHIVE_ENTRY_TOO_LARGE: "A file inside this archive is too large to open on the server",
      ARCHIVE_FAILED: "The archive couldn't be started",
      ARCHIVE_STATUS_FAILED: "Couldn't check on the archive",
      ARCHIVE_TIMEOUT: "The archive is taking too long — check back in a little while",
      ARCHIVE_TOO_LARGE:
        "This archive is too large to open on the server — download it and open it on your computer",
      ARCHIVE_URL_NOT_READY: "The archive URL isn't ready yet",
      BRAIN_ACCESS_NOT_FOUND: "This agent has no access to this brain",
      BRAIN_ENTITY_NOT_FOUND: "Entity not found",
      BRAIN_PROJECT_NOT_FOUND: "Project not found",
      BRAIN_RELATIONSHIP_NOT_FOUND: "Relationship not found",
      DOWNLOAD_ENC_META_MISSING:
        "This file is encrypted but its encryption metadata is missing",
      DOWNLOAD_FETCH_ENCRYPTED_FAILED: "Couldn't fetch the encrypted file",
      DOWNLOAD_SAVE_FAILED: "Couldn't save the file",
      DOWNLOAD_START_FAILED: "Failed to start download",
      EDIT_ANIMATED_REFUSED:
        "Animated images can't be edited here — only the first frame would survive.",
      EDIT_FAILED: "This image can't be read",
      EDIT_NOTE_REFUSED: "Notes are edited in the note editor",
      EDIT_SOURCE_TOO_LARGE: "This file is too large to edit on the server",
      EDIT_TEXT_TOO_LARGE: "This file is too large to edit in the browser",
      EDIT_VERSION_CONFLICT: "This file changed since you opened it. Reload it before saving.",
      EXTRACT_AUDIO_ENCRYPTED_REFUSED: "Encrypted files can't be processed on the server",
      EXTRACT_AUDIO_MIME_REFUSED: "Only video files have an audio track to pull out",
      EXTRACT_AUDIO_QUEUE_UNAVAILABLE:
        "Extracting audio is temporarily unavailable. Try again in a few minutes.",
      EXTRACT_AUDIO_SOURCE_TOO_LARGE: "This video is too large to extract audio from",
      INVALID_ID: "Malformed identifier",
      MEMORY_LINK_NOT_FOUND: "Link not found",
      MEMORY_NOT_FOUND: "Memory not found",
      /** Raised by the drag planner, which reports a code for the same reason. */
      MOVE_BLOCKED_TRASH: "Restore this first — items in the recycle bin can't be moved.",
      /** Raised by the upload queue, not by a route, but the registry is the same. */
      RESUME_REQUIRES_FILE: "Pick this file again to carry on where it stopped.",
      /**
       * The public share page and the note it may let you edit. A dead link is
       * the whole page for its recipient, so the reason has to be readable in
       * their language rather than arriving as the route's English prose.
       */
      SHARE_EDIT_RATE_LIMITED: "Too many edits in a row. Slow down and try again.",
      SHARE_EXPIRED: "This share link has expired.",
      SHARE_FILE_MISSING: "The shared file is no longer available.",
      SHARE_LIMIT_REACHED: "This share link has reached its view limit.",
      SHARE_NOT_A_NOTE: "Only notes can be edited through a share link.",
      SHARE_NOTE_CONTENT_MISSING: "There was nothing to save.",
      SHARE_NOT_FOUND: "This share link doesn’t exist.",
      SHARE_RATE_LIMITED: "Too many requests. Slow down and try again.",
      SHARE_VIEW_ONLY: "This share is view-only.",
      STEP_CODE_ALREADY_SET: "A 2-Step Code is already set for this account",
      STEP_CODE_EXPIRED: "Session expired. Please sign in again.",
      STEP_CODE_MISMATCH: "Codes do not match",
      STEP_CODE_NOT_SET: "No 2-Step Code is set for this account",
      STEP_CODE_REQUIRED:
        "A 2-Step Code is required by your administrator and cannot be removed.",
      TRIM_CONTAINER_UNSUPPORTED: "This format can't be trimmed without re-encoding it first.",
      TRIM_ENCRYPTED_REFUSED: "Encrypted files can't be trimmed on the server",
      TRIM_MIME_REFUSED: "Only video or audio files can be trimmed",
      TRIM_QUEUE_UNAVAILABLE: "Trimming is temporarily unavailable. Try again in a few minutes.",
      ZIP_DOWNLOAD_FAILED: "ZIP download failed",
      ZIP_FAILED: "The ZIP couldn't be built",
    },
  },
};
