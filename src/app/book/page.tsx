import type { Metadata } from "next";
import { Suspense } from "react";
import BookingFlow from "@/components/book/BookingFlow";

export const metadata: Metadata = { title: "Book a repair" };

export default function BookPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-[13px] text-ink-3">Loading booking…</div>}>
      <BookingFlow />
    </Suspense>
  );
}
