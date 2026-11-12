import { Suspense } from "react";
import Dashboard from "@/components/dashboard/Dashboard";

export default function OperatorDashboardPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading Dana&apos;s day…</div>}>
      <Dashboard />
    </Suspense>
  );
}
