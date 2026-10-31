"use client";
import { useEffect } from "react";
import { retirePushWorker } from "@/lib/retire-push-worker";

export function RetirePushWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => retirePushWorker(registrations, window.location.origin))
      .catch(() => {});
  }, []);
  return null;
}
