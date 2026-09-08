export interface Invitation {
  id: string;
  folderId: string;
  folderName: string;
  role: "view" | "edit";
  invitedByUsername: string;
  createdAt: string;
}

export interface SharedEntry {
  memberId: string;
  role: "view" | "edit";
  sharedAt: string;
  folderId: string;
  folderName: string;
  folderCreatedAt: string;
  ownerId: string;
  ownerUsername: string;
}

export interface ShareEntry {
  share: {
    id: string;
    token: string;
    permission: string;
    expiresAt: string | null;
    createdAt: string;
    accessCount: number;
    maxAccessCount: number | null;
    lastAccessedAt: string | null;
  };
  file: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  };
}

export interface AccessLogLocation {
  city: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  isp: string;
  org: string;
  timezone: string;
  asn: string;
  zip: string;
}

export interface AccessLog {
  id: string;
  ip: string;
  createdAt: string;
  metadata: {
    token?: string;
    fileName?: string;
    accessCount?: number;
    maxAccessCount?: number;
    userAgent?: string;
    device?: string;
    browser?: string;
    os?: string;
    location?: AccessLogLocation | null;
  } | null;
}
