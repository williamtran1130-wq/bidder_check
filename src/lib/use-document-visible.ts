"use client";
import { useSyncExternalStore } from "react";

function subscribe(changed: () => void) {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
}
const snapshot = () => document.visibilityState === "visible";
const serverSnapshot = () => true;

export function useDocumentVisible() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
