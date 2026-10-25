import type { Metadata } from "next";
import LiveCamera from "@/components/live-camera";

export const metadata: Metadata = {
  title: "Live venue camera — Crowdy",
  description: "Connect your iPhone camera to your Crowdy workspace for live crowd estimates.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function LiveCameraPage() {
  return <LiveCamera />;
}
