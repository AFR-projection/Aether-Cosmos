import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AccessDeniedPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="text-center max-w-md">
        <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/20">
          <Lock className="h-10 w-10 text-red-500" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
        <p className="text-muted-foreground mb-1 text-sm">
          You don&apos;t have permission to access this resource.
        </p>
        <p className="text-muted-foreground/60 mb-6 text-xs">Error: 403 Forbidden</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button asChild variant="secondary">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground/50">
          Need access? Contact an administrator.
        </p>
      </div>
    </div>
  );
}
