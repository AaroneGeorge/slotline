import type { Metadata } from "next";
import { Suspense } from "react";
import EvidencePack from "@/components/evidence/EvidencePack";

export const metadata: Metadata = { title: "Evidence pack" };

export default function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-[13px] text-ink-3">Assembling evidence…</div>}>
      <EvidencePack params={params} />
    </Suspense>
  );
}
